import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { Logger } from "../../domain/logger.ts";
import { parseSessionKey, sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentSessionStatus, AgentTaskInput } from "../../ports/agent.ts";
import type { ImAdapter, InlineKeyboardMarkup, SendMessageOptions } from "../../ports/im.ts";
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
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

export class PlanCommandService {
  private readonly interruptedTurns = new Set<string>();

  constructor(private readonly deps: PlanCommandDeps) {}

  async run(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (this.deps.sessionBusy(status) || this.deps.store.countTasks(conversationId, workspace.name, ["waiting", "queued", "running", "blocked"]) > 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
      return;
    }
    const key = sessionKey(conversationId, workspace.name);
    if (!prompt.trim()) {
      this.deps.store.setCollaborationMode(key, "plan");
      await this.deps.sendRendered(conversationId, messageWithTitle("Plan mode enabled."));
      return;
    }
    this.deps.store.setCollaborationMode(key, "plan");
    await this.deps.submitTask(conversationId, prompt.trim(), userMessageId, "immediate");
  }

  markInterruptedTurn(sessionKeyValue: string, turnId: string): void {
    this.interruptedTurns.add(`${sessionKeyValue}:${turnId}`);
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
    if (action === "implement") {
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
      if (this.deps.sessionBusy(status) || this.deps.hasTaskCreatedAfter(message.conversationId, workspace.name, pending.createdAt)) {
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
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Implementing plan."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      this.deps.store.setCollaborationMode(key, "default");
      this.deps.logger.info("router.plan_callback_implemented", { conversation_id: message.conversationId, session_key: key });
      await this.deps.submitTask(message.conversationId, "Implement the approved plan.", message.messageId, "immediate");
      return;
    }
    await this.dismissReadyPrompt(message);
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
  }

  async sendReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    if (completedTurnId && this.interruptedTurns.delete(`${sessionKeyValue}:${completedTurnId}`)) return;
    const threadId = this.deps.agent.getStatus(sessionKeyValue)?.threadId ?? this.deps.store.getSession(sessionKeyValue)?.thread_id ?? undefined;
    const token = shortToken();
    const result = await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Plan ready.", "Choose whether to implement it now or keep refining the plan."), {
      replyMarkup: planReadyKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) return;
    this.deps.logger.info("router.plan_ready_prompt_sent", {
      conversation_id: parsed.conversationId,
      scope_key: parsed.scopeKey,
      session_key: sessionKeyValue,
      turn_id: completedTurnId,
      prompt_message_id: result.messageId,
    });
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      scopeKey: parsed.scopeKey,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify({ command: "plan", token, completedTurnId, threadId }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
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
