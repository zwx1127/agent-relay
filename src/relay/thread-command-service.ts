import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentBuiltinCommand,
  AgentDriver,
  AgentSessionStatus,
  AgentTaskInput,
} from "../ports/agent.ts";
import type { InlineKeyboardMarkup, SendMessageOptions, ImAdapter } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { sessionKey } from "../domain/session.ts";
import type { Logger } from "../domain/logger.ts";
import type { RelayStore } from "../storage/store.ts";
import type { PendingPrompt, TaskStatus, WorkspaceRecord } from "./types.ts";
import { CODEX_PROMPT_TTL_MS, LIST_PAGE_SIZE } from "./ui/constants.ts";
import { shortToken } from "./ui/callback-data.ts";
import { commandArgs, parseReviewTarget } from "./ui/commands.ts";
import { commandConfirmKeyboard, resumeKeyboard } from "./ui/keyboards.ts";
import {
  formatResumeMessage,
} from "./ui/messages.ts";
import { asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import { AttachmentPicker, isWorkspaceMentionPath, parseAttachmentRecord } from "./thread-commands/attachment-picker.ts";
import { BackgroundTerminalService } from "./thread-commands/background-terminals.ts";
import { GoalCommandService } from "./thread-commands/goal.ts";
import { PlanCommandService } from "./thread-commands/plan.ts";
import type { CallbackMessage } from "./thread-commands/types.ts";

export interface ThreadCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "deleteMessage">;
  logger: Logger;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string, options?: { resumePrevious?: boolean }): Promise<AgentSessionStatus>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  clearActivityForSession(sessionKey: string): void;
  refreshActivityContext(sessionKey: string): Promise<void>;
  interruptActiveTasks(sessionKey: string): Promise<void>;
  interruptTasksByStatus(sessionKey: string, statuses: TaskStatus[]): Promise<void>;
  submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference?: TaskSubmitPreference, input?: AgentTaskInput): Promise<void>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  expireCallbackPrompt(message: CallbackMessage): Promise<void>;
  clearCodexPromptsForSession(sessionKey: string): void;
  hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean;
}

export class ThreadCommandService {
  private readonly attachments: AttachmentPicker;
  private readonly backgroundTerminals: BackgroundTerminalService;
  private readonly goals: GoalCommandService;
  private readonly plans: PlanCommandService;

