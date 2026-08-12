import type {
  AgentActivityEvent,
  AgentApprovalRequestEvent,
  AgentImageOutputEvent,
  AgentMcpElicitationRequestEvent,
  AgentOutputEvent,
  AgentRelayCommandState,
  AgentRelayCommandStateEvent,
  AgentRelayControlSnapshotEvent,
  AgentRelayPlanDecisionStateEvent,
  AgentRelayThreadState,
  AgentRelayThreadStateEvent,
  AgentServerRequestResolvedEvent,
  AgentThreadLifecycleEvent,
  AgentTurnCompletedEvent,
  AgentUserInputRequestEvent,
  AgentUserMessageEvent,
} from "../ports/agent.ts";
import type { Logger } from "../domain/logger.ts";
import { parseSessionKey } from "../domain/session.ts";
import type { RelayStore } from "../storage/store.ts";
import { splitRenderedForTelegram, type RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import { transcriptTextForInput } from "./tasks/input.ts";
import { PAGE_MAX_CHARS } from "./ui/constants.ts";
import { renderSharedUserInput, type SharedMessageRegistry } from "./shared-message-registry.ts";

export interface RelayAgentEventRouterDeps {
  logger: Logger;
  store: Pick<RelayStore, "markSessionStopped" | "clearSessionThreadId" | "appendTranscript" | "setCollaborationMode" | "requestCollaborationMode">;
  activity: {
    handle(event: AgentActivityEvent): Promise<void>;
    finalize(sessionKey: string, turnId: string | undefined, status: string, error?: string, durationMs?: number): Promise<boolean>;
    setPhase(sessionKey: string, phase: "working" | "stalled" | "waitingForInput" | "waitingForApproval" | "interrupting", detail?: string): Promise<void>;
    refreshContext(sessionKey: string): Promise<void>;
    terminate(sessionKey: string, phase: "interrupted" | "failed", detail?: string): Promise<void>;
  };
  media: { sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> };
  prompts: {
    handleUserInputRequest(event: AgentUserInputRequestEvent): Promise<boolean>;
    handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<boolean>;
    handleMcpElicitationRequest(event: AgentMcpElicitationRequestEvent): Promise<boolean>;
    handleRequestResolved(event: AgentServerRequestResolvedEvent): Promise<void>;
    clearForSession(sessionKey: string): void;
  };
  finalizeOutput(sessionKey: string): Promise<void>;
  sendPlanReadyPrompt(sessionKey: string, turnId?: string): Promise<void>;
  handlePlanDecisionState(event: AgentRelayPlanDecisionStateEvent): Promise<void>;
  handlePlanDecisionSnapshot(sessionKey: string, gatewayEpoch: string, decisions: AgentRelayControlSnapshotEvent["planDecisions"]): Promise<void>;
  handleSharedGoalState(sessionKey: string, goal: import("../ports/agent.ts").AgentThreadGoal | null): Promise<void>;
  handleSharedCommandState(event: AgentRelayCommandStateEvent): Promise<void>;
  appendSystem(scopeKey: ConversationId, text: string): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  sharedMessages: SharedMessageRegistry;
  setReplyToMessageId(sessionKey: string, messageId: MessageId): void;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: { messageId: MessageId; disableWebPagePreview?: boolean; replyMarkup?: InlineKeyboardMarkup }): Promise<void>;
  completeTask(sessionKey: string, turnId: string | undefined, status: "done" | "interrupted" | "failed"): Promise<void>;
  markActiveTask(sessionKey: string, status: "blocked" | "running", turnId?: string): Promise<void>;
  cancelActiveTasks(sessionKey: string): Promise<void>;
  failActiveTasks(sessionKey: string): Promise<void>;
  currentThreadId(sessionKey: string): string | undefined;
  currentActiveTurnId(sessionKey: string): string | undefined;
  resetSessionPresentation(sessionKey: string, options?: { deletePages?: boolean }): Promise<void>;
}

interface SharedCommandCardState {
  sessionKey: string;
  command: AgentRelayCommandState;
  messageId?: MessageId;
  flushPromise?: Promise<void>;
}

export class RelayAgentEventRouter {
  private readonly sharedCommandCards = new Map<string, SharedCommandCardState>();
  private readonly sharedCommandRevisions = new Map<string, number>();
  private readonly relaySnapshotRevisions = new Map<string, { gatewayEpoch: string; revision: number }>();
  private readonly relayThreadStates = new Map<string, AgentRelayThreadState>();
  private readonly terminalTurns = new Map<string, number>();

