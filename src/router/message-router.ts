import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import { isAuthorized } from "../config.ts";
import { sessionKey } from "../agent.ts";
import { parseSessionKey } from "./session.ts";
import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentBuiltinCommand,
  AgentCollaborationMode,
  AgentDriver,
  AgentOutputEvent,
  AgentReviewTarget,
  AgentSessionStatus,
  AgentThreadSummary,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
  ChatId,
  HomeStatusMode,
  IMAdapter,
  InboundMessage,
  InlineKeyboardMarkup,
  RelayTask,
  SendMessageOptions,
  WorkspaceRecord,
} from "../types.ts";
import type { Store } from "../storage/store.ts";
import { createWorkspace, discoverWorkspaceDirectories, isRealDirectory, resolveWorkspacePath, validateWorkspaceName, workspaceDirectoryExists } from "../workspace.ts";
import { appendRendered, contextUsageBar, renderCodexMarkdownForTelegram, renderTelegramText, splitRenderedForTelegram, truncateForTelegramLabel, type RenderedTelegramText, type StatusView, type TelegramTextPart } from "../rendering/telegram-text.ts";
import { noopLogger, type Logger } from "../logger.ts";

const CALLBACK_PREFIX = "ar:";
const CALLBACK_LIMIT_BYTES = 64;
const STREAM_QUIET_MS = 800;
const STREAM_MAX_MS = 3000;
const STREAM_FLUSH_CHARS = 3400;
const CODEX_PROMPT_TTL_MS = 30 * 60 * 1000;
const PAGE_MAX_CHARS = 3200;
const PAGED_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE = 8;
const WORKSPACE_BUTTON_LABEL_WIDTH = 40;
const UI_BUTTON = {
  workspace: "📂",
  status: "ℹ️",
  refresh: "🔄",
  stop: "🛑",
  create: "🆕",
  delete: "🗑️",
  approve: "✅",
  deny: "❎",
  firstPage: "⏮️",
  previousPage: "◀️",
  nextPage: "▶️",
  lastPage: "⏭️",
  selected: "✅",
  unselected: "▫️",
} as const;

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<IMAdapter, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction" | "setMessageReaction">;
  agent: AgentDriver;
  logger?: Logger;
}

interface LiveOutputState {
  chatId: ChatId;
  text: string;
  startedAt: number;
  segmentId: number;
  turnId?: string;
  replyToMessageId?: number;
  timer?: Timer;
  messageId?: number;
  pageToken?: string;
  lastFlushedText?: string;
  flushPromise?: Promise<void>;
  finalPageRendered?: boolean;
}

export class MessageRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: RouterDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async handle(message: InboundMessage): Promise<void> {
    if (message.kind === "callback_query") {
      await this.handleCallback(message);
      return;
    }

    const text = message.text.trim();
    const command = text.startsWith("/") ? commandName(text) : undefined;
    this.logger.info("router.message_received", {
      chat_id: message.chatId,
      user_id: message.userId,
      message_id: message.id,
      text_len: message.text.length,
      command,
    });
    this.logger.debug("router.message_text", {
      chat_id: message.chatId,
      user_id: message.userId,
      message_id: message.id,
      message_text: message.text,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.chatId)) {
      this.logger.warn("router.unauthorized_message", {
        chat_id: message.chatId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.sendRendered(message.chatId, textMessage("Unauthorized."));
      return;
    }

    try {
      const pending = message.replyToMessageId
        ? this.deps.store.getPendingPrompt(message.chatId, message.replyToMessageId)
        : undefined;
      if (pending?.kind === "workspace_name") {
        await this.createWorkspaceFromPrompt(message.chatId, message.replyToMessageId!, text);
      } else if (pending?.kind === "codex_user_input") {
        await this.answerCodexFreeText(message.chatId, message.replyToMessageId!, text);
      } else if (pending?.kind === "relay_command") {
        await this.answerRelayCommandPrompt(message.chatId, message.replyToMessageId!, text);
      } else if (command === "/relay") {
        await this.renderConsole(message.chatId);
      } else if (command && await this.handleSlashCommand(message, command, text)) {
        return;
      } else {
        await this.submitTask(message.chatId, text, message.messageId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("router.message_failed", {
        chat_id: message.chatId,
        user_id: message.userId,
        message_id: message.id,
        command,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.sendRendered(message.chatId, formatErrorMessage(detail));
      this.appendSystem(message.chatId, `Error: ${detail}\n`);
    }
  }

  async handleAgentOutput(session: AgentOutputEvent): Promise<void> {
    if (session.type === "turn_completed") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.sendPlanReadyPrompt(session.sessionKey);
      await this.completeTaskAndDispatchNext(session.sessionKey, session.turnId);
      return;
    }
    if (session.type === "user_input_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked");
      await this.handleCodexUserInputRequest(session);
      return;
    }
    if (session.type === "approval_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked");
      await this.handleCodexApprovalRequest(session);
      return;
    }
    const parsed = parseSessionKey(session.sessionKey);
    if (!parsed) {
      this.logger.warn("router.agent_output_invalid_session", { session_key: session.sessionKey, chunk_len: session.chunk.length });
      return;
    }
    this.logger.debug("router.agent_output_received", {
      session_key: session.sessionKey,
      chat_id: parsed.chatId,
      workspace: parsed.workspaceName,
      chunk_len: session.chunk.length,
      agent_chunk: session.chunk,
    });
    this.deps.store.appendTranscript({
      chatId: parsed.chatId,
      workspaceName: parsed.workspaceName,
      role: "agent",
      text: session.chunk,
      createdAt: Date.now(),
    });
    await this.bufferAgentOutput(session.sessionKey, parsed.chatId, session.chunk, session.turnId);
  }

  async handleAgentExit(sessionKeyValue: string, exitText: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) {
      this.logger.warn("router.agent_exit_invalid_session", { session_key: sessionKeyValue });
      return;
    }
    this.logger.info("router.agent_exit", {
      session_key: sessionKeyValue,
      chat_id: parsed.chatId,
      workspace: parsed.workspaceName,
    });
    this.deps.store.markSessionStopped(sessionKeyValue);
    await this.finalizeSessionOutput(sessionKeyValue);
    await this.sendRendered(parsed.chatId, messageWithTitle(exitText));
  }

  private async handleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    this.logger.info("router.callback_received", {
      chat_id: message.chatId,
      user_id: message.userId,
      callback_query_id: message.callbackQueryId,
      data: message.data,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.chatId)) {
      this.logger.warn("router.unauthorized_callback", {
        chat_id: message.chatId,
        user_id: message.userId,
        callback_query_id: message.callbackQueryId,
      });
      await this.answerCallback(message.callbackQueryId, "Unauthorized.");
      return;
    }

    try {
      await this.routeCallback(message);
      await this.answerCallback(message.callbackQueryId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("router.callback_failed", {
        chat_id: message.chatId,
        user_id: message.userId,
        callback_query_id: message.callbackQueryId,
        data: message.data,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.answerCallback(message.callbackQueryId, detail.slice(0, 180));
      await this.renderCallbackPage(message, formatErrorMessage(detail), consoleKeyboard(this.statusView(message.chatId)));
      this.appendSystem(message.chatId, `Error: ${detail}\n`);
    }
  }

  private async routeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (!message.data.startsWith(CALLBACK_PREFIX)) throw new Error("Unknown callback.");
    const payload = message.data.slice(CALLBACK_PREFIX.length);
    if (this.isStaleConsoleCallback(message, payload)) {
      await this.renderCallbackPage(message, messageWithTitle("Stale Relay Home.", "Open the latest Relay Home."), { inline_keyboard: [[{ text: UI_BUTTON.refresh, callback_data: "ar:home" }]] });
      return;
    }

    if (payload === "home") {
      await this.renderConsole(message.chatId);
      return;
    }
    if (payload === "s") {
      await this.renderHomeCallback(message);
      return;
    }
    if (payload === "w") {
      await this.renderWorkspacesCallback(message, 0);
      return;
    }
    if (payload === "n") {
      await this.promptForWorkspaceName(message.chatId);
      return;
    }
    if (payload === "status") {
      await this.toggleStatusModeCallback(message);
      return;
    }
    if (payload.startsWith("a:")) {
      await this.answerCodexApproval(message, payload);
      return;
    }
    if (payload.startsWith("p:")) {
      await this.renderPagedOutputCallback(message, payload);
      return;
    }
    if (payload.startsWith("cmd:")) {
      await this.handleCommandCallback(message, payload);
      return;
    }
    if (payload.startsWith("wl:")) {
      await this.renderWorkspacesCallback(message, Number(payload.slice("wl:".length)));
      return;
    }
    if (payload === "stop") {
      await this.stopFromCallback(message);
      return;
    }
    if (payload.startsWith("wd?:")) {
      await this.confirmDeleteWorkspaceCallback(message, payload.slice("wd?:".length));
      return;
    }
    if (payload.startsWith("wd!:")) {
      await this.deleteWorkspaceCallback(message, payload.slice("wd!:".length));
      return;
    }
    if (payload.startsWith("uh:")) {
      const token = payload.slice("uh:".length);
      await this.selectWorkspaceFromToken(message, token);
      return;
    }

    throw new Error("Unknown callback.");
  }

  private async handleSlashCommand(message: Extract<InboundMessage, { kind: "message" }>, command: string, text: string): Promise<boolean> {
    switch (command) {
      case "/review":
        await this.runReviewCommand(message.chatId, text);
        return true;
      case "/compact":
        await this.runBuiltinCommand(message.chatId, { type: "compact" });
        return true;
      case "/init":
        await this.runInitCommand(message.chatId, message.messageId);
        return true;
      case "/new":
      case "/clear":
        await this.startFreshThread(message.chatId);
        return true;
      case "/resume":
        await this.renderResumePicker(message.chatId, commandArgs(text));
        return true;
      case "/fork":
        await this.forkCurrentThread(message.chatId);
        return true;
      case "/rename":
        await this.renameCommand(message.chatId, commandArgs(text));
        return true;
      case "/plan":
        await this.planCommand(message.chatId, commandArgs(text), message.messageId);
        return true;
      case "/stop":
        await this.cleanBackgroundTerminals(message.chatId);
        return true;
      default:
        return false;
    }
  }

  private async runReviewCommand(chatId: ChatId, text: string): Promise<void> {
    const target = parseReviewTarget(commandArgs(text));
    await this.runBuiltinCommand(chatId, { type: "review", target });
  }

  private async runBuiltinCommand(chatId: ChatId, command: AgentBuiltinCommand): Promise<void> {
    const { workspace, status, key } = await this.commandSession(chatId);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(chatId);
      return;
    }
    if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver does not support this command.");
    const result = await this.deps.agent.runBuiltinCommand(key, command);
    if (result.threadId && result.threadId !== status.threadId) this.deps.store.setSessionThreadId(key, result.threadId);
    this.logger.info("router.builtin_command_started", { chat_id: chatId, workspace: workspace.name, command: command.type });
    await this.sendRendered(chatId, messageWithTitle(result.message));
  }

  private async runInitCommand(chatId: ChatId, userMessageId?: number): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    if (existsSync(join(workspace.path, "AGENTS.md"))) {
      await this.sendRendered(chatId, messageWithTitle("AGENTS.md already exists.", "Skipping /init to avoid overwriting it."));
      return;
    }
    await this.submitTask(chatId, "Generate a file named AGENTS.md that serves as a contributor guide for this repository.", userMessageId, "immediate");
  }