  constructor(private readonly deps: ThreadCommandDeps) {
    this.attachments = new AttachmentPicker({
      store: deps.store,
      agent: deps.agent,
      commandSession: (conversationId) => this.commandSession(conversationId),
      commandBusy: (conversationId, workspaceName, status) => this.commandBusy(conversationId, workspaceName, status),
      sendBusyCommandNotice: (conversationId) => this.sendBusyCommandNotice(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
      expireCallbackPrompt: deps.expireCallbackPrompt,
    });
    this.backgroundTerminals = new BackgroundTerminalService({
      store: deps.store,
      agent: deps.agent,
      logger: deps.logger,
      commandSession: (conversationId) => this.commandSession(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
    });
    this.goals = new GoalCommandService({
      store: deps.store,
      agent: deps.agent,
      commandSession: (conversationId) => this.commandSession(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      sendRendered: deps.sendRendered,
      refreshActivityContext: deps.refreshActivityContext,
    });
    this.plans = new PlanCommandService({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: deps.logger,
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      ensureAgentStarted: deps.ensureAgentStarted,
      sessionBusy: (status) => this.sessionBusy(status),
      hasTaskCreatedAfter: deps.hasTaskCreatedAfter,
      submitTask: deps.submitTask,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
    });
  }

  async runReviewCommand(conversationId: ConversationId, text: string): Promise<void> {
    const target = parseReviewTarget(commandArgs(text));
    await this.runBuiltinCommand(conversationId, { type: "review", target });
  }

  async runBuiltinCommand(conversationId: ConversationId, command: AgentBuiltinCommand): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver does not support this command.");
    const result = await this.deps.agent.runBuiltinCommand(key, command);
    if (result.threadId && result.threadId !== status.threadId) this.deps.store.setSessionThreadId(key, result.threadId);
    this.deps.logger.info("router.builtin_command_started", { conversation_id: conversationId, workspace: workspace.name, command: command.type });
    await this.deps.sendRendered(conversationId, messageWithTitle(result.message));
  }

  async runInitCommand(conversationId: ConversationId, userMessageId?: MessageId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    if (existsSync(join(workspace.path, "AGENTS.md"))) {
      await this.deps.sendRendered(conversationId, messageWithTitle("AGENTS.md already exists.", "Skipping /init to avoid overwriting it."));
      return;
    }
    await this.deps.submitTask(conversationId, "Generate a file named AGENTS.md that serves as a contributor guide for this repository.", userMessageId, "immediate");
  }

  async startFreshThread(conversationId: ConversationId, name = "", clearDisplay = false): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (this.commandBusy(conversationId, workspace.name, existing)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.deletePendingPromptsForSession(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (name.trim()) {
      if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
      await this.deps.agent.renameThread(key, name.trim());
      status.threadName = name.trim();
    }
    if (clearDisplay) {
      this.deps.clearActivityForSession(key);
      this.deps.store.clearTranscript(conversationId, workspace.name);
      this.deps.store.deletePagedOutputsForSession(key);
    }
    this.deps.store.setCollaborationMode(key, "default");
    await this.deps.sendRendered(conversationId, messageWithTitle(clearDisplay ? "Cleared Relay display and started a new chat." : "Started a new chat.", `Thread: ${status.threadName ?? status.threadId ?? "new"}`));
  }

  async renderResumePicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    if (this.commandBusy(conversationId, workspace.name, this.deps.agent.getStatus(key))) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.listThreads) throw new Error("Agent driver cannot list threads.");
    const threads = await this.deps.agent.listThreads({
      workspacePath: workspace.path,
      limit: LIST_PAGE_SIZE,
      ...(searchTerm ? { searchTerm } : {}),
    });
    if (threads.length === 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle("No saved chats found."));
      return;
    }
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatResumeMessage(threads), {
      replyMarkup: resumeKeyboard(token, threads),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a resume picker message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "resume", token, threads: threads.map((thread) => ({ id: thread.id, name: thread.name })) }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  async forkCurrentThread(conversationId: ConversationId): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.forkThread) throw new Error("Agent driver cannot fork threads.");
    const result = await this.deps.agent.forkThread(key);
    this.deps.store.setSessionThreadId(key, result.threadId);
    await this.deps.sendRendered(conversationId, messageWithTitle("Forked chat.", `Thread: ${result.threadName ?? result.threadId}`));
    this.deps.logger.info("router.thread_forked", { conversation_id: conversationId, workspace: workspace.name, thread_id: result.threadId });
  }

  async sideConversationCommand(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    const normalized = prompt.trim();
    if (!normalized) {
      this.deps.requireCurrentWorkspace(conversationId);
      const result = await this.deps.sendRendered(conversationId, textMessage("Side question requested."), {
        forceReply: true,
        forceReplyInstruction: "Reply to this prompt, or send your next message with the side question.",
        inputFieldPlaceholder: "Side question",
        disableWebPagePreview: true,
      });
      if (!result.messageId) throw new Error("IM adapter did not return a side conversation prompt message id.");
      this.deps.store.setPendingPrompt({
        conversationId,
        promptMessageId: result.messageId,
        kind: "relay_command",
        createdAt: Date.now(),
        payloadJson: JSON.stringify({ command: "side" }),
        expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
      });
      return;
    }

    await this.runSideConversation(conversationId, normalized, userMessageId);
  }

  private async runSideConversation(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    if (!prompt.trim()) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Side conversation cancelled.", "No question was provided."));
      return;
    }
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    const key = sessionKey(conversationId, workspace.name);
    if (status.reviewInProgress) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Side conversation unavailable.", "Wait for the current review to finish."));
      return;
    }
    if (!status.threadId) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Side conversation unavailable.", "Send a normal message first, then try /side again."));
      return;
    }
    if (!this.deps.agent.sideConversation) throw new Error("Agent driver cannot start side conversations.");
    this.deps.logger.info("router.side_conversation_started", { conversation_id: conversationId, workspace: workspace.name, session_key: key });
    const result = await this.deps.agent.sideConversation(key, prompt);
    await this.deps.sendRendered(conversationId, messageWithTitle("Side conversation", result.message), {
      ...(userMessageId ? { replyToMessageId: userMessageId } : {}),
      disableWebPagePreview: true,
    });
  }

  async renameCommand(conversationId: ConversationId, name: string): Promise<void> {
    if (name.trim()) {
      await this.renameCurrentThread(conversationId, name.trim());
      return;
    }
    const result = await this.deps.sendRendered(conversationId, textMessage("New chat name requested."), {
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt, or send your next message with the new chat name.",
      inputFieldPlaceholder: "New chat name",
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a rename prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "rename" }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  async renameCurrentThread(conversationId: ConversationId, name: string): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
    await this.deps.agent.renameThread(key, name);
    await this.deps.sendRendered(conversationId, messageWithTitle("Renamed chat.", name));
  }

  async planCommand(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    await this.plans.run(conversationId, prompt, userMessageId);
  }

  async goalCommand(conversationId: ConversationId, args: string): Promise<void> {
    await this.goals.run(conversationId, args);
  }

  async cleanBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    await this.backgroundTerminals.clean(conversationId);
  }

  async interruptCommand(conversationId: ConversationId, args: string): Promise<void> {
    const mode = args.trim().toLowerCase();
    if (mode && mode !== "all") {
      await this.deps.sendRendered(conversationId, messageWithTitle("Usage: /interrupt [all]"));
      return;
    }
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    const blockedOnPrompt = Boolean(status?.waitingForApproval || status?.waitingForUserInput);
    if (!status?.running || (!status.activeTurnId && !blockedOnPrompt)) {
      await this.deps.sendRendered(conversationId, messageWithTitle("No active Codex turn to interrupt."));
      return;
    }
    if (!this.deps.agent.interrupt) throw new Error("Agent driver cannot interrupt turns.");

    await this.deps.finalizeSessionOutput(key);
    const result = await this.deps.agent.interrupt(key);
    if (result.stale) {
      if (result.turnId && this.deps.store.getCollaborationMode(key) === "plan") {
        this.plans.markInterruptedTurn(key, result.turnId);
      }
      this.deps.clearCodexPromptsForSession(key);
      if (mode === "all") {
        await this.deps.interruptTasksByStatus(key, ["waiting", "queued", "running", "blocked"]);
      } else {
        await this.deps.interruptActiveTasks(key);
      }
      this.deps.logger.info("router.stale_turn_interrupt_recovered", {
        conversation_id: conversationId,
        workspace: workspace.name,
        session_key: key,
        turn_id: result.turnId,
        mode: mode || "current",
      });
      await this.deps.sendRendered(conversationId, messageWithTitle("No active Codex turn remained.", "Cleared stale Relay state."));
      return;
    }
    if (!result.interrupted && blockedOnPrompt) {
      this.deps.clearCodexPromptsForSession(key);
      if (mode === "all") {
        await this.deps.interruptTasksByStatus(key, ["waiting", "queued", "running", "blocked"]);
      } else {
        await this.deps.interruptActiveTasks(key);
      }
      this.deps.logger.info("router.blocked_turn_interrupt_recovered", {
        conversation_id: conversationId,
        workspace: workspace.name,
        session_key: key,
        turn_id: result.turnId,
        mode: mode || "current",
      });
      await this.deps.sendRendered(conversationId, messageWithTitle("No active Codex turn remained.", "Cleared stale Relay state."));
      return;
    }
    if (!result.interrupted) {
      await this.deps.sendRendered(conversationId, messageWithTitle("No active Codex turn to interrupt."));
      return;
    }

    if (result.turnId && this.deps.store.getCollaborationMode(key) === "plan") {
      this.plans.markInterruptedTurn(key, result.turnId);
    }
    this.deps.clearCodexPromptsForSession(key);
    if (mode === "all") {
      await this.deps.interruptTasksByStatus(key, ["waiting", "queued", "running", "blocked"]);
    } else {
      await this.deps.interruptActiveTasks(key);
    }
    this.deps.logger.info("router.turn_interrupted", {
      conversation_id: conversationId,
      workspace: workspace.name,
      session_key: key,
      turn_id: result.turnId,
      mode: mode || "current",
    });
    await this.deps.sendRendered(conversationId, messageWithTitle(mode === "all" ? "Interrupted current turn and queued tasks." : "Interrupted current turn."));
  }

  async renderBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    await this.backgroundTerminals.render(conversationId);
  }

  async renderSkillPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    await this.attachments.renderSkills(conversationId, searchTerm);
  }

  async renderMentionPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    await this.attachments.renderMentions(conversationId, searchTerm);
  }

  async requestCompactConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "compact", "Compact chat?", "Codex will replace earlier turns with a summary.", "Compact");
  }

  async requestArchiveConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "archive", "Archive chat?", "The transcript stays stored and can be restored with Codex CLI.", "Archive");
  }

  async requestDeleteConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "delete", "Permanently delete chat?", "Deletion also removes descendant sessions. This requires two confirmations.", "Continue", "first");
  }

  private async requestThreadConfirmation(
    conversationId: ConversationId,
    command: "compact" | "archive" | "delete",
    title: string,
    body: string,
    confirmLabel: string,
    stage = "confirm",
  ): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, messageWithTitle(title, body), {
      replyMarkup: commandConfirmKeyboard(token, command, confirmLabel, stage),
    });
    if (!result.messageId) throw new Error("IM adapter did not return a command confirmation message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command, token, stage, threadId: status.threadId }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    return { workspace, status, key: sessionKey(conversationId, workspace.name) };
  }

  private sessionBusy(status: AgentSessionStatus): boolean {
    return Boolean(status.activeTurnId || status.waitingForApproval || status.waitingForUserInput);
  }

  private async sendBusyCommandNotice(conversationId: ConversationId): Promise<void> {
    await this.deps.sendRendered(conversationId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
  }

  async handleCommandCallback(message: CallbackMessage, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, command, token, action] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || data.token !== token || isExpired(pending)) {
      if (command === "terminal") {
        if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
        await this.renderBackgroundTerminals(message.conversationId);
        return;
      }
      await this.deps.expireCallbackPrompt(message);
      return;
    }

    if (command === "compact" || command === "archive" || command === "delete") {
      await this.confirmThreadCommand(message, pending, data, command, action);
      return;
    }

    if (command === "attach") {
      await this.attachments.handleCallback(message, pending, data, action);
      return;
    }

    if (command === "terminal") {
      await this.backgroundTerminals.stopFromCallback(message, pending, data, action);
      return;
    }

    if (command === "resume") {
      await this.resumeFromCallback(message, pending, data, action);
      return;
    }
    if (command === "plan") {
      await this.plans.handleCallback(message, pending, data, action);
      return;
    }
    throw new Error("Unknown command callback.");
  }

  private async confirmThreadCommand(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    command: "compact" | "archive" | "delete",
    action: string | undefined,
  ): Promise<void> {
    if (action === "cancel") {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} cancelled.`), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    if (command === "delete" && action === "first") {
      const token = typeof data.token === "string" ? data.token : shortToken();
      await this.deps.renderStrictCallbackPage(
        message,
        messageWithTitle("Final deletion confirmation", "This permanently removes the transcript and descendant sessions. This cannot be undone."),
        commandConfirmKeyboard(token, "delete", "Delete permanently", "confirm"),
      );
      this.deps.store.setPendingPrompt({ ...pending, payloadJson: JSON.stringify({ ...data, stage: "final" }) });
      return;
    }
    if (action !== "confirm") throw new Error("Command confirmation is unavailable.");
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || status.threadId !== data.threadId || pending.sessionKey !== key) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} expired.`, "The active chat changed."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    if (this.commandBusy(message.conversationId, workspace.name, status)) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Codex is busy.", "Wait for the current work to finish and run the command again."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} in progress.`), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    if (command === "compact") {
      if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver cannot compact threads.");
      const result = await this.deps.agent.runBuiltinCommand(key, { type: "compact" });
      await this.deps.renderCallbackPage(message, messageWithTitle(result.message), { inline_keyboard: [] });
      return;
    }
    if (command === "archive") {
      if (!this.deps.agent.archiveThread) throw new Error("Agent driver cannot archive threads.");
      await this.deps.agent.archiveThread(key);
    } else {
      if (!this.deps.agent.deleteThread) throw new Error("Agent driver cannot delete threads.");
      await this.deps.agent.deleteThread(key);
    }
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.deletePendingPromptsForSession(key);
    this.deps.clearCodexPromptsForSession(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    await this.deps.renderCallbackPage(message, messageWithTitle(command === "archive" ? "Chat archived." : "Chat deleted."), { inline_keyboard: [] });
  }

  private async resumeFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    rawIndex: string | undefined,
  ): Promise<void> {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) throw new Error("Resume thread is missing.");
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const selected = asPromptRecord(threads[index]);
    const threadId = typeof selected?.id === "string" ? selected.id : undefined;
    if (!threadId) throw new Error("Resume selection expired.");
    const threadName = typeof selected?.name === "string" ? selected.name : threadId;
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    if (this.commandBusy(message.conversationId, workspace.name, this.deps.agent.getStatus(key))) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Codex is busy.", "The current chat was not changed."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Resuming chat.", threadName), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.deletePendingPromptsForSession(key);
    this.deps.clearCodexPromptsForSession(key);
    this.deps.store.markSessionStopped(key);
    const status = await this.deps.ensureAgentStarted(message.conversationId, workspace, threadId);
    this.deps.store.setSessionThreadId(key, status.threadId ?? threadId);
    await this.deps.renderCallbackPage(message, messageWithTitle("Resumed chat.", status.threadName ?? status.threadId ?? threadId), { inline_keyboard: [] });
  }

  async sendPlanReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    await this.plans.sendReadyPrompt(sessionKeyValue, completedTurnId);
  }

  private commandBusy(conversationId: ConversationId, workspaceName: string, status: AgentSessionStatus | undefined): boolean {
    return Boolean(status && this.sessionBusy(status))
      || this.deps.store.countTasks(conversationId, workspaceName, ["waiting", "queued", "running", "blocked"]) > 0;
  }

  async answerRelayCommandPrompt(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
      return;
    }
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    if (data.command === "rename") {
      await this.renameCurrentThread(conversationId, text.trim());
      return;
    }
    if (data.command === "side") {
      await this.runSideConversation(conversationId, text.trim(), promptMessageId);
      return;
    }
    if (data.command === "attachment_task") {
      const workspace = this.deps.requireCurrentWorkspace(conversationId);
      const key = sessionKey(conversationId, workspace.name);
      const status = this.deps.agent.getStatus(key);
      const attachment = parseAttachmentRecord(data.attachment);
      if (!status?.running || pending.sessionKey !== key || status.threadId !== data.threadId || !attachment || this.commandBusy(conversationId, workspace.name, status)) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment task expired.", "The active chat changed or Codex is busy. Run the command again."));
        return;
      }
      if (attachment.type === "mention" && !isWorkspaceMentionPath(workspace.path, attachment.path)) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment rejected.", "The selected path is outside the workspace."));
        return;
      }
      const prompt = text.trim();
      if (!prompt) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment not submitted.", "The task description must not be empty."));
        return;
      }
      await this.deps.submitTask(conversationId, prompt, promptMessageId, "immediate", { text: prompt, attachments: [attachment] });
      return;
    }
    if (data.command === "goal_edit") {
      await this.goals.answerEdit(conversationId, pending, data, text);
      return;
    }
    await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
