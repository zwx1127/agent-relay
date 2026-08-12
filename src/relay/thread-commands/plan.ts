import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { Logger } from "../../domain/logger.ts";
import { parseSessionKey, sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentRelayPlanDecisionState, AgentRelayPlanDecisionStateEvent, AgentSessionStatus, AgentTaskInput } from "../../ports/agent.ts";
import type { EditMessageTextOptions, ImAdapter, InlineKeyboardMarkup, SendMessageOptions } from "../../ports/im.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { RenderCallbackPageResult } from "../controller-types.ts";
import type { TaskSubmitPreference } from "../task-coordinator.ts";
import type { PendingPrompt, WorkspaceRecord } from "../types.ts";
import { shortToken } from "../ui/callback-data.ts";
import { CODEX_PROMPT_TTL_MS } from "../ui/constants.ts";
import { planReadyKeyboard } from "../ui/keyboards.ts";
import { messageWithTitle, textMessage } from "../ui/text-parts.ts";
import type { CallbackMessage } from "./types.ts";

export interface PlanCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "deleteMessage">;
  logger: Logger;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord): Promise<AgentSessionStatus>;
  sessionBusy(status: AgentSessionStatus): boolean;
  hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean;
  submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference?: TaskSubmitPreference, input?: AgentTaskInput): Promise<void>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

interface PlanCardState {
  sessionKey: string;
  decision: AgentRelayPlanDecisionState;
  gatewayEpoch?: string;
  messageId?: MessageId;
  token?: string;
  flushPromise?: Promise<void>;
}

export class PlanCommandService {
  private readonly interruptedTurns = new Set<string>();
  private readonly cards = new Map<string, PlanCardState>();

  constructor(private readonly deps: PlanCommandDeps) {}

