import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentBuiltinCommand,
  AgentCollaborationMode,
  AgentDriver,
  AgentSessionStatus,
  AgentTaskInput,
  AgentThreadGoal,
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
import { goalReplaceKeyboard, planReadyKeyboard, resumeKeyboard } from "./ui/keyboards.ts";
import {
  formatBackgroundTerminalsMessage,
  formatGoalClearedMessage,
  formatGoalMessage,
  formatGoalReplaceMessage,
  formatGoalUpdatedMessage,
  formatResumeMessage,
} from "./ui/messages.ts";
import { asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface ThreadCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "deleteMessage">;
  logger: Logger;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string, options?: { resumePrevious?: boolean }): Promise<AgentSessionStatus>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  cancelActiveTasks(sessionKey: string): Promise<void>;
  interruptActiveTasks(sessionKey: string): Promise<void>;
  interruptTasksByStatus(sessionKey: string, statuses: TaskStatus[]): Promise<void>;
  submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference?: TaskSubmitPreference, input?: AgentTaskInput): Promise<void>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<void>;
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
    if (this.sessionBusy(status)) {
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

  async startFreshThread(conversationId: ConversationId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.deps.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    this.deps.store.setCollaborationMode(key, "default");
    await this.deps.sendRendered(conversationId, messageWithTitle("Started a new chat.", `Thread: ${status.threadName ?? status.threadId ?? "new"}`));
  }

  async renderResumePicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
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
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.forkThread) throw new Error("Agent driver cannot fork threads.");
    const result = await this.deps.agent.forkThread(key);
    await this.deps.cancelActiveTasks(key);
    this.deps.store.setSessionThreadId(key, result.threadId);
    await this.deps.sendRendered(conversationId, messageWithTitle("Forked chat.", `Thread: ${result.threadName ?? result.threadId}`));
    this.deps.logger.info("router.thread_forked", { conversation_id: conversationId, workspace: workspace.name, thread_id: result.threadId });
  }

  async renameCommand(conversationId: ConversationId, name: string): Promise<void> {
    if (name.trim()) {
      await this.renameCurrentThread(conversationId, name.trim());
      return;
    }
    const result = await this.deps.sendRendered(conversationId, textMessage("Reply with the new chat name."), {
      forceReply: true,
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
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    const key = sessionKey(conversationId, workspace.name);
    const current = this.deps.store.getCollaborationMode(key);
    if (!prompt.trim()) {
      const next: AgentCollaborationMode = current === "plan" ? "default" : "plan";
      this.deps.store.setCollaborationMode(key, next);
      await this.deps.sendRendered(conversationId, messageWithTitle(next === "plan" ? "Plan mode enabled." : "Plan mode disabled."));
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

    const current = await this.deps.agent.getThreadGoal(key);
    if (current) {
      await this.promptGoalReplace(conversationId, key, current, normalized);
      return;
    }

    const goal = await this.deps.agent.setThreadGoal(key, { objective: normalized, status: "active", tokenBudget: null });
    await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
  }

  private async promptGoalReplace(conversationId: ConversationId, key: string, current: AgentThreadGoal, objective: string): Promise<void> {
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatGoalReplaceMessage(current, objective), {
      replyMarkup: goalReplaceKeyboard(token),
    });
    if (!result.messageId) return;
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "goal", token, objective }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
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
    if (!status?.running || !status.activeTurnId) {
      await this.deps.sendRendered(conversationId, messageWithTitle("No active Codex turn to interrupt."));
      return;
    }
    if (!this.deps.agent.interrupt) throw new Error("Agent driver cannot interrupt turns.");

    await this.deps.finalizeSessionOutput(key);
    const result = await this.deps.agent.interrupt(key);
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
    await this.deps.sendRendered(conversationId, formatBackgroundTerminalsMessage(terminals));
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
      await this.deps.expireCallbackPrompt(message);
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
    if (command === "goal") {
      await this.goalFromCallback(message, pending, data, action);
      return;
    }
    throw new Error("Unknown command callback.");
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
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.deps.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    const status = await this.deps.ensureAgentStarted(message.conversationId, workspace, threadId);
    this.deps.store.setSessionThreadId(key, status.threadId ?? threadId);
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.deps.renderCallbackPage(message, messageWithTitle("Resumed chat.", status.threadName ?? status.threadId ?? threadId), { inline_keyboard: [] });
  }

  private async planFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    _data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    if (pending.sessionKey && pending.sessionKey !== key) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      this.deps.logger.info("router.plan_callback_expired", {
        conversation_id: message.conversationId,
        session_key: pending.sessionKey,
        reason: "session_mismatch",
      });
      await this.deps.renderCallbackPage(message, messageWithTitle("Plan action expired.", "Open the latest Plan ready card."), { inline_keyboard: [] });
      return;
    }
    if (action === "implement") {
      const status = this.deps.agent.getStatus(key);
      if (!status?.running) {
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        this.deps.logger.info("router.plan_callback_expired", {
          conversation_id: message.conversationId,
          session_key: key,
          reason: "session_not_running",
        });
        await this.deps.renderCallbackPage(message, messageWithTitle("Plan action expired.", "The Codex session is no longer running."), { inline_keyboard: [] });
        return;
      }
      if (this.sessionBusy(status) || this.deps.hasTaskCreatedAfter(message.conversationId, workspace.name, pending.createdAt)) {
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        this.deps.logger.info("router.plan_callback_busy", {
          conversation_id: message.conversationId,
          session_key: key,
          active_turn_id: status.activeTurnId,
          waiting_for_approval: status.waitingForApproval,
          waiting_for_user_input: status.waitingForUserInput,
        });
        await this.deps.renderCallbackPage(message, messageWithTitle("Plan action expired.", "A newer turn is already active or has been submitted."), { inline_keyboard: [] });
        return;
      }
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      this.deps.store.setCollaborationMode(key, "default");
      this.deps.logger.info("router.plan_callback_implemented", { conversation_id: message.conversationId, session_key: key });
      await this.deps.renderCallbackPage(message, messageWithTitle("Implementing plan."), { inline_keyboard: [] });
      await this.deps.submitTask(message.conversationId, "Implement the approved plan.", message.messageId, "immediate");
      return;
    }
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.dismissPlanReadyPrompt(message);
  }

  private async goalFromCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const objective = typeof data.objective === "string" ? data.objective : undefined;
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);

    if (pending.sessionKey && pending.sessionKey !== key) {
      await this.deps.renderCallbackPage(message, messageWithTitle("Goal action expired.", "Open the latest goal card."), { inline_keyboard: [] });
      return;
    }
    if (action !== "replace") {
      await this.deps.renderCallbackPage(message, messageWithTitle("Goal unchanged."), { inline_keyboard: [] });
      return;
    }
    if (!objective) throw new Error("Goal objective is missing.");
    if (!this.deps.agent.setThreadGoal) throw new Error("Agent driver does not support thread goals.");

    const goal = await this.deps.agent.setThreadGoal(key, { objective, status: "active", tokenBudget: null });
    await this.deps.renderCallbackPage(message, formatGoalUpdatedMessage(goal), { inline_keyboard: [] });
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
    await this.deps.renderCallbackPage(message, textMessage(""), { inline_keyboard: [] });
  }

  async sendPlanReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    if (completedTurnId && this.interruptedPlanTurns.delete(`${sessionKeyValue}:${completedTurnId}`)) return;
    const token = shortToken();
    const result = await this.deps.sendRendered(parsed.conversationId, messageWithTitle("Plan ready.", "Choose whether to implement it now or keep refining the plan."), {
      replyMarkup: planReadyKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) return;
    this.deps.logger.info("router.plan_ready_prompt_sent", {
      conversation_id: parsed.conversationId,
      session_key: sessionKeyValue,
      turn_id: completedTurnId,
      prompt_message_id: result.messageId,
    });
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify({ command: "plan", token, completedTurnId }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
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
    await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
  }
}
