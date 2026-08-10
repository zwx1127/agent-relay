import type {
  AgentActivityEvent,
  AgentApprovalRequestEvent,
  AgentImageOutputEvent,
  AgentMcpElicitationRequestEvent,
  AgentOutputEvent,
  AgentRelayCommandState,
  AgentRelayCommandStateEvent,
  AgentRelayControlSnapshotEvent,
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
import type { SendMessageOptions } from "../ports/im.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import { transcriptTextForInput } from "./tasks/input.ts";
import { PAGE_MAX_CHARS } from "./ui/constants.ts";
import { renderSharedUserInput, type SharedMessageRegistry } from "./shared-message-registry.ts";

export interface RelayAgentEventRouterDeps {
  logger: Logger;
  store: Pick<RelayStore, "markSessionStopped" | "clearSessionThreadId" | "appendTranscript" | "setCollaborationMode" | "requestCollaborationMode">;
  activity: {
    handle(event: AgentActivityEvent): Promise<void>;
    finalize(sessionKey: string, turnId: string | undefined, status: string, error?: string, durationMs?: number): Promise<void>;
    setPhase(sessionKey: string, phase: "working" | "stalled" | "waitingForInput" | "waitingForApproval", detail?: string): Promise<void>;
    terminate(sessionKey: string, phase: "interrupted" | "failed", detail?: string): Promise<void>;
  };
  media: { sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> };
  prompts: {
    handleUserInputRequest(event: AgentUserInputRequestEvent): Promise<void>;
    handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<void>;
    handleMcpElicitationRequest(event: AgentMcpElicitationRequestEvent): Promise<void>;
    handleRequestResolved(event: AgentServerRequestResolvedEvent): Promise<void>;
  };
  finalizeOutput(sessionKey: string): Promise<void>;
  sendPlanReadyPrompt(sessionKey: string, turnId?: string): Promise<void>;
  appendSystem(scopeKey: ConversationId, text: string): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  sharedMessages: SharedMessageRegistry;
  setReplyToMessageId(sessionKey: string, messageId: MessageId): void;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: { messageId: MessageId; disableWebPagePreview?: boolean }): Promise<void>;
  completeTask(sessionKey: string, turnId: string | undefined, status: "done" | "interrupted" | "failed"): Promise<void>;
  markActiveTask(sessionKey: string, status: "blocked" | "running", turnId?: string): Promise<void>;
  cancelActiveTasks(sessionKey: string): Promise<void>;
  failActiveTasks(sessionKey: string): Promise<void>;
  currentThreadId(sessionKey: string): string | undefined;
  resetSessionPresentation(sessionKey: string, options?: { deletePages?: boolean }): Promise<void>;
}

interface SharedCommandCardState {
  sessionKey: string;
  command: AgentRelayCommandState;
  question: string;
  answer: string;
  messageId?: MessageId;
  timer?: Timer;
  flushPromise?: Promise<void>;
}

export class RelayAgentEventRouter {
  private readonly sharedCommandCards = new Map<string, SharedCommandCardState>();
  private readonly sharedCommandRevisions = new Map<string, number>();
  private readonly relaySnapshotRevisions = new Map<string, { gatewayEpoch: string; revision: number }>();

  constructor(private readonly deps: RelayAgentEventRouterDeps) {}