  private async startFreshThread(chatId: ChatId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const key = sessionKey(chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    const status = await this.ensureAgentStarted(chatId, workspace);
    this.deps.store.setCollaborationMode(key, "default");
    await this.sendRendered(chatId, messageWithTitle("Started a new chat.", `Thread: ${status.threadName ?? status.threadId ?? "new"}`));
  }

  private async renderResumePicker(chatId: ChatId, searchTerm: string): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    if (!this.deps.agent.listThreads) throw new Error("Agent driver cannot list threads.");
    const threads = await this.deps.agent.listThreads({
      workspacePath: workspace.path,
      limit: LIST_PAGE_SIZE,
      ...(searchTerm ? { searchTerm } : {}),
    });
    if (threads.length === 0) {
      await this.sendRendered(chatId, messageWithTitle("No saved chats found."));
      return;
    }
    const token = shortToken();
    const result = await this.sendRendered(chatId, formatResumeMessage(threads), {
      replyMarkup: resumeKeyboard(token, threads),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a resume picker message id.");
    this.deps.store.setPendingPrompt({
      chatId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "resume", token, threads: threads.map((thread) => ({ id: thread.id, name: thread.name })) }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async forkCurrentThread(chatId: ChatId): Promise<void> {
    const { workspace, status, key } = await this.commandSession(chatId);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(chatId);
      return;
    }
    if (!this.deps.agent.forkThread) throw new Error("Agent driver cannot fork threads.");
    const result = await this.deps.agent.forkThread(key);
    this.deps.store.setSessionThreadId(key, result.threadId);
    await this.sendRendered(chatId, messageWithTitle("Forked chat.", `Thread: ${result.threadName ?? result.threadId}`));
    this.logger.info("router.thread_forked", { chat_id: chatId, workspace: workspace.name, thread_id: result.threadId });
  }

  private async renameCommand(chatId: ChatId, name: string): Promise<void> {
    if (name.trim()) {
      await this.renameCurrentThread(chatId, name.trim());
      return;
    }
    const result = await this.sendRendered(chatId, textMessage("Reply with the new chat name."), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a rename prompt message id.");
    this.deps.store.setPendingPrompt({
      chatId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "rename" }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async renameCurrentThread(chatId: ChatId, name: string): Promise<void> {
    const { key } = await this.commandSession(chatId);
    if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
    await this.deps.agent.renameThread(key, name);
    await this.sendRendered(chatId, messageWithTitle("Renamed chat.", name));
  }

  private async planCommand(chatId: ChatId, prompt: string, userMessageId?: number): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const status = await this.ensureAgentStarted(chatId, workspace);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(chatId);
      return;
    }
    const key = sessionKey(chatId, workspace.name);
    const current = this.deps.store.getCollaborationMode(key);
    if (!prompt.trim()) {
      const next: AgentCollaborationMode = current === "plan" ? "default" : "plan";
      this.deps.store.setCollaborationMode(key, next);
      await this.sendRendered(chatId, messageWithTitle(next === "plan" ? "Plan mode enabled." : "Plan mode disabled."));
      return;
    }
    this.deps.store.setCollaborationMode(key, "plan");
    await this.submitTask(chatId, prompt.trim(), userMessageId, "immediate");
  }

  private async cleanBackgroundTerminals(chatId: ChatId): Promise<void> {
    const { key } = await this.commandSession(chatId);
    if (!this.deps.agent.cleanBackgroundTerminals) throw new Error("Agent driver cannot clean background terminals.");
    await this.deps.agent.cleanBackgroundTerminals(key);
    await this.sendRendered(chatId, messageWithTitle("Background terminals stopped."));
  }

  private async commandSession(chatId: ChatId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const status = await this.ensureAgentStarted(chatId, workspace);
    return { workspace, status, key: sessionKey(chatId, workspace.name) };
  }

  private sessionBusy(status: AgentSessionStatus): boolean {
    return Boolean(status.activeTurnId || status.waitingForApproval || status.waitingForUserInput);
  }

  private async sendBusyCommandNotice(chatId: ChatId): Promise<void> {
    await this.sendRendered(chatId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
  }

  private async handleCommandCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, command, token, action] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.chatId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
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

  private async resumeFromCallback(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: NonNullable<ReturnType<Store["getPendingPrompt"]>>,
    data: Record<string, unknown>,
    rawIndex: string | undefined,
  ): Promise<void> {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) throw new Error("Resume thread is missing.");
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const selected = asPromptRecord(threads[index]);
    const threadId = typeof selected?.id === "string" ? selected.id : undefined;
    if (!threadId) throw new Error("Resume selection expired.");
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    const status = await this.ensureAgentStarted(message.chatId, workspace, threadId);
    this.deps.store.setSessionThreadId(key, status.threadId ?? threadId);
    this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
    await this.renderCallbackPage(message, messageWithTitle("Resumed chat.", status.threadName ?? status.threadId ?? threadId), { inline_keyboard: [] });
  }

  private async planFromCallback(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: NonNullable<ReturnType<Store["getPendingPrompt"]>>,
    _data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace.name);
    this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
    if (action === "implement") {
      this.deps.store.setCollaborationMode(key, "default");
      await this.renderCallbackPage(message, messageWithTitle("Implementing plan."), { inline_keyboard: [] });
      await this.submitTask(message.chatId, "Implement the approved plan.", undefined, "immediate");
      return;
    }
    await this.renderCallbackPage(message, messageWithTitle("Continuing in Plan mode."), { inline_keyboard: [] });
  }

  private async renderHomeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatHomeMessage(status, this.deps.store.getHomeStatusMode(message.chatId)), consoleKeyboard(status));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.chatId, message.messageId);
  }

  private async toggleStatusModeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const nextMode: HomeStatusMode = this.deps.store.getHomeStatusMode(message.chatId) === "compact" ? "details" : "compact";
    this.deps.store.setHomeStatusMode(message.chatId, nextMode);
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatHomeMessage(status, nextMode), consoleKeyboard(status));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.chatId, message.messageId);
  }

  private async renderWorkspacesCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, pageIndex: number): Promise<void> {
    const workspaces = await this.listAvailableWorkspaces();
    const selected = this.currentWorkspace(message.chatId)?.name;
    const page = paginateWorkspaces(workspaces, selected, pageIndex);
    await this.renderCallbackPage(message, formatWorkspacesMessage(page.items.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    })), page.pageIndex, page.totalPages), workspacesKeyboard(page.items, selected, page.pageIndex, page.totalPages));
  }

  private async selectWorkspaceFromToken(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    this.deps.store.bindChat(message.chatId, workspace.name);
    this.logger.info("router.workspace_selected", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
    await this.ensureAgentStarted(message.chatId, workspace);
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatHomeMessage(status, this.deps.store.getHomeStatusMode(message.chatId)), consoleKeyboard(status));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.chatId, message.messageId);
  }

  private async confirmDeleteWorkspaceCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    await this.renderCallbackPage(
      message,
      confirmMessage("Delete workspace?", `This permanently deletes ${workspace.path}.`),
      deleteWorkspaceConfirmKeyboard(workspace.name),
    );
  }

  private async deleteWorkspaceCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    const key = sessionKey(message.chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key).catch((error) => {
      this.logger.warn("router.workspace_delete_stop_failed", {
        chat_id: message.chatId,
        workspace: workspace.name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    this.deps.store.markSessionStopped(key);
    await rm(workspace.path, { recursive: true, force: true });
    this.deps.store.deleteWorkspace(workspace.name);
    this.logger.info("router.workspace_deleted", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
    await this.renderWorkspacesCallback(message, 0);
  }

  private async stopFromCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearBinding(message.chatId);
    this.logger.info("router.session_stopped", { chat_id: message.chatId, workspace: workspace.name, session_key: key });
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatHomeMessage(status, this.deps.store.getHomeStatusMode(message.chatId)), consoleKeyboard(status));
  }

  private async renderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    const rendered = ensureRendered(body);
    if (!message.messageId) {
      await this.sendRendered(message.chatId, rendered, { replyMarkup });
      return;
    }
    try {
      await this.editRendered(message.chatId, rendered, {
        messageId: message.messageId,
        replyMarkup,
      });
    } catch (error) {
      this.logger.warn("router.callback_edit_fallback", {
        chat_id: message.chatId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.sendRendered(message.chatId, rendered, { replyMarkup });
    }
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.deps.adapter.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.logger.warn("router.callback_answer_failed", {
        callback_query_id: callbackQueryId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async sendRendered(chatId: ChatId, rendered: RenderedTelegramText, options: Omit<SendMessageOptions, "entities" | "parseMode"> = {}): Promise<{ messageId?: number }> {
    return await this.deps.adapter.sendMessage(chatId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  private async editRendered(
    chatId: ChatId,
    rendered: RenderedTelegramText,
    options: Omit<Parameters<IMAdapter["editMessageText"]>[2], "entities" | "parseMode">,
  ): Promise<void> {
    await this.deps.adapter.editMessageText(chatId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  private async renderConsole(chatId: ChatId): Promise<void> {
    const status = this.statusView(chatId);
    this.logger.info("router.console_rendered", {
      chat_id: chatId,
      workspace: status.workspaceName,
      running: Boolean(status.running),
    });
    const previousMessageId = this.deps.store.getConsoleMessageId(chatId);
    const body = formatHomeMessage(status, this.deps.store.getHomeStatusMode(chatId));
    if (previousMessageId) {
      try {
        await this.editRendered(chatId, body, {
          messageId: previousMessageId,
          replyMarkup: consoleKeyboard(status),
        });
        return;
      } catch (error) {
        this.logger.warn("router.console_edit_fallback", {
          chat_id: chatId,
          message_id: previousMessageId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    const result = await this.sendRendered(chatId, body, { replyMarkup: consoleKeyboard(status) });
    if (result.messageId) this.deps.store.setConsoleMessageId(chatId, result.messageId);
  }

  private async promptForWorkspaceName(chatId: ChatId): Promise<void> {
    const result = await this.sendRendered(chatId, textMessage("Reply with the cwd name. Existing directories under WORKSPACE_ROOT are selected; missing names are created."), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) {
      throw new Error("Telegram did not return a prompt message id.");
    }
    this.deps.store.setPendingPrompt({
      chatId,
      promptMessageId: result.messageId,
      kind: "workspace_name",
      createdAt: Date.now(),
    });
    this.logger.info("router.workspace_prompt_created", { chat_id: chatId, prompt_message_id: result.messageId });
  }

  private async createWorkspaceFromPrompt(chatId: ChatId, promptMessageId: number, name: string): Promise<void> {
    await this.selectOrCreateWorkspace(chatId, name);
    this.deps.store.deletePendingPrompt(chatId, promptMessageId);
  }

  private async selectOrCreateWorkspace(chatId: ChatId, name: string): Promise<void> {
    validateWorkspaceName(name);
    const existed = workspaceDirectoryExists(this.deps.config.workspaceRoot, name);
    const path = existed
      ? resolveWorkspacePath(this.deps.config.workspaceRoot, name)
      : await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindChat(chatId, name);
    this.logger.info(existed ? "router.workspace_existing_selected" : "router.workspace_created", { chat_id: chatId, workspace: name, path });
    await this.ensureAgentStarted(chatId, { name, path, createdAt: Date.now() });
    await this.sendRendered(chatId, renderTelegramText([
      "cwd ",
      code(name),
      ` ${existed ? "selected" : "created and selected"}.`,
    ]), {
      replyMarkup: consoleKeyboard(this.statusView(chatId)),
    });
  }

  private async submitTask(chatId: ChatId, text: string, userMessageId?: number, preference: "auto" | "immediate" | "queue" = "auto"): Promise<void> {
    if (!text) return;
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) {
      await this.renderConsole(chatId);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.ensureAgentStarted(chatId, workspace);
    if (await this.sendWaitingPromptNotice(chatId, status)) return;
    const busy = Boolean(status.activeTurnId);
    if (preference === "auto" && busy) {
      await this.sendToAgent(chatId, workspace, text, userMessageId, this.deps.store.activeTask(chatId, workspace.name));
      return;
    }
    const shouldQueue = preference === "queue";
    const task = this.deps.store.createTask({
      chatId,
      workspaceName: workspace.name,
      text,
      status: shouldQueue ? "queued" : "running",
      userMessageId,
    });
    if (shouldQueue) {
      await this.syncTaskReaction(task.id);
      return;
    }
    await this.runTask(workspace, task);
  }

  private async runTask(workspace: WorkspaceRecord, task: RelayTask): Promise<void> {
    this.deps.store.updateTask(task.id, { status: "running" });
    await this.syncTaskReaction(task.id);
    await this.sendToAgent(task.chatId, workspace, task.text, task.userMessageId, task);
  }

  private async sendToAgent(chatId: ChatId, workspace: WorkspaceRecord, text: string, userMessageId?: number, task?: RelayTask): Promise<void> {
    const key = sessionKey(chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    if (userMessageId) this.lastUserMessageIds.set(key, userMessageId);
    await this.deps.adapter.sendChatAction(chatId, "typing").catch((error) => {
      this.logger.debug("router.chat_action_failed", {
        chat_id: chatId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    this.logger.info("router.user_input_forwarded", {
      chat_id: chatId,
      workspace: workspace.name,
      session_key: key,
      text_len: text.length,
    });
    this.logger.debug("router.user_input_text", {
      chat_id: chatId,
      workspace: workspace.name,
      session_key: key,
      message_text: text,
    });
    this.deps.store.appendTranscript({
      chatId,
      workspaceName: workspace.name,
      role: "user",
      text: `${text}\n`,
      createdAt: Date.now(),
    });
    let result: Awaited<ReturnType<AgentDriver["send"]>>;
    try {
      const mode = this.deps.store.getCollaborationMode(key);
      result = await this.deps.agent.send(key, text, mode === "plan" ? { collaborationMode: "plan" } : undefined);
    } catch (error) {
      if (task) {
        this.deps.store.updateTask(task.id, { status: "failed" });
        await this.syncTaskReaction(task.id);
      }
      throw error;
    }
    if (task && result.turnId) this.deps.store.updateTask(task.id, { turnId: result.turnId, status: "running" });
  }

  private async sendWaitingPromptNotice(chatId: ChatId, status: AgentSessionStatus): Promise<boolean> {
    if (status.waitingForUserInput) {
      await this.sendRendered(chatId, messageWithTitle("Codex is waiting for your answer.", "Open the latest question card or reply to it. New prompts are paused while the active turn is blocked."));
      return true;
    }
    if (status.waitingForApproval) {
      await this.sendRendered(chatId, messageWithTitle("Codex is waiting for approval.", "Use the approval buttons before sending another instruction."));
      return true;
    }
    return false;
  }

  private async ensureAgentStarted(chatId: ChatId, workspace: WorkspaceRecord, threadId?: string): Promise<AgentSessionStatus> {
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const key = sessionKey(chatId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (existing?.running && !threadId) return existing;

    this.logger.info("router.session_starting", { chat_id: chatId, workspace: workspace.name, session_key: key, thread_id: threadId });
    const previous = threadId ? undefined : this.deps.store.getSession(key);
    const status = await this.deps.agent.start({
      chatId,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      threadId: threadId ?? previous?.thread_id ?? undefined,
    });
    this.deps.store.markSessionStarted(key, chatId, workspace.name, Date.now(), status.threadId);
    this.logger.info("router.session_started", { chat_id: chatId, workspace: workspace.name, session_key: key, thread_id: status.threadId });
    return status;
  }

  private async markActiveTask(sessionKeyValue: string, status: "blocked" | "running"): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const task = this.deps.store.activeTask(parsed.chatId, parsed.workspaceName);
    if (!task) return;
    this.deps.store.updateTask(task.id, { status });
    await this.syncTaskReaction(task.id);
  }

  private async completeTaskAndDispatchNext(sessionKeyValue: string, turnId: string | undefined): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const active = this.deps.store.activeTask(parsed.chatId, parsed.workspaceName);
    if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
      this.deps.store.updateTask(active.id, { status: "done" });
      await this.syncTaskReaction(active.id);
    }
    const workspace = this.currentWorkspace(parsed.chatId);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (status?.waitingForApproval || status?.waitingForUserInput || status?.activeTurnId) return;
    const next = this.deps.store.nextQueuedTask(parsed.chatId, parsed.workspaceName);
    if (next) {
      await this.runTask(workspace, next);
    }
  }

  private async sendPlanReadyPrompt(sessionKeyValue: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    const token = shortToken();
    const result = await this.sendRendered(parsed.chatId, messageWithTitle("Plan ready.", "Choose whether to implement it now or keep refining the plan."), {
      replyMarkup: planReadyKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) return;
    this.deps.store.setPendingPrompt({
      chatId: parsed.chatId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify({ command: "plan", token }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async syncTaskReaction(taskId: number): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task?.userMessageId) return;
    try {
      await this.deps.adapter.setMessageReaction(task.chatId, task.userMessageId, reactionForTaskStatus(task.status));
    } catch (error) {
      this.logger.warn("router.task_reaction_failed", {
        chat_id: task.chatId,
        task_id: task.id,
        message_id: task.userMessageId,
        status: task.status,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private isStaleConsoleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): boolean {
    if (!message.messageId || !isConsolePayload(payload)) return false;
    const latest = this.deps.store.getConsoleMessageId(message.chatId);
    return Boolean(latest && latest !== message.messageId);
  }

  private currentWorkspace(chatId: ChatId): WorkspaceRecord | undefined {
    const binding = this.deps.store.getBinding(chatId);
    return binding ? this.deps.store.getWorkspace(binding.workspaceName) : undefined;
  }

  private requireCurrentWorkspace(chatId: ChatId): WorkspaceRecord {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) throw new Error("No cwd selected. Open Relay Home and choose or create a cwd.");
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    return workspace;
  }

  private requireWorkspace(name: string): WorkspaceRecord {
    validateWorkspaceName(name);
    const workspace = this.deps.store.getWorkspace(name) ?? {
      name,
      path: resolveWorkspacePath(this.deps.config.workspaceRoot, name),
      createdAt: Date.now(),
    };
    if (!isRealDirectory(workspace.path)) throw new Error(`cwd '${name}' does not exist. Create it from Relay Home.`);
    this.deps.store.upsertWorkspace(workspace);
    return workspace;
  }

  private async listAvailableWorkspaces(): Promise<WorkspaceRecord[]> {
    const now = Date.now();
    for (const workspace of await discoverWorkspaceDirectories(this.deps.config.workspaceRoot)) {
      this.deps.store.upsertWorkspace({ ...workspace, createdAt: now });
    }
    return this.deps.store.listWorkspaces();
  }

  private async workspaceNameForToken(token: string): Promise<string> {
    const matches = (await this.listAvailableWorkspaces()).filter((workspace) => workspaceCallbackToken(workspace.name) === token);
    if (matches.length === 1) return matches[0]!.name;
    if (matches.length > 1) throw new Error("cwd selection token is ambiguous. Refresh cwd and try again.");
    throw new Error("cwd selection expired. Refresh cwd and try again.");
  }

  private appendSystem(chatId: ChatId, text: string): void {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return;
    this.deps.store.appendTranscript({ chatId, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  private statusView(chatId: ChatId): StatusView {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(chatId, workspace.name));
    const recentOutput = this.deps.store.latestTranscriptEvent(chatId, workspace.name, "agent");
    const recentError = this.deps.store.latestTranscriptEvent(chatId, workspace.name, "system");
    return statusViewFromParts(
      workspace,
      status,
      recentOutput?.createdAt,
      recentError?.text,
      this.deps.store.countTasks(chatId, workspace.name, ["queued"]),
      this.deps.store.countTasks(chatId, workspace.name, ["blocked"]),
      this.deps.store.activeTask(chatId, workspace.name),
    );
  }

  private readonly liveOutput = new Map<string, LiveOutputState>();

  private readonly lastUserMessageIds = new Map<string, number>();
  private nextOutputSegmentId = 1;

  private readonly codexRequests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    questions: AgentUserInputQuestion[];
    answers: Record<string, { answers: string[] }>;
  }>();

  private async handleCodexUserInputRequest(event: AgentUserInputRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const key = codexRequestKey(event.sessionKey, event.requestId);
    this.codexRequests.set(key, { sessionKey: event.sessionKey, requestId: event.requestId, questions: event.questions, answers: {} });

    const first = event.questions[0];
    if (!first) throw new Error("Codex requested user input without questions.");
    await this.sendCodexQuestion(parsed.chatId, event.sessionKey, event.requestId, first, 0, token, expiresAt);
  }

  private async handleCodexApprovalRequest(event: AgentApprovalRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const result = await this.sendRendered(parsed.chatId, formatApprovalMessage(event.title, event.body), {
      replyMarkup: approvalKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return an approval prompt message id.");
    this.deps.store.setPendingPrompt({
      chatId: parsed.chatId,
      promptMessageId: result.messageId,
      kind: "codex_approval",
      createdAt: Date.now(),
      sessionKey: event.sessionKey,
      payloadJson: JSON.stringify({
        token,
        requestId: event.requestId,
        method: event.method,
        approvalKind: event.approvalKind,
        title: event.title,
        body: event.body,
        params: event.params,
      }),
      expiresAt,
    });
  }

  private async sendCodexQuestion(
    chatId: ChatId,
    sessionKeyValue: string,
    requestId: string | number,
    question: AgentUserInputQuestion,
    questionIndex: number,
    token: string,
    expiresAt: number,
  ): Promise<void> {
    const options = question.options ?? [];
    const payload = JSON.stringify({
      token,
      requestId,
      questionIndex,
      questionId: question.id,
      isSecret: Boolean(question.isSecret),
      options,
    });
    const request = this.codexRequests.get(codexRequestKey(sessionKeyValue, requestId));
    const totalQuestions = request?.questions.length ?? 1;
    const result = await this.sendRendered(chatId, formatCodexQuestion(question, questionIndex, totalQuestions), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a prompt message id.");
    this.deps.store.setPendingPrompt({
      chatId,
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: payload,
      expiresAt,
    });
  }

  private async sendNextCodexQuestion(
    chatId: ChatId,
    pending: NonNullable<ReturnType<Store["getPendingPrompt"]>>,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    if (!pending.sessionKey) return false;
    const requestId = data.requestId as string | number | undefined;
    if (requestId === undefined) return false;
    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) return false;
    const currentIndex = typeof data.questionIndex === "number" ? data.questionIndex : -1;
    const nextIndex = request.questions.findIndex((question, index) => index > currentIndex && !request.answers[question.id]);
    const next = nextIndex >= 0 ? request.questions[nextIndex] : undefined;
    if (!next) return false;
    const token = typeof data.token === "string" ? data.token : shortToken();
    await this.sendCodexQuestion(chatId, pending.sessionKey, requestId, next, nextIndex, token, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS);
    return true;
  }

  private async answerCodexFreeText(chatId: ChatId, promptMessageId: number, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(chatId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(chatId, promptMessageId);
      await this.sendRendered(chatId, textMessage("Question expired."));
      return;
    }
    const response = await this.recordCodexAnswer(pending, data, text);
    if (response === "expired") return;
    const hasNext = !response && await this.sendNextCodexQuestion(chatId, pending, data);
    if (!hasNext) await this.sendRendered(chatId, data.isSecret ? messageWithTitle("Answered.") : answeredMessage(text, false));
    if (response) await this.respondToCodexPrompt(response);
  }

  private async answerRelayCommandPrompt(chatId: ChatId, promptMessageId: number, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(chatId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(chatId, promptMessageId);
      await this.sendRendered(chatId, textMessage("Command prompt expired."));
      return;
    }
    this.deps.store.deletePendingPrompt(chatId, promptMessageId);
    if (data.command === "rename") {
      await this.renameCurrentThread(chatId, text.trim());
      return;
    }
    await this.sendRendered(chatId, textMessage("Command prompt expired."));
  }

  private async recordCodexAnswer(
    pending: NonNullable<ReturnType<Store["getPendingPrompt"]>>,
    data: Record<string, unknown>,
    answer: string,
  ): Promise<{ sessionKey: string; requestId: string | number; result: unknown } | "expired" | undefined> {
    if (!pending.sessionKey) throw new Error("Question session is missing.");
    const requestId = data.requestId as string | number | undefined;
    const questionId = typeof data.questionId === "string" ? data.questionId : undefined;
    if (requestId === undefined || !questionId) throw new Error("Question payload is invalid.");

    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) {
      this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
      await this.sendRendered(pending.chatId, textMessage("Question expired."));
      return "expired";
    }

    request.answers[questionId] = { answers: [answer] };
    this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
    if (Object.keys(request.answers).length !== request.questions.length) return undefined;
    this.codexRequests.delete(codexRequestKey(pending.sessionKey, requestId));
    return { sessionKey: pending.sessionKey, requestId, result: { answers: request.answers } };
  }

  private async respondToCodexPrompt(response: { sessionKey: string; requestId: string | number; result: unknown }): Promise<void> {
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer Codex prompts.");
    await this.deps.agent.respond(response.sessionKey, response.requestId, response.result);
    await this.markActiveTask(response.sessionKey, "running");
  }

  private async answerCodexApproval(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, decision] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.chatId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_approval" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
      return;
    }
    if (!pending.sessionKey || !this.deps.agent.respond) throw new Error("Approval session is missing.");
    const approved = decision === "y";
    this.deps.store.deletePendingPrompt(message.chatId, pending.promptMessageId);
    await this.renderCallbackPage(
      message,
      formatApprovalDecisionMessage(
        approved ? "Approved." : "Denied.",
        typeof data.title === "string" ? data.title : "Approval request",
        typeof data.body === "string" ? data.body : "",
      ),
      { inline_keyboard: [] },
    );
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, approved, data.params));
    await this.markActiveTask(pending.sessionKey, "running");
  }

  private async expireCallbackPrompt(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.chatId, message.messageId);
    await this.renderCallbackPage(message, messageWithTitle("Question expired."), { inline_keyboard: [] });
  }

  private async bufferAgentOutput(sessionKeyValue: string, chatId: ChatId, chunk: string, turnId?: string): Promise<void> {
    let state = this.liveOutput.get(sessionKeyValue);
    if (state?.turnId && turnId && state.turnId !== turnId) {
      await this.finalizeSessionOutput(sessionKeyValue);
      state = undefined;
    }
    if (!state) {
      state = { chatId, text: "", startedAt: Date.now(), segmentId: this.nextOutputSegmentId++, turnId, replyToMessageId: this.lastUserMessageIds.get(sessionKeyValue) };
      this.liveOutput.set(sessionKeyValue, state);
    } else if (!state.turnId && turnId) {
      state.turnId = turnId;
    }

    state.text += chunk;
    this.logger.debug("router.agent_output_buffered", {
      chat_id: chatId,
      session_key: sessionKeyValue,
      chunk_len: chunk.length,
      buffered_len: state.text.length,
    });

    if (state.timer) clearTimeout(state.timer);
    const elapsed = Date.now() - state.startedAt;
    const delay = state.text.length >= STREAM_FLUSH_CHARS || elapsed >= STREAM_MAX_MS ? 0 : STREAM_QUIET_MS;
    const segmentId = state.segmentId;
    state.timer = setTimeout(() => {
      void this.flushSessionOutput(sessionKeyValue, segmentId).catch((error) => {
        this.logger.error("router.agent_output_send_failed", {
          chat_id: chatId,
          session_key: sessionKeyValue,
          text_len: state?.text.length ?? 0,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }, delay);
  }

  private async finalizeSessionOutput(sessionKeyValue: string): Promise<void> {
    const state = this.liveOutput.get(sessionKeyValue);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state && (state.text !== state.lastFlushedText || state.pageToken)) {
      await this.flushSessionOutput(sessionKeyValue, undefined, true);
    }
    const current = this.liveOutput.get(sessionKeyValue);
    if (current?.timer) clearTimeout(current.timer);
    this.liveOutput.delete(sessionKeyValue);
    if (state?.timer) clearTimeout(state.timer);
  }

  private markFlushed(sessionKeyValue: string, text: string): void {
    const state = this.liveOutput.get(sessionKeyValue);
    if (state) state.lastFlushedText = text;
  }

  private async flushSessionOutput(sessionKeyValue: string, expectedSegmentId?: number, final = false): Promise<void> {
    let state = this.liveOutput.get(sessionKeyValue);
    if (!state || state.text.length === 0) return;
    if (expectedSegmentId !== undefined && state.segmentId !== expectedSegmentId) return;

    if (state.flushPromise) {
      await state.flushPromise;
      state = this.liveOutput.get(sessionKeyValue);
      if (!state || state.text.length === 0) return;
      if (expectedSegmentId !== undefined && state.segmentId !== expectedSegmentId) return;
      if (state.text === state.lastFlushedText && !(final && state.pageToken && !state.finalPageRendered)) return;
      await this.flushSessionOutput(sessionKeyValue, expectedSegmentId, final);
      return;
    }

    if (state.text === state.lastFlushedText && !(final && state.pageToken && !state.finalPageRendered)) return;
    const flushPromise = this.flushSessionOutputOnce(sessionKeyValue, state, final);
    state.flushPromise = flushPromise;
    try {
      await flushPromise;
    } finally {
      const current = this.liveOutput.get(sessionKeyValue);
      if (current?.flushPromise === flushPromise) current.flushPromise = undefined;
    }
  }

  private async flushSessionOutputOnce(
    sessionKeyValue: string,
    state: LiveOutputState,
    final: boolean,
  ): Promise<void> {
    if (state?.timer) clearTimeout(state.timer);
    state.timer = undefined;

    const snapshotText = state.text;
    const rendered = renderCodexMarkdownForTelegram(snapshotText);
    const chunks = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    this.logger.debug("router.agent_output_flushed", {
      chat_id: state.chatId,
      session_key: sessionKeyValue,
      text_len: snapshotText.length,
      chunks: chunks.length,
    });

    if (chunks.length === 1 && rendered.text.length < STREAM_FLUSH_CHARS) {
      const chunk = chunks[0]!;
      if (state.messageId) {
        try {
          await this.editRendered(state.chatId, chunk, {
            messageId: state.messageId,
            disableWebPagePreview: true,
          });
          this.markFlushed(sessionKeyValue, snapshotText);
          state.finalPageRendered = false;
          return;
        } catch (error) {
          this.logger.warn("router.agent_output_edit_fallback", {
            chat_id: state.chatId,
            message_id: state.messageId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.sendRendered(state.chatId, chunk, {
        replyToMessageId: state.replyToMessageId,
        disableWebPagePreview: true,
      });
      state.messageId = result.messageId;
      this.markFlushed(sessionKeyValue, snapshotText);
      state.finalPageRendered = false;
      return;
    }

    if (chunks.length > 1) {
      const token = state.pageToken ?? shortToken();
      state.pageToken = token;
      this.deps.store.setPagedOutput({
        token,
        chatId: state.chatId,
        sessionKey: sessionKeyValue,
        text: snapshotText,
        createdAt: state.startedAt,
        expiresAt: Date.now() + PAGED_OUTPUT_TTL_MS,
      });
      const pageIndex = final ? 0 : chunks.length - 1;
      const page = decoratePagedOutput(chunks[pageIndex]!, pageIndex, chunks.length);
      const replyMarkup = pagedOutputKeyboard(token, pageIndex, chunks.length);
      if (state.messageId) {
        try {
          await this.editRendered(state.chatId, page, {
            messageId: state.messageId,
            replyMarkup,
            disableWebPagePreview: true,
          });
          this.markFlushed(sessionKeyValue, snapshotText);
          state.finalPageRendered = final;
          return;
        } catch (error) {
          this.logger.warn("router.agent_output_edit_fallback", {
            chat_id: state.chatId,
            message_id: state.messageId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.sendRendered(state.chatId, page, {
        replyToMessageId: state.replyToMessageId,
        replyMarkup,
        disableWebPagePreview: true,
      });
      state.messageId = result.messageId;
      this.markFlushed(sessionKeyValue, snapshotText);
      state.finalPageRendered = final;
      return;
    }
  }

  private async renderPagedOutputCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const [, token, rawPage] = payload.split(":");
    const pageIndex = Number(rawPage);
    const output = token ? this.deps.store.getPagedOutput(token) : undefined;
    if (!output || output.chatId !== message.chatId || output.expiresAt < Date.now()) {
      if (token) this.deps.store.deletePagedOutput(token);
      await this.renderCallbackPage(message, messageWithTitle("Page expired."), { inline_keyboard: [] });
      return;
    }
    const pageToken = output.token;
    const rendered = renderCodexMarkdownForTelegram(output.text);
    const pages = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) {
      await this.renderCallbackPage(message, messageWithTitle("Page unavailable."), pagedOutputKeyboard(pageToken, pages.length - 1, pages.length));
      return;
    }
    const page = decoratePagedOutput(pages[pageIndex]!, pageIndex, pages.length);
    const replyMarkup = pagedOutputKeyboard(pageToken, pageIndex, pages.length);
    if (!message.messageId) {
      await this.sendRendered(message.chatId, page, {
        replyMarkup,
        disableWebPagePreview: true,
      });
      return;
    }
    try {
      await this.editRendered(message.chatId, page, {
        messageId: message.messageId,
        replyMarkup,
        disableWebPagePreview: true,
      });
    } catch (error) {
      this.logger.warn("router.paged_output_edit_fallback", {
        chat_id: message.chatId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.sendRendered(message.chatId, page, {
        replyMarkup,
        disableWebPagePreview: true,
      });
    }
  }
}

function commandName(text: string): string | undefined {
  const [command = ""] = text.split(/\s+/);
  return command.split("@")[0] || undefined;
}

function commandArgs(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
}

function parseReviewTarget(args: string): AgentReviewTarget {
  if (!args) return { type: "uncommittedChanges" };
  const [kind = "", second = "", ...rest] = args.split(/\s+/);
  if (kind === "branch" && second) return { type: "baseBranch", branch: second };
  if (kind === "commit" && second) return { type: "commit", sha: second, title: rest.join(" ") || null };
  return { type: "custom", instructions: args };
}

function decoratePagedOutput(page: RenderedTelegramText, pageIndex: number, totalPages: number): RenderedTelegramText {
  return appendRendered(page, renderTelegramText(["\n\n", bold(`Page ${pageIndex + 1}/${totalPages}`)]));
}

function pagedOutputKeyboard(token: string, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  if (totalPages <= 1) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.firstPage, callback_data: `ar:p:${token}:0` },
      { text: UI_BUTTON.previousPage, callback_data: `ar:p:${token}:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:p:${token}:${Math.min(totalPages - 1, pageIndex + 1)}` },
      { text: UI_BUTTON.lastPage, callback_data: `ar:p:${token}:${totalPages - 1}` },
    ]],
  };
}

function shortToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

function codexRequestKey(sessionKeyValue: string, requestId: string | number): string {
  return `${sessionKeyValue}:${String(requestId)}`;
}

function bold(text: string): TelegramTextPart {
  return { text, entity: "bold" };
}

function code(text: string): TelegramTextPart {
  return { text, entity: "code" };
}

function textMessage(text: string): RenderedTelegramText {
  return renderTelegramText([text]);
}

function ensureRendered(body: string | RenderedTelegramText): RenderedTelegramText {
  return typeof body === "string" ? textMessage(body) : body;
}

function messageWithTitle(title: string, body?: string): RenderedTelegramText {
  return renderTelegramText(body ? [bold(title), "\n\n", body] : [bold(title)]);
}

function formatResumeMessage(threads: AgentThreadSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Resume chat"), "\n\n"];
  for (const [index, thread] of threads.entries()) {
    if (index > 0) parts.push("\n");
    parts.push(`${index + 1}. `, code(thread.name ?? thread.id));
    if (thread.preview) parts.push(` - ${truncateForTelegramLabel(thread.preview, 80)}`);
  }
  return renderTelegramText(parts);
}

function resumeKeyboard(token: string, threads: AgentThreadSummary[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: threads.map((thread, index) => [{
      text: buttonLabel(thread.name ?? thread.id),
      callback_data: `ar:cmd:resume:${token}:${index}`,
    }]),
  };
}

function planReadyKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Implement", callback_data: `ar:cmd:plan:${token}:implement` },
      { text: "Continue", callback_data: `ar:cmd:plan:${token}:continue` },
    ]],
  };
}

function confirmMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText([bold(title), "\n\n", body]);
}

function answeredMessage(answer: string, hasNext: boolean): RenderedTelegramText {
  return renderTelegramText([
    bold("Answered:"),
    " ",
    answer,
    hasNext ? "\n\nNext question sent." : "",
  ]);
}

function reactionForTaskStatus(status: RelayTask["status"]): string {
  switch (status) {
    case "queued":
      return "🫡";
    case "running":
      return "✍";
    case "blocked":
      return "🤔";
    case "done":
      return "😎";
    case "failed":
    case "cancelled":
      return "😱";
  }
}

function formatErrorMessage(detail: string): RenderedTelegramText {
  return renderTelegramText([bold("Error:"), " ", detail]);
}

function formatCodexQuestion(question: AgentUserInputQuestion, questionIndex?: number, totalQuestions?: number): RenderedTelegramText {
  if (typeof questionIndex === "number" && typeof totalQuestions === "number" && totalQuestions > 1) {
    return renderCodexQuestionBody([
      bold(`Question ${questionIndex + 1}/${totalQuestions}`),
      "\n",
      bold(question.header),
      "\n\n",
      question.question,
    ], question);
  }
  return renderCodexQuestionBody([bold(question.header), "\n\n", question.question], question);
}

function renderCodexQuestionBody(parts: TelegramTextPart[], question: AgentUserInputQuestion): RenderedTelegramText {
  const options = question.options ?? [];
  if (!question.isSecret && options.length > 0) {
    parts.push("\n\n");
    for (const [index, option] of options.entries()) {
      if (index > 0) parts.push("\n");
      parts.push(bold(option.label));
      if (option.description) parts.push(` - ${option.description}`);
    }
  }
  return renderTelegramText(parts);
}

function formatApprovalMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText(approvalMessageParts(title, body));
}

function formatApprovalDecisionMessage(decision: string, title: string, body: string): RenderedTelegramText {
  return renderTelegramText([
    bold(decision),
    "\n\n",
    ...approvalMessageParts(title, body),
  ]);
}

function approvalMessageParts(title: string, body: string): TelegramTextPart[] {
  const parts: TelegramTextPart[] = [bold(title)];
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (lines.length > 0) {
    parts.push("\n\n");
    for (const [index, line] of lines.entries()) {
      if (index > 0) parts.push("\n");
      if (line.startsWith("cwd: ")) {
        parts.push("cwd: ", code(line.slice(5)));
      } else if (index === lines.length - 1 && lines.length > 1) {
        parts.push(code(line));
      } else {
        parts.push(line);
      }
    }
  }
  return parts;
}

function approvalKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.approve, callback_data: `ar:a:${token}:y` },
      { text: UI_BUTTON.deny, callback_data: `ar:a:${token}:n` },
    ]],
  };
}

function parsePromptPayload(payloadJson: string | undefined): Record<string, unknown> | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson);
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function asPromptRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isExpired(prompt: { expiresAt?: number }): boolean {
  return typeof prompt.expiresAt === "number" && prompt.expiresAt < Date.now();
}

function approvalResponse(kind: AgentApprovalKind, approved: boolean, params: unknown): unknown {
  if (kind === "legacy_command" || kind === "legacy_patch") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (kind === "permissions") {
    const record = params && typeof params === "object" ? params as { permissions?: unknown } : {};
    return approved ? { permissions: record.permissions ?? {}, scope: "turn" } : { permissions: {}, scope: "turn" };
  }
  return { decision: approved ? "accept" : "decline" };
}

function statusViewFromParts(
  workspace: WorkspaceRecord,
  status: AgentSessionStatus | undefined,
  recentOutputAt: number | undefined,
  recentError: string | undefined,
  queuedTaskCount = 0,
  blockedTaskCount = 0,
  activeTask?: RelayTask,
) {
  return {
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    running: Boolean(status?.running),
    recentOutputAt,
    recentError: status?.recentError ?? recentError,
    threadId: status?.threadId,
    threadName: status?.threadName,
    threadStatus: status?.threadStatus,
    model: status?.model,
    modelProvider: status?.modelProvider,
    reasoningEffort: status?.reasoningEffort,
    approvalPolicy: status?.approvalPolicy,
    approvalsReviewer: status?.approvalsReviewer,
    sandboxPolicy: status?.sandboxPolicy,
    tokenUsage: status?.tokenUsage,
    contextWindow: status?.contextWindow,
    waitingForApproval: status?.waitingForApproval,
    waitingForUserInput: status?.waitingForUserInput,
    queuedTaskCount,
    blockedTaskCount,
    activeTaskId: activeTask?.id,
    activeTaskStatus: activeTask?.status,
  };
}

function formatHomeMessage(status: StatusView, mode: HomeStatusMode): RenderedTelegramText {
  return mode === "details" ? formatDetailsMessage(status) : formatStatusMessage(status);
}

function formatStatusMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) {
    return renderTelegramText([
      bold("Relay Home"),
      `\n\n${statusIcon(status)} ${statusLabel(status)}`,
      "\ncwd: none",
      "\nWaiting: no",
    ]);
  }
  const parts: TelegramTextPart[] = [
    bold("Relay Home"),
    "\n\n",
    statusIcon(status),
    " ",
    statusLabel(status),
    "\ncwd: ",
    code(truncateForTelegramLabel(status.workspaceName, 32)),
    "\nWaiting: ",
    formatWaiting(status),
  ];
  if (status.recentError) parts.push("\nError: ", truncateForTelegramLabel(status.recentError.trim(), 120));
  return renderTelegramText(parts);
}

function formatDetailsMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) return formatStatusMessage(status);
  const parts: TelegramTextPart[] = [
    bold("Relay Home"),
    "\n\n",
    statusIcon(status),
    " ",
    statusLabel(status),
    "\n\ncwd: ",
    code(status.workspaceName),
    "\nPath: ",
    code(status.workspacePath),
    "\nThread: ",
  ];
  const threadLabel = status.threadName || status.threadId;
  parts.push(threadLabel ? code(threadLabel) : "none");
  if (status.threadStatus) parts.push(` (${status.threadStatus})`);
  parts.push(
    "\nModel: ",
    status.model ? code(status.model) : "unknown",
    status.modelProvider ? ` / ${status.modelProvider}` : "",
    "\nReasoning: ",
    status.reasoningEffort ?? "unknown",
    "\nApproval policy: ",
    status.approvalPolicy ?? "unknown",
    "\nSandbox policy: ",
    status.sandboxPolicy ?? "unknown",
    "\nWaiting: ",
    formatWaiting(status),
    "\nPrompts: ",
    formatTaskCounts(status),
    "\nContext: ",
    formatContext(status),
    "\nToken usage: ",
    formatTokens(status),
  );
  if (status.recentOutputAt) parts.push("\nLast output: ", relativeTime(status.recentOutputAt));
  if (status.recentError) parts.push("\nError: ", truncateForTelegramLabel(status.recentError.trim(), 120));
  return renderTelegramText(parts);
}

function statusIcon(status: StatusView): string {
  if (status.recentError) return "🔴";
  if (status.waitingForApproval || status.waitingForUserInput) return "🟡";
  return status.running ? "🟢" : "⚪";
}

function statusLabel(status: StatusView): string {
  if (status.recentError) return "Error";
  if (status.waitingForApproval || status.waitingForUserInput) return "Waiting";
  return status.running ? "Running" : "Stopped";
}

function formatWaiting(status: StatusView): string {
  const waiting = [
    status.waitingForUserInput ? "user input" : undefined,
    status.waitingForApproval ? "approval" : undefined,
  ].filter(Boolean);
  return waiting.length > 0 ? waiting.join(", ") : "no";
}

function formatTaskCounts(status: StatusView): string {
  const parts = [
    status.activeTaskId ? `#${status.activeTaskId} ${status.activeTaskStatus ?? "active"}` : undefined,
    status.queuedTaskCount ? `${status.queuedTaskCount} queued` : undefined,
    status.blockedTaskCount ? `${status.blockedTaskCount} blocked` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function formatTokens(status: StatusView): string {
  const total = status.tokenUsage?.total?.totalTokens;
  const context = status.contextWindow;
  if (typeof total !== "number" && typeof context !== "number") return "unknown";
  if (typeof total === "number" && typeof context === "number" && context > 0) {
    const percent = Math.round((total / context) * 100);
    return `${total}/${context} (${percent}%)`;
  }
  return typeof total === "number" ? String(total) : `context ${context}`;
}

function contextPercent(status: StatusView): number | undefined {
  const total = status.tokenUsage?.total?.totalTokens;
  const context = status.contextWindow;
  if (typeof total !== "number" || typeof context !== "number" || context <= 0) return undefined;
  return Math.round((total / context) * 100);
}

function formatContext(status: StatusView): string {
  const percent = contextPercent(status);
  return typeof percent === "number"
    ? `${contextUsageBar(percent)} ${percent}%`
    : `${contextUsageBar(undefined)} ${formatTokens(status)}`;
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(timestamp).toISOString();
}

function formatWorkspacesMessage(workspaces: Array<{ name: string; selected: boolean }>, pageIndex: number, totalPages: number): RenderedTelegramText {
  if (workspaces.length === 0) {
    return renderTelegramText([
      bold("Workspace"),
      `\n\nNo cwd directories found.\nUse ${UI_BUTTON.create} to create one.`,
    ]);
  }
  const parts: TelegramTextPart[] = [bold("Workspace"), `\n\nPage ${pageIndex + 1}/${totalPages}\n`];
  for (const workspace of workspaces) {
    parts.push("\n", workspace.selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `, code(workspace.name));
  }
  return renderTelegramText(parts);
}

function consoleKeyboard(status: { workspaceName?: string; running?: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  rows.push([
    { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    { text: UI_BUTTON.status, callback_data: "ar:status" },
    { text: UI_BUTTON.refresh, callback_data: "ar:s" },
  ]);
  if (status.workspaceName) {
    rows.push([{ text: UI_BUTTON.stop, callback_data: "ar:stop" }]);
  }
  return {
    inline_keyboard: rows,
  };
}

function workspacesKeyboard(workspaces: WorkspaceRecord[], selected: string | undefined, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  const rows = workspaces.map((workspace) => [
    {
      text: workspaceButtonText(workspace.name, workspace.name === selected),
      callback_data: workspaceCallbackData(workspace.name),
    },
    { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(workspace.name, false) },
  ]);
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.previousPage, callback_data: `ar:wl:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:wl:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }

  return {
    inline_keyboard: [
      ...rows,
      [
        { text: UI_BUTTON.create, callback_data: "ar:n" },
        { text: UI_BUTTON.refresh, callback_data: "ar:w" },
      ],
    ],
  };
}

function paginateWorkspaces(workspaces: WorkspaceRecord[], selected: string | undefined, rawPageIndex: number): { items: WorkspaceRecord[]; pageIndex: number; totalPages: number } {
  const sorted = [...workspaces].sort((left, right) => {
    if (left.name === selected) return -1;
    if (right.name === selected) return 1;
    return left.name.localeCompare(right.name);
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / LIST_PAGE_SIZE));
  const pageIndex = clampPage(rawPageIndex, totalPages);
  return {
    items: sorted.slice(pageIndex * LIST_PAGE_SIZE, pageIndex * LIST_PAGE_SIZE + LIST_PAGE_SIZE),
    pageIndex,
    totalPages,
  };
}

function clampPage(value: number, totalPages: number): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(totalPages - 1, value));
}

function buttonLabel(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

function workspaceButtonText(name: string, selected: boolean): string {
  const prefix = selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `;
  return `${prefix}${buttonLabel(name).padEnd(WORKSPACE_BUTTON_LABEL_WIDTH, "\u00A0")}`;
}

function workspaceCallbackData(name: string): string {
  const callbackData = `ar:uh:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

function deleteWorkspaceCallbackData(name: string, confirmed: boolean): string {
  const callbackData = `ar:${confirmed ? "wd!" : "wd?"}:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

function deleteWorkspaceConfirmKeyboard(name: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(name, true) },
      { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    ]],
  };
}

function workspaceCallbackToken(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

function isConsolePayload(payload: string): boolean {
  return payload === "s"
    || payload === "w"
    || payload === "n"
    || payload === "status"
    || payload === "stop"
    || payload.startsWith("wl:")
    || payload.startsWith("wd?:")
    || payload.startsWith("wd!:")
    || payload.startsWith("uh:");
}