  constructor(private readonly deps: RelayAgentEventRouterDeps) {}

  async handle(event: AgentOutputEvent): Promise<boolean> {
    switch (event.type) {
      case "activity":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        await this.deps.activity.handle(event);
        if (event.activity.kind === "goal") await this.deps.handleSharedGoalState(event.sessionKey, event.activity.goal);
        return true;
      case "turn_stalled":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        if (this.deps.currentThreadId(event.sessionKey) === event.threadId) {
          await this.deps.activity.setPhase(event.sessionKey, "stalled", event.detail);
        }
        return true;
      case "turn_progressed":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        if (this.deps.currentThreadId(event.sessionKey) === event.threadId) {
          await this.deps.activity.setPhase(event.sessionKey, "working");
        }
        return true;
      case "user_message":
        await this.handleUserMessage(event);
        return true;
      case "relay_command_state":
        await this.handleRelayCommandState(event);
        return true;
      case "relay_thread_state":
        await this.handleRelayThreadState(event);
        return true;
      case "relay_plan_decision_state":
        await this.deps.handlePlanDecisionState(event);
        return true;
      case "relay_control_snapshot":
        await this.handleRelayControlSnapshot(event);
        return true;
      case "image":
        // Preserve transcript ordering by flushing text before an image.
        await this.deps.finalizeOutput(event.sessionKey);
        await this.deps.media.sendAgentImageOutput(event);
        return true;
      case "turn_completed":
        await this.handleTurnCompleted(event);
        return true;
      case "user_input_request":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        await this.blockForPrompt(event, "waitingForInput", () => this.deps.prompts.handleUserInputRequest(event));
        return true;
      case "approval_request":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        await this.blockForPrompt(event, "waitingForApproval", () => this.deps.prompts.handleApprovalRequest(event));
        return true;
      case "mcp_elicitation_request":
        if (this.isTerminalTurn(event.sessionKey, event.turnId)) return true;
        await this.blockForPrompt(event, "waitingForInput", () => this.deps.prompts.handleMcpElicitationRequest(event));
        return true;
      case "server_request_resolved":
        await this.handleRequestResolved(event);
        return true;
      case "thread_lifecycle":
        await this.handleThreadLifecycle(event);
        return true;
      default:
        return false;
    }
  }

