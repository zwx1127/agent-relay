import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  AgentBuiltinCommand,
  AgentDriver,
  AgentInputAttachment,
  AgentSessionStatus,
  AgentTaskInput,
} from "../ports/agent.ts";
import type { InboundMessage, InlineKeyboardMarkup, SendMessageOptions, ImAdapter } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import type { Logger } from "../domain/logger.ts";
import type { RelayStore } from "../storage/store.ts";
import type { PendingPrompt, TaskStatus, WorkspaceRecord } from "./types.ts";
import { CODEX_PROMPT_TTL_MS, LIST_PAGE_SIZE } from "./ui/constants.ts";
import { shortToken } from "./ui/callback-data.ts";
import { commandArgs, parseReviewTarget } from "./ui/commands.ts";
import { attachmentPickerKeyboard, backgroundTerminalsKeyboard, commandConfirmKeyboard, planReadyKeyboard, resumeKeyboard } from "./ui/keyboards.ts";
import {
  formatBackgroundTerminalsMessage,
  formatGoalClearedMessage,
  formatGoalMessage,
  formatGoalUpdatedMessage,
  formatResumeMessage,
} from "./ui/messages.ts";
import { asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import { pathContains } from "./ui/media-format.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface ThreadCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "deleteMessage">;
  logger: Logger;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string, options?: { resumePrevious?: boolean }): Promise<AgentSessionStatus>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  clearActivityForSession(sessionKey: string): void;
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
  private readonly interruptedPlanTurns = new Set<string>();

  constructor(private readonly deps: ThreadCommandDeps) {}

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
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
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

  async goalCommand(conversationId: ConversationId, args: string): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    const normalized = args.trim();
    if (!this.deps.agent.getThreadGoal || !this.deps.agent.setThreadGoal || !this.deps.agent.clearThreadGoal) {
      throw new Error("Agent driver does not support thread goals.");
    }

    if (!normalized) {
      await this.deps.sendRendered(conversationId, formatGoalMessage(await this.deps.agent.getThreadGoal(key)));
      return;
    }

    if (normalized.toLowerCase() === "edit") {
      const current = await this.deps.agent.getThreadGoal(key);
      if (!current) {
        await this.deps.sendRendered(conversationId, messageWithTitle("No goal to edit.", "Set one with /goal <objective>."));
        return;
      }
      const result = await this.deps.sendRendered(conversationId, messageWithTitle("Edit goal", `Current objective: ${current.objective}`), {
        forceReply: true,
        forceReplyInstruction: "Reply with the new goal objective.",
        inputFieldPlaceholder: "New goal objective",
      });
      if (!result.messageId) throw new Error("IM adapter did not return a goal edit prompt message id.");
      this.deps.store.setPendingPrompt({
        conversationId,
        promptMessageId: result.messageId,
        kind: "relay_command",
        createdAt: Date.now(),
        sessionKey: key,
        payloadJson: JSON.stringify({ command: "goal_edit", threadId: this.deps.agent.getStatus(key)?.threadId }),
        expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
      });
      return;
    }

    switch (normalized.toLowerCase()) {
      case "pause": {
        const goal = await this.deps.agent.setThreadGoal(key, { status: "paused" });
        await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
        return;
      }
      case "resume": {
        const goal = await this.deps.agent.setThreadGoal(key, { status: "active" });
        await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
        return;
      }
      case "clear": {
        await this.deps.sendRendered(conversationId, formatGoalClearedMessage(await this.deps.agent.clearThreadGoal(key)));
        return;
      }
    }

    validateGoalObjective(normalized);
    const current = await this.deps.agent.getThreadGoal(key);
    if (current) {
      await this.deps.sendRendered(conversationId, messageWithTitle("A goal is already set.", "Use /goal edit to revise it, or /goal clear first."));
      return;
    }

    const goal = await this.deps.agent.setThreadGoal(key, { objective: normalized, status: "active", tokenBudget: null });
    await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
  }

  async cleanBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.cleanBackgroundTerminals) throw new Error("Agent driver cannot clean background terminals.");
    await this.deps.agent.cleanBackgroundTerminals(key);
    this.deps.logger.info("router.background_terminals_cleaned", { conversation_id: conversationId, session_key: key });
    await this.deps.sendRendered(conversationId, messageWithTitle("Background terminals stopped."));
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
        this.interruptedPlanTurns.add(`${key}:${result.turnId}`);
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
      this.interruptedPlanTurns.add(`${key}:${result.turnId}`);
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
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.listBackgroundTerminals) throw new Error("Agent driver cannot list background terminals.");
    const terminals = await this.deps.agent.listBackgroundTerminals(key);
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatBackgroundTerminalsMessage(terminals), {
      replyMarkup: backgroundTerminalsKeyboard(token, terminals),
    });
    if (result.messageId && terminals.length > 0) {
      this.deps.store.setPendingPrompt({
        conversationId,
        promptMessageId: result.messageId,
        kind: "relay_command",
        createdAt: Date.now(),
        sessionKey: key,
        payloadJson: JSON.stringify({ command: "terminal", token, threadId: this.deps.agent.getStatus(key)?.threadId, terminals }),
        expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
      });
    }
  }

  async renderSkillPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.listSkills) throw new Error("Agent driver cannot list skills.");
    const query = searchTerm.trim().toLocaleLowerCase();
    const skills = (await this.deps.agent.listSkills(workspace.path))
      .filter((skill) => skill.enabled)
      .filter((skill) => !query || `${skill.name} ${skill.description ?? ""} ${skill.shortDescription ?? ""}`.toLocaleLowerCase().includes(query))
      .map((skill) => ({ label: skill.name, type: "skill" as const, name: skill.name, path: skill.path }));
    await this.renderAttachmentPicker(conversationId, key, status.threadId, "skill", skills, searchTerm);
  }

  async renderMentionPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.searchFiles) throw new Error("Agent driver cannot search workspace files.");
    const results = await this.deps.agent.searchFiles(workspace.path, searchTerm.trim(), { limit: 100 });
    const entries = results.flatMap((file) => {
      const path = resolve(file.root, file.path);
      if (!isWorkspaceMentionPath(workspace.path, path)) return [];
      return [{ label: file.path, type: "mention" as const, name: file.fileName || basename(path), path }];
    });
    await this.renderAttachmentPicker(conversationId, key, status.threadId, "mention", entries, searchTerm);
  }

  private async renderAttachmentPicker(
    conversationId: ConversationId,
    key: string,
    threadId: string | undefined,
    kind: "skill" | "mention",
    entries: Array<{ label: string; type: "skill" | "mention"; name: string; path: string }>,
    searchTerm: string,
  ): Promise<void> {
    if (entries.length === 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle(kind === "skill" ? "No matching skills." : "No matching files.", searchTerm ? `Search: ${searchTerm}` : undefined));
      return;
    }
    const token = shortToken();
    const pageIndex = 0;
    const totalPages = Math.ceil(entries.length / LIST_PAGE_SIZE);
    const pageEntries = entries.slice(0, LIST_PAGE_SIZE);
    const result = await this.deps.sendRendered(conversationId, attachmentPickerMessage(kind, searchTerm, pageIndex, totalPages), {
      replyMarkup: attachmentPickerKeyboard(token, pageEntries, pageIndex, totalPages),
    });
    if (!result.messageId) throw new Error("IM adapter did not return an attachment picker message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "attachment_select", token, kind, searchTerm, pageIndex, threadId, entries }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
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
      await this.attachmentFromCallback(message, pending, data, action);
      return;
    }

    if (command === "terminal") {
      await this.stopTerminalFromCallback(message, pending, data, action);
      return;
    }

    if (command === "resume") {
      await this.resumeFromCallback(message, pending, data, action);
      return;
    }
    if (command === "plan") {
      await this.planFromCallback(message, pending, data, action);
      return;
    }
    throw new Error("Unknown command callback.");
  }

  private async attachmentFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    if (data.command !== "attachment_select" || !action) {
      await this.deps.expireCallbackPrompt(message);
      return;
    }
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || pending.sessionKey !== key || status.threadId !== data.threadId || this.commandBusy(message.conversationId, workspace.name, status)) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Attachment selection expired.", "The active chat changed or Codex is busy."), { inline_keyboard: [] });
      return;
    }
    const entries = Array.isArray(data.entries) ? data.entries.map(asPromptRecord).filter(Boolean) as Record<string, unknown>[] : [];
    const kind = data.kind === "skill" ? "skill" : "mention";
    if (action.startsWith("p")) {
      const requestedPage = Number(action.slice(1));
      const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
      const pageIndex = Math.min(totalPages - 1, Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0));
      const page = entries.slice(pageIndex * LIST_PAGE_SIZE, (pageIndex + 1) * LIST_PAGE_SIZE).map((entry) => ({ label: typeof entry.label === "string" ? entry.label : "Attachment" }));
      await this.deps.renderStrictCallbackPage(
        message,
        attachmentPickerMessage(kind, typeof data.searchTerm === "string" ? data.searchTerm : "", pageIndex, totalPages),
        attachmentPickerKeyboard(String(data.token), page, pageIndex, totalPages),
      );
      this.deps.store.setPendingPrompt({ ...pending, payloadJson: JSON.stringify({ ...data, pageIndex }) });
      return;
    }
    if (!action.startsWith("i")) throw new Error("Attachment selection is unavailable.");
    const index = Number(action.slice(1));
    const selected = entries[index];
    const name = typeof selected?.name === "string" ? selected.name : undefined;
    const path = typeof selected?.path === "string" ? selected.path : undefined;
    if (!name || !path) throw new Error("Attachment selection expired.");
    if (kind === "mention" && !isWorkspaceMentionPath(workspace.path, path)) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Attachment rejected.", "The selected path is outside the workspace."), { inline_keyboard: [] });
      return;
    }
    const attachment: AgentInputAttachment = { type: kind, name, path };
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${kind === "skill" ? "Skill" : "File"} selected.`, name), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    const promptToken = shortToken();
    const result = await this.deps.sendRendered(message.conversationId, messageWithTitle("What should Codex do?", `${kind === "skill" ? "Skill" : "Mention"}: ${name}`), {
      forceReply: true,
      forceReplyInstruction: "Reply with the task for this attachment.",
      inputFieldPlaceholder: "Task description",
    });
    if (!result.messageId) throw new Error("IM adapter did not return an attachment prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "attachment_task", token: promptToken, threadId: status.threadId, attachment }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
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

  private async stopTerminalFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const index = Number(action);
    const terminals = Array.isArray(data.terminals) ? data.terminals : [];
    const selected = asPromptRecord(terminals[index]);
    const processId = typeof selected?.processId === "string" ? selected.processId : undefined;
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!processId || !status?.running || status.threadId !== data.threadId || pending.sessionKey !== key || !this.deps.agent.terminateBackgroundTerminal) {
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.renderBackgroundTerminals(message.conversationId);
      return;
    }
    const terminated = await this.deps.agent.terminateBackgroundTerminal(key, processId);
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    if (!terminated) {
      await this.renderBackgroundTerminals(message.conversationId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Background terminal stopped."), { inline_keyboard: [] });
    await this.renderBackgroundTerminals(message.conversationId);
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

  private async planFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    if (pending.sessionKey && pending.sessionKey !== key) {
      this.deps.logger.info("router.plan_callback_expired", {
        conversation_id: message.conversationId,
        session_key: pending.sessionKey,
        reason: "session_mismatch",
      });
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Plan action expired.", "Open the latest Plan ready card."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    if (action === "implement") {
      const status = this.deps.agent.getStatus(key);
      if (!status?.running) {
        this.deps.logger.info("router.plan_callback_expired", {
          conversation_id: message.conversationId,
          session_key: key,
          reason: "session_not_running",
        });
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
      if (this.sessionBusy(status) || this.deps.hasTaskCreatedAfter(message.conversationId, workspace.name, pending.createdAt)) {
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
    await this.dismissPlanReadyPrompt(message);
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
  }

  private async dismissPlanReadyPrompt(message: CallbackMessage): Promise<void> {
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

  async sendPlanReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    if (completedTurnId && this.interruptedPlanTurns.delete(`${sessionKeyValue}:${completedTurnId}`)) return;
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
      const workspace = this.deps.requireCurrentWorkspace(conversationId);
      const key = sessionKey(conversationId, workspace.name);
      const status = this.deps.agent.getStatus(key);
      if (!status?.running || (typeof data.threadId === "string" && status.threadId !== data.threadId) || pending.sessionKey !== key) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Goal edit expired.", "Open the current goal and try again."));
        return;
      }
      const objective = text.trim();
      validateGoalObjective(objective);
      if (!this.deps.agent.setThreadGoal) throw new Error("Agent driver does not support thread goals.");
      await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(await this.deps.agent.setThreadGoal(key, { objective })));
      return;
    }
    await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
  }
}

function validateGoalObjective(objective: string): void {
  if (!objective) throw new Error("Goal objective must not be empty.");
  if (objective.length > 4_000) throw new Error("Goal objective must not exceed 4,000 characters.");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function attachmentPickerMessage(kind: "skill" | "mention", searchTerm: string, pageIndex: number, totalPages: number): RenderedTelegramText {
  const target = kind === "skill" ? "skill" : "file or directory";
  return messageWithTitle(`Select a ${target}.`, `${searchTerm ? `Search: ${searchTerm}\n` : ""}Page ${pageIndex + 1}/${totalPages}`);
}

function parseAttachmentRecord(value: unknown): AgentInputAttachment | undefined {
  const record = asPromptRecord(value);
  if (!record || (record.type !== "skill" && record.type !== "mention") || typeof record.name !== "string" || typeof record.path !== "string") return undefined;
  return { type: record.type, name: record.name, path: record.path };
}

function isWorkspaceMentionPath(workspacePath: string, candidatePath: string): boolean {
  try {
    return pathContains(realpathSync(workspacePath), realpathSync(resolve(candidatePath)));
  } catch {
    return false;
  }
}