  async handle(event: AgentOutputEvent): Promise<boolean> {
    switch (event.type) {
      case "activity":
        await this.deps.activity.handle(event);
        return true;
      case "turn_stalled":
        if (this.deps.currentThreadId(event.sessionKey) === event.threadId) {
          await this.deps.activity.setPhase(event.sessionKey, "stalled", event.detail);
        }
        return true;
      case "turn_progressed":
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
        await this.blockForPrompt(event, "waitingForInput", () => this.deps.prompts.handleUserInputRequest(event));
        return true;
      case "approval_request":
        await this.blockForPrompt(event, "waitingForApproval", () => this.deps.prompts.handleApprovalRequest(event));
        return true;
      case "mcp_elicitation_request":
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
    const state = this.sharedCommandCards.get(key) ?? {
      sessionKey: event.sessionKey,
      command: event,
      question: "",
      answer: "",
    };
    state.command = event;
    if (event.content?.type === "side_question") state.question = event.content.text;
    if (event.content?.type === "side_delta") state.answer += event.content.text;
    this.sharedCommandCards.set(key, state);
    if (event.content?.type === "side_delta" && !isRelayCommandTerminal(event.phase)) {
      this.scheduleSharedCommandCard(key, parsed.scopeKey, state);
      return;
    }
    await this.flushSharedCommandCard(key, parsed.scopeKey, state);
    if (isRelayCommandTerminal(event.phase)) this.sharedCommandCards.delete(key);
  }

  private async handleRelayThreadState(event: AgentRelayThreadStateEvent): Promise<void> {
    if (this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    this.applyRelayThreadState(event.sessionKey, event);
  }

  private async handleRelayControlSnapshot(event: AgentRelayControlSnapshotEvent): Promise<void> {
    if (this.deps.currentThreadId(event.sessionKey) !== event.threadId) return;
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const previous = this.relaySnapshotRevisions.get(event.sessionKey);
    if (previous?.gatewayEpoch === event.gatewayEpoch && previous.revision >= event.revision) return;
    if (previous && previous.gatewayEpoch !== event.gatewayEpoch) this.clearSharedCommandState(event.sessionKey);
    this.relaySnapshotRevisions.set(event.sessionKey, { gatewayEpoch: event.gatewayEpoch, revision: event.revision });
    this.applyRelayThreadState(event.sessionKey, event.threadState);
    for (const command of event.commands) {
      if (!command.question && !command.answer) continue;
      const key = `${event.sessionKey}\0${command.commandId}`;
      if ((this.sharedCommandRevisions.get(key) ?? -1) >= command.revision) continue;
      this.sharedCommandRevisions.set(key, command.revision);
      const state: SharedCommandCardState = {
        sessionKey: event.sessionKey,
        command,
        question: command.question ?? "",
        answer: command.answer ?? "",
      };
      this.sharedCommandCards.set(key, state);
      await this.flushSharedCommandCard(key, parsed.scopeKey, state);
      if (isRelayCommandTerminal(command.phase)) this.sharedCommandCards.delete(key);
    }
    if (event.commands.length === 0 && event.threadState.collaborationMode === "default") return;
    const lines = [
      `Mode: ${event.threadState.collaborationMode === "plan" ? "Plan" : "Default"}${event.threadState.collaborationModeApplied ? "" : " (pending)"}`,
      ...event.commands.map((command) => `${relayCommandLabel(command.kind)}: ${relayCommandPhaseLabel(command.phase)}`),
    ];
    await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Shared Relay state", lines.join("\n")));
  }

  private clearSharedCommandState(sessionKey: string): void {
    const prefix = `${sessionKey}\0`;
    for (const [key, state] of this.sharedCommandCards) {
      if (!key.startsWith(prefix)) continue;
      if (state.timer) clearTimeout(state.timer);
      this.sharedCommandCards.delete(key);
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

  private scheduleSharedCommandCard(key: string, scopeKey: string, state: SharedCommandCardState): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flushSharedCommandCard(key, scopeKey, state);
    }, 500);
  }

  private async flushSharedCommandCard(key: string, scopeKey: string, state: SharedCommandCardState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
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
    if (!this.sharedCommandCards.has(key) && state.timer) clearTimeout(state.timer);
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
    await this.deps.activity.setPhase(event.sessionKey, "working");
    await this.deps.markActiveTask(event.sessionKey, "running");
  }

  private async handleTurnCompleted(event: AgentTurnCompletedEvent): Promise<void> {
    const turnStatus = event.status ?? "completed";
    this.deps.logger.info("router.turn_completed", {
      session_key: event.sessionKey,
      turn_id: event.turnId,
      status: turnStatus,
      duration_ms: event.durationMs,
    });
    await this.deps.activity.finalize(event.sessionKey, event.turnId, turnStatus, event.error?.message, event.durationMs);
    await this.deps.finalizeOutput(event.sessionKey);
    if (turnStatus === "completed") await this.deps.sendPlanReadyPrompt(event.sessionKey, event.turnId);
    if (turnStatus === "failed") {
      const parsed = parseSessionKey(event.sessionKey);
      if (parsed) {
        const detail = event.error?.message ?? "Codex turn failed.";
        this.deps.appendSystem(parsed.scopeKey, `Error: ${detail}\n`);
        await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Codex turn failed.", detail));
      }
    }
    await this.deps.completeTask(
      event.sessionKey,
      event.turnId,
      turnStatus === "completed" ? "done" : turnStatus === "interrupted" ? "interrupted" : "failed",
    );
  }

  private async blockForPrompt(
    event: AgentUserInputRequestEvent | AgentApprovalRequestEvent | AgentMcpElicitationRequestEvent,
    phase: "waitingForInput" | "waitingForApproval",
    render: () => Promise<void>,
  ): Promise<void> {
    await this.deps.finalizeOutput(event.sessionKey);
    await this.deps.activity.setPhase(event.sessionKey, phase);
    await this.deps.markActiveTask(event.sessionKey, "blocked", event.turnId);
    await render();
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
  if (state.command.kind !== "side") return messageWithTitle("Relay command · shared thread", `${command}\nStatus: ${phase}`);
  const sections = [
    state.question ? `Question: ${truncateSharedCardText(state.question)}` : undefined,
    state.answer ? `Answer: ${truncateSharedCardText(state.answer)}` : undefined,
    `Status: ${phase}`,
  ].filter((section): section is string => Boolean(section));
  return messageWithTitle("Side conversation · shared thread", sections.join("\n\n"));
}

function relayCommandLabel(kind: AgentRelayCommandState["kind"]): string {
  switch (kind) {
    case "review": return "/review";
    case "compact": return "/compact";
    case "side": return "/side · /btw";
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

function isRelayCommandTerminal(phase: AgentRelayCommandState["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function truncateSharedCardText(text: string, limit = 3_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