  private async handleRelayCommandState(event: AgentRelayCommandStateEvent): Promise<void> {
    if (this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const key = `${event.sessionKey}\0${event.commandId}`;
    if ((this.sharedCommandRevisions.get(key) ?? -1) >= event.revision) return;
    this.sharedCommandRevisions.set(key, event.revision);
    this.trimSharedCommandRevisions();
    await this.deps.handleSharedCommandState(event);
    const state = this.sharedCommandCards.get(key) ?? {
      sessionKey: event.sessionKey,
      command: event,
    };
    state.command = event;
    this.sharedCommandCards.set(key, state);
    await this.flushSharedCommandCard(key, parsed.scopeKey, state);
    if (isRelayCommandTerminal(event.phase)) this.sharedCommandCards.delete(key);
  }

  private async handleRelayThreadState(event: AgentRelayThreadStateEvent): Promise<void> {
    if (this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    const stored = this.relayThreadStates.get(event.sessionKey);
    const previous = stored?.threadId === event.threadId ? stored : undefined;
    this.relayThreadStates.set(event.sessionKey, event);
    this.applyRelayThreadState(event.sessionKey, event);
    await this.deps.activity.refreshContext(event.sessionKey);
    if (event.activeTurn?.interruptRequest
      && event.activeTurn.interruptRequest.requestedAt !== previous?.activeTurn?.interruptRequest?.requestedAt) {
      await this.deps.activity.setPhase(
        event.sessionKey,
        "interrupting",
        `Requested by ${event.activeTurn.interruptRequest.source.label} at ${formatRelayStateTime(event.activeTurn.interruptRequest.requestedAt)}`,
      );
    } else if (event.waitingOn === "approval") {
      await this.deps.activity.setPhase(event.sessionKey, "waitingForApproval");
    } else if (event.waitingOn === "userInput") {
      await this.deps.activity.setPhase(event.sessionKey, "waitingForInput");
    } else if (event.threadStatus === "active") {
      await this.deps.activity.setPhase(event.sessionKey, "working");
    }
    if (!previous
      || previous.collaborationMode === event.collaborationMode
      || !event.collaborationModeApplied
      || event.initiatedByClient) return;
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    await this.deps.sendRendered(parsed.scopeKey, messageWithTitle(
      "Shared chat mode changed.",
      `Mode: ${event.collaborationMode === "plan" ? "Plan" : "Default"}\nSource: ${event.collaborationModeSource?.label ?? "Unknown client"}\nTime: ${formatRelayStateTime(event.collaborationModeUpdatedAt ?? event.updatedAt)}`,
    ));
  }

  private async handleRelayControlSnapshot(event: AgentRelayControlSnapshotEvent): Promise<void> {
    if (this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const previous = this.relaySnapshotRevisions.get(event.sessionKey);
    if (previous?.gatewayEpoch === event.gatewayEpoch && previous.revision >= event.revision) return;
    if (previous && previous.gatewayEpoch !== event.gatewayEpoch) await this.clearSharedCommandState(event.sessionKey, parsed.scopeKey);
    this.relaySnapshotRevisions.set(event.sessionKey, { gatewayEpoch: event.gatewayEpoch, revision: event.revision });
    this.relayThreadStates.set(event.sessionKey, event.threadState);
    this.applyRelayThreadState(event.sessionKey, event.threadState);
    await this.deps.activity.refreshContext(event.sessionKey);
    await this.deps.handlePlanDecisionSnapshot(event.sessionKey, event.gatewayEpoch, event.planDecisions);
    for (const command of event.commands) {
      const key = `${event.sessionKey}\0${command.commandId}`;
      if ((this.sharedCommandRevisions.get(key) ?? -1) >= command.revision) continue;
      this.sharedCommandRevisions.set(key, command.revision);
      await this.deps.handleSharedCommandState({
        type: "relay_command_state",
        sessionKey: event.sessionKey,
        gatewayEpoch: event.gatewayEpoch,
        threadRevision: command.revision,
        ...command,
      });
      const state: SharedCommandCardState = {
        sessionKey: event.sessionKey,
        command,
      };
      this.sharedCommandCards.set(key, state);
      await this.flushSharedCommandCard(key, parsed.scopeKey, state);
      if (isRelayCommandTerminal(command.phase)) this.sharedCommandCards.delete(key);
    }
    if (event.commands.length === 0) return;
    const lines = [
      `Mode: ${event.threadState.collaborationMode === "plan" ? "Plan" : "Default"}${event.threadState.collaborationModeApplied ? "" : " (pending)"}`,
      ...event.commands.map((command) => `${relayCommandLabel(command.kind)}: ${relayCommandPhaseLabel(command.phase)}`),
    ];
    await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Shared Relay state", lines.join("\n")));
  }

  private async clearSharedCommandState(sessionKey: string, scopeKey: string): Promise<void> {
    const prefix = `${sessionKey}\0`;
    for (const [key, state] of this.sharedCommandCards) {
      if (!key.startsWith(prefix)) continue;
      this.sharedCommandCards.delete(key);
      if (state.flushPromise) await state.flushPromise.catch(() => undefined);
      if (state.messageId !== undefined) {
        await this.deps.editRendered(
          scopeKey,
          messageWithTitle("Relay command state expired.", "The Gateway restarted; use the latest shared state."),
          { messageId: state.messageId, replyMarkup: { inline_keyboard: [] } },
        ).catch((error) => {
          this.deps.logger.warn("router.shared_command_epoch_retire_failed", {
            session_key: sessionKey,
            command_id: state.command.commandId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }
    }
    for (const key of this.sharedCommandRevisions.keys()) {
      if (key.startsWith(prefix)) this.sharedCommandRevisions.delete(key);
    }
  }

  private trimSharedCommandRevisions(): void {
    const maxEntries = 2_000;
    if (this.sharedCommandRevisions.size <= maxEntries) return;
    const oldest = this.sharedCommandRevisions.keys().next().value;
    if (oldest !== undefined) this.sharedCommandRevisions.delete(oldest);
  }

  private applyRelayThreadState(sessionKey: string, state: AgentRelayThreadState): void {
    if (state.collaborationModeApplied) this.deps.store.setCollaborationMode(sessionKey, state.collaborationMode);
    else this.deps.store.requestCollaborationMode(sessionKey, state.collaborationMode);
  }

  private async flushSharedCommandCard(_key: string, scopeKey: string, state: SharedCommandCardState): Promise<void> {
    const previous = state.flushPromise ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const rendered = sharedCommandMessage(state);
      if (state.messageId) {
        try {
          await this.deps.editRendered(scopeKey, rendered, { messageId: state.messageId, disableWebPagePreview: true });
          return;
        } catch (error) {
          this.deps.logger.warn("router.shared_command_edit_failed", {
            session_key: state.sessionKey,
            command_id: state.command.commandId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.deps.sendRendered(scopeKey, rendered);
      if (result.messageId) state.messageId = result.messageId;
    });
    state.flushPromise = current;
    await current;
    if (state.flushPromise === current) state.flushPromise = undefined;
  }

  private async handleUserMessage(event: AgentUserMessageEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    await this.deps.finalizeOutput(event.sessionKey);
    if (!event.input.text && !event.input.attachments?.length && !event.input.images?.length) return;
    const text = transcriptTextForInput(event.input);
    const context = this.deps.sharedMessages.userMessageContext(event.threadId, event.clientUserMessageId);
    const referenceKey = context?.referenceKey
      ?? this.deps.sharedMessages.externalUserReference(event.threadId, event.itemId);
    const replyToMessageId = this.deps.sharedMessages.messageIdForReference(
      event.threadId,
      context?.replyReferenceKey,
      parsed.scopeKey,
    );
    this.deps.logger.info("router.shared_user_message", {
      session_key: event.sessionKey,
      thread_id: event.threadId,
      turn_id: event.turnId,
      item_id: event.itemId,
      text_len: event.input.text.length,
      attachment_count: event.input.attachments?.length ?? 0,
      has_im_context: Boolean(context),
      reply_mapped: replyToMessageId !== undefined,
    });
    this.deps.store.appendTranscript({
      conversationId: parsed.conversationId,
      scopeKey: parsed.scopeKey,
      workspaceName: parsed.workspaceName,
      role: "user",
      text,
      createdAt: Date.now(),
    });
    const rendered = context
      ? renderSharedUserInput(event.input, context.presentation)
      : messageWithTitle("User \u00b7 shared thread", text);
    let lastMessageId: MessageId | undefined;
    for (const [index, page] of splitRenderedForTelegram(rendered, PAGE_MAX_CHARS).entries()) {
      const result = await this.deps.sendRendered(parsed.scopeKey, page, {
        ...(index === 0 && replyToMessageId !== undefined ? { replyToMessageId } : {}),
      });
      if (result.messageId !== undefined) {
        lastMessageId = result.messageId;
        if (referenceKey) this.deps.sharedMessages.registerAlias(event.threadId, referenceKey, parsed.scopeKey, result.messageId);
      }
    }
    if (lastMessageId !== undefined) this.deps.setReplyToMessageId(event.sessionKey, lastMessageId);
  }

  private async handleRequestResolved(event: AgentServerRequestResolvedEvent): Promise<void> {
    await this.deps.prompts.handleRequestResolved(event);
    if (this.isTerminalTurn(event.sessionKey, event.turnId)) return;
    if (event.threadId && this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    await this.deps.activity.setPhase(event.sessionKey, "working");
    await this.deps.markActiveTask(event.sessionKey, "running", event.turnId);
  }

  private async handleTurnCompleted(event: AgentTurnCompletedEvent): Promise<void> {
    const turnStatus = event.status ?? "completed";
    this.rememberTerminalTurn(event.sessionKey, event.turnId);
    const activeTurnId = this.deps.currentActiveTurnId(event.sessionKey);
    const terminalIsCurrent = !event.turnId || !activeTurnId || activeTurnId === event.turnId;
    this.deps.logger.info("router.turn_completed", {
      session_key: event.sessionKey,
      turn_id: event.turnId,
      status: turnStatus,
      duration_ms: event.durationMs,
    });
    if (terminalIsCurrent) this.deps.prompts.clearForSession(event.sessionKey);
    const presented = await this.deps.activity.finalize(event.sessionKey, event.turnId, turnStatus, event.error?.message, event.durationMs);
    await this.deps.finalizeOutput(event.sessionKey);
    if (terminalIsCurrent && turnStatus === "completed") await this.deps.sendPlanReadyPrompt(event.sessionKey, event.turnId);
    if (turnStatus === "failed") {
      const parsed = parseSessionKey(event.sessionKey);
      if (parsed) {
        const detail = event.error?.message ?? "Codex turn failed.";
        this.deps.appendSystem(parsed.scopeKey, `Error: ${detail}\n`);
        await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Codex turn failed.", detail));
      }
    }
    if (!presented && turnStatus === "interrupted") {
      const state = this.relayThreadStates.get(event.sessionKey);
      const latest = state?.latestTurn;
      const terminal = latest?.turnId === event.turnId ? latest : undefined;
      const source = terminal?.interruptedBy ?? terminal?.source;
      if (terminal && source?.kind !== "relay") {
        const parsed = parseSessionKey(event.sessionKey);
        if (parsed) {
          await this.deps.sendRendered(parsed.scopeKey, messageWithTitle(
            "Codex turn interrupted.",
            `Source: ${source?.label ?? "Unknown client"}\nTime: ${formatRelayStateTime(terminal?.finishedAt ?? Date.now())}`,
          ));
        }
      }
    }
    await this.deps.completeTask(
      event.sessionKey,
      event.turnId,
      turnStatus === "completed" ? "done" : turnStatus === "interrupted" ? "interrupted" : "failed",
    );
  }

  private isTerminalTurn(sessionKey: string, turnId: string | undefined): boolean {
    return Boolean(turnId && this.terminalTurns.has(`${sessionKey}\0${turnId}`));
  }

  private rememberTerminalTurn(sessionKey: string, turnId: string | undefined): void {
    if (!turnId) return;
    const key = `${sessionKey}\0${turnId}`;
    this.terminalTurns.delete(key);
    this.terminalTurns.set(key, Date.now());
    while (this.terminalTurns.size > 2_000) {
      const oldest = this.terminalTurns.keys().next().value;
      if (typeof oldest !== "string") break;
      this.terminalTurns.delete(oldest);
    }
  }

  private async blockForPrompt(
    event: AgentUserInputRequestEvent | AgentApprovalRequestEvent | AgentMcpElicitationRequestEvent,
    phase: "waitingForInput" | "waitingForApproval",
    render: () => Promise<boolean>,
  ): Promise<void> {
    await this.deps.finalizeOutput(event.sessionKey);
    if (!await render()) return;
    await this.deps.activity.setPhase(event.sessionKey, phase);
    await this.deps.markActiveTask(event.sessionKey, "blocked", event.turnId);
  }

  private async handleThreadLifecycle(event: AgentThreadLifecycleEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const currentThreadId = this.deps.currentThreadId(event.sessionKey);
    if (currentThreadId && currentThreadId !== event.threadId) {
      this.deps.logger.info("router.thread_lifecycle_stale", {
        session_key: event.sessionKey,
        event_thread_id: event.threadId,
        current_thread_id: currentThreadId,
        action: event.action,
      });
      return;
    }
    await this.deps.activity.terminate(event.sessionKey, "interrupted", `Chat ${event.action}.`);
    await this.deps.resetSessionPresentation(event.sessionKey, { deletePages: true });
    this.relayThreadStates.delete(event.sessionKey);
    this.deps.store.markSessionStopped(event.sessionKey);
    if (event.action === "archived" || event.action === "deleted") {
      this.deps.store.clearSessionThreadId(event.sessionKey);
      await this.deps.cancelActiveTasks(event.sessionKey);
    } else {
      await this.deps.failActiveTasks(event.sessionKey);
    }
    if (!event.initiatedByClient) {
      await this.deps.sendRendered(parsed.scopeKey, messageWithTitle(
        event.action === "archived" ? "Chat archived externally." : event.action === "deleted" ? "Chat deleted externally." : "Chat closed.",
      ));
    }
  }
}

function sharedCommandMessage(state: SharedCommandCardState): RenderedTelegramText {
  const command = relayCommandLabel(state.command.kind);
  const phase = relayCommandPhaseLabel(state.command.phase);
  return messageWithTitle("Relay command · shared thread", `${command}\nStatus: ${phase}`);
}

function relayCommandLabel(kind: AgentRelayCommandState["kind"]): string {
  switch (kind) {
    case "review": return "/review";
    case "compact": return "/compact";
    case "rename": return "/rename";
    case "goal_update": return "/goal update";
    case "goal_clear": return "/goal clear";
    case "archive": return "/archive";
    case "delete": return "/delete";
    case "terminals_clean": return "/stop · /clean";
    case "terminal_stop": return "Terminal stop";
  }
}

function relayCommandPhaseLabel(phase: AgentRelayCommandState["phase"]): string {
  switch (phase) {
    case "accepted": return "Accepted";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
  }
}

function formatRelayStateTime(value: number): string {
  return new Date(value).toISOString().replace(/\.000Z$/u, "Z");
}

function isRelayCommandTerminal(phase: AgentRelayCommandState["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}