  async run(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (this.deps.sessionBusy(status) || this.deps.store.countTasks(conversationId, workspace.name, ["waiting", "queued", "running", "blocked"]) > 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
      return;
    }
    const key = sessionKey(conversationId, workspace.name);
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || normalizedPrompt === "--on" || normalizedPrompt === "--off") {
      const update = normalizedPrompt === "--on"
        ? { operation: "set" as const, mode: "plan" as const }
        : normalizedPrompt === "--off"
          ? { operation: "set" as const, mode: "default" as const }
          : { operation: "toggle" as const };
      const nextMode = await this.syncMode(key, update);
      await this.deps.sendRendered(conversationId, messageWithTitle(nextMode === "plan" ? "Plan mode enabled." : "Plan mode disabled."));
      return;
    }
    await this.syncMode(key, { operation: "set", mode: "plan" });
    await this.deps.submitTask(conversationId, normalizedPrompt, userMessageId, "immediate");
  }

  markInterruptedTurn(sessionKeyValue: string, turnId: string): void {
    this.interruptedTurns.add(`${sessionKeyValue}:${turnId}`);
  }

  clearSession(sessionKeyValue: string): void {
    const prefix = `${sessionKeyValue}:`;
    for (const key of this.interruptedTurns) {
      if (key.startsWith(prefix)) this.interruptedTurns.delete(key);
    }
    for (const key of this.cards.keys()) {
      if (key.startsWith(`${sessionKeyValue}\0`)) this.cards.delete(key);
    }
  }

  async handleCallback(message: CallbackMessage, pending: PendingPrompt, data: Record<string, unknown>, action: string | undefined): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    if (pending.sessionKey && pending.sessionKey !== key) {
      this.deps.logger.info("router.plan_callback_expired", { conversation_id: message.conversationId, session_key: pending.sessionKey, reason: "session_mismatch" });
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Plan action expired.", "Open the latest Plan ready card."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    if (action === "implement" || action === "continue") {
      const status = this.deps.agent.getStatus(key);
      if (!status?.running) {
        this.deps.logger.info("router.plan_callback_expired", { conversation_id: message.conversationId, session_key: key, reason: "session_not_running" });
        await this.deps.renderStrictCallbackPage(message, messageWithTitle("Plan action expired.", "The Codex session is no longer running."), { inline_keyboard: [] });
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        return;
      }
      const promptThreadId = typeof data.threadId === "string" ? data.threadId : undefined;
      if (this.deps.store.getCollaborationMode(key) !== "plan" || (promptThreadId && promptThreadId !== status.threadId)) {
        this.deps.logger.info("router.plan_callback_expired", {
          conversation_id: message.conversationId,
          session_key: key,
          reason: "thread_mismatch",
          prompt_thread_id: promptThreadId,
          current_thread_id: status.threadId,
        });
        await this.deps.renderStrictCallbackPage(message, messageWithTitle("Plan action expired.", "Open the latest Plan ready card."), { inline_keyboard: [] });
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        return;
      }
      if (action === "implement" && (this.deps.sessionBusy(status) || this.deps.hasTaskCreatedAfter(message.conversationId, workspace.name, pending.createdAt))) {
        this.deps.logger.info("router.plan_callback_busy", {
          conversation_id: message.conversationId,
          session_key: key,
          active_turn_id: status.activeTurnId,
          waiting_for_approval: status.waitingForApproval,
          waiting_for_user_input: status.waitingForUserInput,
        });
        await this.deps.renderStrictCallbackPage(message, messageWithTitle("Plan action expired.", "A newer turn is already active or has been submitted."), { inline_keyboard: [] });
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        return;
      }
      const planTurnId = typeof data.completedTurnId === "string" ? data.completedTurnId : undefined;
      if (planTurnId && this.deps.agent.claimPlanDecision) {
        const claim = await this.deps.agent.claimPlanDecision(key, planTurnId, action);
        await this.applyDecisionState(key, claim.state);
        if (!claim.claimed) {
          await this.deps.renderStrictCallbackPage(message, planDecisionMessage(claim.state), { inline_keyboard: [] });
          this.deps.store.deletePendingPrompt(pending.scopeKey ?? pending.conversationId, pending.promptMessageId);
          return;
        }
      }
      await this.deps.renderStrictCallbackPage(
        message,
        messageWithTitle(action === "implement" ? "Implementing plan." : "Continuing in Plan mode."),
        { inline_keyboard: [] },
      );
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      if (action === "continue") return;
      try {
        await this.syncMode(key, { operation: "set", mode: "default" });
        this.deps.logger.info("router.plan_callback_implemented", { conversation_id: message.conversationId, session_key: key });
        await this.deps.submitTask(message.conversationId, "Implement the approved plan.", message.messageId, "immediate");
      } catch (error) {
        if (planTurnId && this.deps.agent.failPlanDecision) {
          const failed = await this.deps.agent.failPlanDecision(key, planTurnId).catch(() => undefined);
          if (failed) await this.applyDecisionState(key, failed);
        }
        throw error;
      }
      return;
    }
    await this.dismissReadyPrompt(message);
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
  }

  private async syncMode(key: string, update: { operation: "set" | "toggle"; mode?: "default" | "plan" }): Promise<"default" | "plan"> {
    const current = this.deps.agent.getStatus(key)?.collaborationMode ?? this.deps.store.getCollaborationMode(key);
    const mode = this.deps.agent.syncThreadCollaborationMode
      ? await this.deps.agent.syncThreadCollaborationMode(key, current, update)
      : update.operation === "toggle"
        ? current === "plan" ? "default" : "plan"
        : update.mode ?? current;
    this.deps.store.setCollaborationMode(key, mode);
    return mode;
  }

  async sendReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    if (completedTurnId && this.interruptedTurns.delete(`${sessionKeyValue}:${completedTurnId}`)) return;
    const threadId = this.deps.agent.getStatus(sessionKeyValue)?.threadId ?? this.deps.store.getSession(sessionKeyValue)?.thread_id ?? undefined;
    if (!threadId) return;
    const planTurnId = completedTurnId ?? `local:${Date.now()}`;
    const decision = this.deps.agent.registerPlanDecision
      ? await this.deps.agent.registerPlanDecision(sessionKeyValue, planTurnId)
      : localReadyDecision(threadId, planTurnId);
    await this.applyDecisionState(sessionKeyValue, decision);
  }

  async handleDecisionState(event: AgentRelayPlanDecisionStateEvent): Promise<void> {
    const status = this.deps.agent.getStatus(event.sessionKey);
    if (status?.threadId !== event.threadId) return;
    await this.applyDecisionState(event.sessionKey, event, event.gatewayEpoch);
  }

  async handleDecisionSnapshot(
    sessionKeyValue: string,
    gatewayEpoch: string,
    decisions: AgentRelayPlanDecisionState[],
  ): Promise<void> {
    const status = this.deps.agent.getStatus(sessionKeyValue);
    const active = new Set<string>();
    for (const decision of decisions) {
      if (status?.threadId !== decision.threadId) continue;
      active.add(`${sessionKeyValue}\0${decision.threadId}\0${decision.planTurnId}`);
      await this.applyDecisionState(sessionKeyValue, decision, gatewayEpoch);
    }
    const now = Date.now();
    for (const [key, state] of [...this.cards]) {
      if (!key.startsWith(`${sessionKeyValue}\0`) || active.has(key) || isPlanDecisionTerminal(state.decision.phase)) continue;
      await this.applyDecisionState(sessionKeyValue, {
        ...state.decision,
        phase: "expired",
        revision: state.decision.revision + 1,
        updatedAt: now,
      }, gatewayEpoch);
    }
  }

  private async applyDecisionState(sessionKeyValue: string, decision: AgentRelayPlanDecisionState, gatewayEpoch?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const key = `${sessionKeyValue}\0${decision.threadId}\0${decision.planTurnId}`;
    const state = this.cards.get(key) ?? { sessionKey: sessionKeyValue, decision };
    if (state.gatewayEpoch && gatewayEpoch && state.gatewayEpoch !== gatewayEpoch) {
      if (state.flushPromise) await state.flushPromise.catch(() => undefined);
      if (state.messageId !== undefined) {
        this.deps.store.deletePendingPrompt(parsed.scopeKey, state.messageId);
        await this.editWithRetry(parsed.scopeKey, state.messageId, planDecisionMessage({ ...state.decision, phase: "expired" }), { inline_keyboard: [] }, state).catch(() => undefined);
      }
      state.messageId = undefined;
      state.token = undefined;
    }
    if (decision.revision < state.decision.revision && (!gatewayEpoch || gatewayEpoch === state.gatewayEpoch)) return;
    state.decision = decision;
    if (gatewayEpoch) state.gatewayEpoch = gatewayEpoch;
    this.cards.set(key, state);
    const previous = state.flushPromise ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if ((decision.phase === "ready" || decision.phase === "implementing") && state.messageId === undefined) {
        const token = decision.phase === "ready" ? shortToken() : undefined;
        const result = await this.deps.sendRendered(parsed.scopeKey, planDecisionMessage(decision), {
          replyMarkup: token ? planReadyKeyboard(token) : { inline_keyboard: [] },
          disableWebPagePreview: true,
        });
        if (result.messageId === undefined) return;
        state.messageId = result.messageId;
        state.token = token;
        if (token) {
          this.deps.store.setPendingPrompt({
            conversationId: parsed.conversationId,
            scopeKey: parsed.scopeKey,
            promptMessageId: result.messageId,
            kind: "relay_command",
            createdAt: Date.now(),
            sessionKey: sessionKeyValue,
            payloadJson: JSON.stringify({ command: "plan", token, completedTurnId: decision.planTurnId, threadId: decision.threadId }),
            expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
          });
        }
        this.deps.logger.info("router.plan_ready_prompt_sent", {
          conversation_id: parsed.conversationId,
          scope_key: parsed.scopeKey,
          session_key: sessionKeyValue,
          turn_id: decision.planTurnId,
          prompt_message_id: result.messageId,
        });
        return;
      }
      if (state.messageId === undefined) return;
      if (decision.phase !== "ready") this.deps.store.deletePendingPrompt(parsed.scopeKey, state.messageId);
      await this.editWithRetry(
        parsed.scopeKey,
        state.messageId,
        planDecisionMessage(decision),
        decision.phase === "ready" && state.token ? planReadyKeyboard(state.token) : { inline_keyboard: [] },
        state,
      );
    });
    state.flushPromise = current;
    await current;
    if (state.flushPromise === current) state.flushPromise = undefined;
  }

  private async editWithRetry(
    scopeKey: ConversationId,
    messageId: MessageId,
    rendered: RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
    state: PlanCardState,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.deps.editRendered(scopeKey, rendered, { messageId, replyMarkup, disableWebPagePreview: true });
        return;
      } catch (error) {
        lastError = error;
        this.deps.logger.warn("router.plan_ready_edit_failed", {
          session_key: state.sessionKey,
          turn_id: state.decision.planTurnId,
          attempt,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    const replacement = await this.deps.sendRendered(scopeKey, rendered, { replyMarkup, disableWebPagePreview: true });
    this.deps.store.deletePendingPrompt(scopeKey, messageId);
    if (replacement.messageId !== undefined) {
      state.messageId = replacement.messageId;
      if (replyMarkup.inline_keyboard.length > 0 && state.token) {
        const parsed = parseSessionKey(state.sessionKey);
        if (parsed) {
          this.deps.store.setPendingPrompt({
            conversationId: parsed.conversationId,
            scopeKey: parsed.scopeKey,
            promptMessageId: replacement.messageId,
            kind: "relay_command",
            createdAt: Date.now(),
            sessionKey: state.sessionKey,
            payloadJson: JSON.stringify({
              command: "plan",
              token: state.token,
              completedTurnId: state.decision.planTurnId,
              threadId: state.decision.threadId,
            }),
            expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
          });
        }
      }
    }
    if (replacement.messageId === undefined) throw lastError;
  }

  private async dismissReadyPrompt(message: CallbackMessage): Promise<void> {
    if (!message.messageId) return;
    if (this.deps.adapter.deleteMessage) {
      try {
        await this.deps.adapter.deleteMessage(message.conversationId, message.messageId);
        return;
      } catch (error) {
        this.deps.logger.warn("router.plan_ready_delete_failed", {
          conversation_id: message.conversationId,
          message_id: message.messageId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    await this.deps.renderStrictCallbackPage(message, textMessage(""), { inline_keyboard: [] });
  }
}

function localReadyDecision(threadId: string, planTurnId: string): AgentRelayPlanDecisionState {
  const now = Date.now();
  return { threadId, planTurnId, phase: "ready", revision: 0, createdAt: now, updatedAt: now };
}

function isPlanDecisionTerminal(phase: AgentRelayPlanDecisionState["phase"]): boolean {
  return phase === "implementation_started" || phase === "continued" || phase === "failed" || phase === "expired";
}

function planDecisionMessage(decision: AgentRelayPlanDecisionState): RenderedTelegramText {
  switch (decision.phase) {
    case "ready": return messageWithTitle("Plan ready.", "Choose whether to implement it now or keep refining the plan.");
    case "implementing": return messageWithTitle("Implementing plan.", "The implementation action was claimed from a connected client.");
    case "implementation_started": return messageWithTitle("Plan implementation started.");
    case "continued": return messageWithTitle("Continuing in Plan mode.", "The plan remains available for further refinement.");
    case "failed": return messageWithTitle("Plan implementation failed.", "Create or complete a new plan before trying again.");
    case "expired": return messageWithTitle("Plan action expired.", "A newer turn has already started.");
  }
}
