import { createHash } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { isAuthorized } from "../config.ts";
import { sessionKey } from "../agent.ts";
import { parseSessionKey } from "./session.ts";
import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentDriver,
  AgentModelSummary,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentThreadSummary,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
  ChatId,
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
const RESUME_THREAD_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 8;
const INIT_PROMPT = [
  "Create an AGENTS.md file for this workspace.",
  "Inspect the project structure first, then write concise, practical instructions that future Codex agents should follow in this repository.",
].join(" ");

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<IMAdapter, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction">;
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
      } else if (pending?.kind === "agent_instruction") {
        await this.answerAgentInstructionPrompt(message.chatId, message.replyToMessageId!, text, message.messageId);
      } else if (pending?.kind === "codex_user_input") {
        await this.answerCodexFreeText(message.chatId, message.replyToMessageId!, text);
      } else if (command === "/codex" || command === "/relay" || command === "/start") {
        await this.renderConsole(message.chatId);
      } else if (command && await this.handleSlashCommand(message.chatId, command, text, message.messageId)) {
        return;
      } else if (command) {
        await this.submitTask(message.chatId, text, message.messageId);
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
      await this.completeTaskAndDispatchNext(session.sessionKey, session.turnId);
      return;
    }
    if (session.type === "user_input_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      this.markActiveTask(session.sessionKey, "blocked");
      await this.handleCodexUserInputRequest(session);
      return;
    }
    if (session.type === "approval_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      this.markActiveTask(session.sessionKey, "blocked");
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
      await this.renderCallbackPage(message, messageWithTitle("Stale console.", "Open the latest control center."), { inline_keyboard: [[{ text: "🔄 Open latest", callback_data: "ar:home" }]] });
      return;
    }

    if (payload === "home") {
      await this.renderConsole(message.chatId);
      return;
    }
    if (payload === "s") {
      await this.renderStatusCallback(message);
      return;
    }
    if (payload === "queue") {
      await this.renderQueueCallback(message);
      return;
    }
    if (payload.startsWith("qt:")) {
      await this.routeTaskCallback(message, payload);
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
    if (payload === "i") {
      await this.promptForAgentInstruction(message.chatId);
      return;
    }
    if (payload.startsWith("q:")) {
      await this.answerCodexOption(message, payload);
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
    if (payload.startsWith("r:")) {
      await this.resumeThreadCallback(message, payload);
      return;
    }
    if (payload.startsWith("wl:")) {
      await this.renderWorkspacesCallback(message, Number(payload.slice("wl:".length)));
      return;
    }
    if (payload.startsWith("rl:")) {
      await this.renderResumeThreadsCallback(message, Number(payload.slice("rl:".length)));
      return;
    }
    if (payload === "d") {
      await this.renderDetailsCallback(message);
      return;
    }
    if (payload === "clear?") {
      await this.renderCallbackPage(message, confirmMessage("Start a new Codex session?", "This replaces the current thread binding for the selected cwd."), clearConfirmKeyboard());
      return;
    }
    if (payload === "clear!") {
      await this.clearThread(message.chatId, message);
      return;
    }
    if (payload === "review") {
      await this.runBuiltin(message.chatId, "review");
      return;
    }
    if (payload === "compact") {
      await this.runBuiltin(message.chatId, "compact");
      return;
    }
    if (payload === "x?") {
      await this.renderCallbackPage(message, confirmMessage("Stop Codex session?", "The selected cwd stays active."), exitConfirmKeyboard());
      return;
    }
    if (payload === "x!") {
      await this.stopFromCallback(message);
      return;
    }
    if (payload === "c") {
      await this.renderStatusCallback(message);
      return;
    }
    if (payload.startsWith("uh:")) {
      const token = payload.slice("uh:".length);
      const name = await this.workspaceNameForToken(token);
      const workspace = this.requireWorkspace(name);
      this.deps.store.bindChat(message.chatId, workspace.name);
      this.logger.info("router.workspace_selected", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
      await this.ensureAgentStarted(message.chatId, workspace);
      await this.renderStatusCallback(message);
      return;
    }
    if (payload.startsWith("u:")) {
      const name = payload.slice("u:".length);
      const workspace = this.requireWorkspace(name);
      this.deps.store.bindChat(message.chatId, workspace.name);
      this.logger.info("router.workspace_selected", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
      await this.ensureAgentStarted(message.chatId, workspace);
      await this.renderStatusCallback(message);
      return;
    }

    throw new Error("Unknown callback.");
  }

  private async renderStatusCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatStatusMessage(status), consoleKeyboard(status));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.chatId, message.messageId);
  }

  private async renderDetailsCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatDetailsMessage(status), consoleKeyboard(status));
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

  private async renderWorkspaces(chatId: ChatId): Promise<void> {
    const workspaces = await this.listAvailableWorkspaces();
    const selected = this.currentWorkspace(chatId)?.name;
    const page = paginateWorkspaces(workspaces, selected, 0);
    await this.sendRendered(chatId, formatWorkspacesMessage(page.items.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    })), page.pageIndex, page.totalPages), {
      replyMarkup: workspacesKeyboard(page.items, selected, page.pageIndex, page.totalPages),
    });
  }

  private async stopFromCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.logger.info("router.session_stopped", { chat_id: message.chatId, workspace: workspace.name, session_key: key });
    await this.renderCallbackPage(message, messageWithTitle("Codex session stopped."), consoleKeyboard(this.statusView(message.chatId)));
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
    if (previousMessageId) {
      try {
        await this.editRendered(chatId, formatStatusMessage(status), {
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
    const result = await this.sendRendered(chatId, formatStatusMessage(status), { replyMarkup: consoleKeyboard(status) });
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

  private async promptForAgentInstruction(chatId: ChatId): Promise<void> {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) {
      await this.promptForWorkspaceName(chatId);
      return;
    }
    const status = await this.ensureAgentStarted(chatId, workspace);
    if (await this.sendWaitingPromptNotice(chatId, status)) return;
    const active = Boolean(status.activeTurnId);
    const result = await this.sendRendered(chatId, renderTelegramText([
      bold(active ? "Add to current turn" : "Prompt Codex"),
      "\n\nReply with the ",
      active ? "follow-up for " : "prompt for ",
      code(workspace.name),
      ".",
    ]), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) {
      throw new Error("Telegram did not return a prompt message id.");
    }
    this.deps.store.setPendingPrompt({
      chatId,
      promptMessageId: result.messageId,
      kind: "agent_instruction",
      createdAt: Date.now(),
      sessionKey: status.sessionKey,
      payloadJson: JSON.stringify({ mode: active ? "follow_up" : "new_task" }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
    this.logger.info("router.agent_instruction_prompt_created", { chat_id: chatId, prompt_message_id: result.messageId, workspace: workspace.name });
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

  private async answerAgentInstructionPrompt(chatId: ChatId, promptMessageId: number, text: string, userMessageId?: number): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(chatId, promptMessageId);
    if (!pending || pending.kind !== "agent_instruction" || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(chatId, promptMessageId);
      await this.sendRendered(chatId, textMessage("Prompt expired."));
      return;
    }
    this.deps.store.deletePendingPrompt(chatId, promptMessageId);
    const data = parsePromptPayload(pending.payloadJson);
    if (data?.mode === "follow_up") {
      await this.addContextToAgent(chatId, text, userMessageId);
    } else {
      await this.submitTask(chatId, text, userMessageId, "immediate");
    }
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
      await this.sendRendered(chatId, queuedTaskMessage(task), { replyMarkup: queuedTaskKeyboard(task) });
      return;
    }
    await this.runTask(workspace, task);
  }

  private async addContextToAgent(chatId: ChatId, text: string, userMessageId?: number): Promise<void> {
    if (!text) return;
    const workspace = this.requireCurrentWorkspace(chatId);
    const status = await this.ensureAgentStarted(chatId, workspace);
    if (!status.activeTurnId) {
      await this.submitTask(chatId, text, userMessageId, "immediate");
      return;
    }
    await this.sendToAgent(chatId, workspace, text, userMessageId, this.deps.store.activeTask(chatId, workspace.name));
  }

  private async runTask(workspace: WorkspaceRecord, task: RelayTask): Promise<void> {
    this.deps.store.updateTask(task.id, { status: "running" });
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
    const result = await this.deps.agent.send(key, text);
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

  private async handleSlashCommand(chatId: ChatId, command: string, text: string, userMessageId?: number): Promise<boolean> {
    switch (command) {
      case "/help":
        await this.sendRendered(chatId, formatRelayHelp());
        return true;
      case "/status":
        await this.renderConsole(chatId);
        return true;
      case "/cd": {
        const body = commandBody(text);
        if (!body) {
          await this.renderWorkspaces(chatId);
        } else {
          await this.selectOrCreateWorkspace(chatId, body);
        }
        return true;
      }
      case "/new":
        await this.sendRendered(chatId, confirmMessage("Start a new Codex session?", "This replaces the current thread binding for the selected cwd."), { replyMarkup: clearConfirmKeyboard() });
        return true;
      case "/init":
        await this.submitTask(chatId, INIT_PROMPT, userMessageId, "immediate");
        return true;
      case "/exec":
      case "/ask": {
        const body = commandBody(text);
        if (!body) {
          await this.promptForAgentInstruction(chatId);
        } else {
          await this.submitTask(chatId, body, userMessageId, "auto");
        }
        return true;
      }
      case "/add": {
        const body = commandBody(text);
        if (!body) {
          await this.promptForAgentInstruction(chatId);
        } else {
          await this.addContextToAgent(chatId, body, userMessageId);
        }
        return true;
      }
      case "/later": {
        const body = commandBody(text);
        if (!body) throw new Error("/later requires prompt text.");
        await this.submitTask(chatId, body, userMessageId, "queue");
        return true;
      }
      case "/plan":
      case "/fix":
      case "/test":
      case "/explain": {
        const body = commandBody(text);
        if (!body) throw new Error(`${command} requires task text.`);
        await this.submitTask(chatId, templatePrompt(command, body), userMessageId, "auto");
        return true;
      }
      case "/queue":
        {
          const body = commandBody(text);
          if (body) await this.submitTask(chatId, body, userMessageId, "queue");
          else await this.renderQueue(chatId);
        }
        return true;
      case "/review":
        await this.runBuiltin(chatId, "review", userMessageId);
        return true;
      case "/compact":
        await this.runBuiltin(chatId, "compact", userMessageId);
        return true;
      case "/model":
        await this.renderModelInfo(chatId);
        return true;
      case "/clear":
        await this.sendRendered(chatId, confirmMessage("Start a new Codex session?", "This replaces the current thread binding for the selected cwd."), { replyMarkup: clearConfirmKeyboard() });
        return true;
      case "/resume":
        await this.renderResumeThreads(chatId);
        return true;
      default:
        return false;
    }
  }

  private async runBuiltin(chatId: ChatId, command: "review" | "compact", userMessageId?: number): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const status = await this.ensureAgentStarted(chatId, workspace);
    if (!this.deps.agent.runBuiltinCommand) throw new Error("Codex app-server does not support this built-in command.");
    await this.finalizeSessionOutput(status.sessionKey);
    if (userMessageId) this.lastUserMessageIds.set(status.sessionKey, userMessageId);
    const result = await this.deps.agent.runBuiltinCommand(status.sessionKey, command);
    await this.sendRendered(chatId, messageWithTitle(result.message));
  }

  private async renderModelInfo(chatId: ChatId): Promise<void> {
    const workspace = this.currentWorkspace(chatId);
    const status = workspace ? this.deps.agent.getStatus(sessionKey(chatId, workspace.name)) : undefined;
    const models = this.deps.agent.listModels ? await this.deps.agent.listModels() : [];
    await this.sendRendered(chatId, formatModelInfo(status, models));
  }

  private async clearThread(chatId: ChatId, callback?: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const key = sessionKey(chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    await this.ensureAgentStarted(chatId, workspace);
    const body = messageWithTitle("Started a new Codex thread.");
    if (callback) {
      await this.renderCallbackPage(callback, body, consoleKeyboard(this.statusView(chatId)));
    } else {
      await this.sendRendered(chatId, body, { replyMarkup: consoleKeyboard(this.statusView(chatId)) });
    }
  }

  private async renderResumeThreads(chatId: ChatId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    if (!this.deps.agent.listThreads) throw new Error("Codex app-server does not support thread listing.");
    const threads = await this.deps.agent.listThreads({ workspacePath: workspace.path, limit: 10 });
    await this.sendRendered(chatId, formatResumeThreads(threads, 0, Math.max(1, Math.ceil(threads.length / LIST_PAGE_SIZE))), {
      replyMarkup: resumeThreadsKeyboard(chatId, workspace, threads, 0, this.rememberResumeThread.bind(this)),
    });
  }

  private async renderResumeThreadsCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, rawPageIndex: number): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    if (!this.deps.agent.listThreads) throw new Error("Codex app-server does not support thread listing.");
    const threads = await this.deps.agent.listThreads({ workspacePath: workspace.path, limit: 10 });
    const totalPages = Math.max(1, Math.ceil(threads.length / LIST_PAGE_SIZE));
    const pageIndex = clampPage(rawPageIndex, totalPages);
    await this.renderCallbackPage(
      message,
      formatResumeThreads(threads, pageIndex, totalPages),
      resumeThreadsKeyboard(message.chatId, workspace, threads, pageIndex, this.rememberResumeThread.bind(this)),
    );
  }

  private async resumeThreadCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const token = payload.slice("r:".length);
    const entry = this.resumeThreads.get(token);
    if (!entry || entry.chatId !== message.chatId || entry.expiresAt < Date.now()) {
      this.resumeThreads.delete(token);
      throw new Error("Resume option expired. Run /resume again.");
    }
    const workspace = this.requireCurrentWorkspace(message.chatId);
    if (workspace.name !== entry.workspaceName || workspace.path !== entry.workspacePath) {
      throw new Error("Workspace changed. Run /resume again.");
    }
    const key = sessionKey(message.chatId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    const status = await this.ensureAgentStarted(message.chatId, workspace, entry.threadId);
    await this.renderCallbackPage(message, renderTelegramText([
      bold("Resumed thread:"),
      " ",
      code(status.threadName ?? entry.threadName ?? entry.threadId),
    ]), consoleKeyboard(this.statusView(message.chatId)));
  }

  private async renderQueue(chatId: ChatId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const tasks = this.deps.store.listTasks(chatId, workspace.name, ["queued"], LIST_PAGE_SIZE);
    await this.sendRendered(chatId, formatQueueMessage(tasks), { replyMarkup: queueKeyboard(tasks) });
  }

  private async renderQueueCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const tasks = this.deps.store.listTasks(message.chatId, workspace.name, ["queued"], LIST_PAGE_SIZE);
    await this.renderCallbackPage(message, formatQueueMessage(tasks), queueKeyboard(tasks));
  }

  private async routeTaskCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const [, rawId, action] = payload.split(":");
    const taskId = Number(rawId);
    if (!Number.isInteger(taskId)) throw new Error("Invalid task.");
    const task = this.deps.store.getTask(taskId);
    if (!task || task.chatId !== message.chatId) throw new Error("Task not found.");
    const workspace = this.requireCurrentWorkspace(message.chatId);
    if (workspace.name !== task.workspaceName) throw new Error("Queued prompt belongs to another cwd.");
    if (action === "del") {
      if (task.status !== "queued") throw new Error("Only queued prompts can be deleted.");
      this.deps.store.updateTask(task.id, { status: "cancelled" });
      await this.renderQueueCallback(message);
      return;
    }
    if (action === "run") {
      if (task.status !== "queued") throw new Error("Only queued prompts can be run.");
      const status = await this.ensureAgentStarted(message.chatId, workspace);
      if (status.activeTurnId || status.waitingForApproval || status.waitingForUserInput) {
        throw new Error("Codex is busy. The prompt will stay queued.");
      }
      await this.renderCallbackPage(message, messageWithTitle(`Running prompt #${task.id}.`), { inline_keyboard: [] });
      await this.runTask(workspace, task);
      return;
    }
    throw new Error("Unknown task action.");
  }

  private markActiveTask(sessionKeyValue: string, status: "blocked" | "running"): void {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const task = this.deps.store.activeTask(parsed.chatId, parsed.workspaceName);
    if (task) this.deps.store.updateTask(task.id, { status });
  }

  private async completeTaskAndDispatchNext(sessionKeyValue: string, turnId: string | undefined): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const active = this.deps.store.activeTask(parsed.chatId, parsed.workspaceName);
    if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
      this.deps.store.updateTask(active.id, { status: "done" });
      await this.sendRendered(parsed.chatId, messageWithTitle(`Prompt #${active.id} completed.`), { replyMarkup: resultKeyboard() });
    }
    const workspace = this.currentWorkspace(parsed.chatId);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (status?.waitingForApproval || status?.waitingForUserInput || status?.activeTurnId) return;
    const next = this.deps.store.nextQueuedTask(parsed.chatId, parsed.workspaceName);
    if (next) {
      await this.sendRendered(parsed.chatId, messageWithTitle(`Running queued prompt #${next.id}.`));
      await this.runTask(workspace, next);
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
    if (!workspace) throw new Error("No cwd selected. Use /cd <name> or /cd to select one.");
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
    if (!isRealDirectory(workspace.path)) throw new Error(`cwd '${name}' does not exist. Create it with /cd ${name}.`);
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

  private rememberResumeThread(chatId: ChatId, workspace: WorkspaceRecord, thread: AgentThreadSummary): string {
    for (const [token, entry] of this.resumeThreads) {
      if (entry.expiresAt < Date.now()) this.resumeThreads.delete(token);
    }
    const token = shortToken();
    this.resumeThreads.set(token, {
      chatId,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      threadId: thread.id,
      threadName: thread.name,
      expiresAt: Date.now() + RESUME_THREAD_TTL_MS,
    });
    return token;
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

  private readonly resumeThreads = new Map<string, {
    chatId: ChatId;
    workspaceName: string;
    workspacePath: string;
    threadId: string;
    threadName?: string;
    expiresAt: number;
  }>();

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
    const result = question.isSecret || options.length === 0
      ? await this.sendRendered(chatId, formatCodexQuestion(question, questionIndex, totalQuestions), { forceReply: true, disableWebPagePreview: true })
      : await this.sendRendered(chatId, formatCodexQuestion(question, questionIndex, totalQuestions), {
        replyMarkup: codexQuestionKeyboard(token, questionIndex, options),
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

  private async answerCodexOption(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, rawQuestionIndex, rawOptionIndex] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.chatId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
      return;
    }

    const questionIndex = Number(rawQuestionIndex);
    const optionIndex = Number(rawOptionIndex);
    const options = Array.isArray(data.options) ? data.options : [];
    if (!Number.isInteger(questionIndex) || questionIndex !== data.questionIndex || !Number.isInteger(optionIndex)) {
      throw new Error("Invalid question answer.");
    }

    if (optionIndex === options.length) {
      const result = await this.sendRendered(message.chatId, textMessage("Reply with your answer."), {
        forceReply: true,
        disableWebPagePreview: true,
      });
      if (!result.messageId) throw new Error("Telegram did not return a prompt message id.");
      this.deps.store.setPendingPrompt({
        chatId: message.chatId,
        promptMessageId: result.messageId,
        kind: "codex_user_input",
        createdAt: Date.now(),
        sessionKey: pending.sessionKey,
        payloadJson: pending.payloadJson,
        expiresAt: pending.expiresAt,
      });
      this.deps.store.deletePendingPrompt(message.chatId, pending.promptMessageId);
      await this.renderCallbackPage(message, messageWithTitle("Waiting for custom answer."), { inline_keyboard: [] });
      return;
    }

    const option = options[optionIndex] as { label?: unknown } | undefined;
    if (!option || typeof option.label !== "string") throw new Error("Invalid question option.");
    const response = await this.recordCodexAnswer(pending, data, option.label);
    if (response === "expired") return;
    const hasNext = !response && await this.sendNextCodexQuestion(message.chatId, pending, data);
    await this.renderCallbackPage(message, answeredMessage(option.label, hasNext), { inline_keyboard: [] });
    if (response) await this.respondToCodexPrompt(response);
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
    await this.renderCallbackPage(message, messageWithTitle(approved ? "Approved." : "Denied."), { inline_keyboard: [] });
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, approved, data.params));
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

function commandBody(text: string): string {
  const firstSpace = text.search(/\s/);
  return firstSpace < 0 ? "" : text.slice(firstSpace + 1).trim();
}

function templatePrompt(command: string, body: string): string {
  switch (command) {
    case "/plan":
      return `Create an implementation plan for this request. Do not modify files unless explicitly asked later.\n\n${body}`;
    case "/fix":
      return `Fix the following issue. Inspect the relevant code first, make the smallest safe change, and run focused verification.\n\n${body}`;
    case "/test":
      return `Add or update tests for the following behavior. Keep the tests focused and run the relevant test command.\n\n${body}`;
    case "/explain":
      return `Explain the following code or behavior with concrete file references where relevant.\n\n${body}`;
    default:
      return body;
  }
}

function decoratePagedOutput(page: RenderedTelegramText, pageIndex: number, totalPages: number): RenderedTelegramText {
  return appendRendered(page, renderTelegramText(["\n\n", bold(`Page ${pageIndex + 1}/${totalPages}`)]));
}

function pagedOutputKeyboard(token: string, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  if (totalPages <= 1) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[
      { text: "⏮", callback_data: `ar:p:${token}:0` },
      { text: "◀", callback_data: `ar:p:${token}:${Math.max(0, pageIndex - 1)}` },
      { text: "▶", callback_data: `ar:p:${token}:${Math.min(totalPages - 1, pageIndex + 1)}` },
      { text: "⏭", callback_data: `ar:p:${token}:${totalPages - 1}` },
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

function queuedTaskMessage(task: RelayTask): RenderedTelegramText {
  return renderTelegramText([
    bold(`Queued prompt #${task.id}`),
    "\n\n",
    truncateForTelegramLabel(task.text, 220),
  ]);
}

function formatQueueMessage(tasks: RelayTask[]): RenderedTelegramText {
  if (tasks.length === 0) return messageWithTitle("Prompt backlog", "No queued prompts.");
  const parts: TelegramTextPart[] = [bold("Prompt backlog")];
  for (const task of tasks) {
    parts.push("\n\n", bold(`#${task.id}`), " ", truncateForTelegramLabel(task.text, 160));
  }
  return renderTelegramText(parts);
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
  return renderTelegramText(parts);
}

function codexQuestionKeyboard(token: string, questionIndex: number, options: Array<{ label: string }>): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const [index, option] of options.entries()) {
    rows.push([{ text: option.label, callback_data: `ar:q:${token}:${questionIndex}:${index}` }]);
  }
  rows.push([{ text: "💬", callback_data: `ar:q:${token}:${questionIndex}:${options.length}` }]);
  return { inline_keyboard: rows };
}

function approvalKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "✅", callback_data: `ar:a:${token}:y` },
      { text: "❌", callback_data: `ar:a:${token}:n` },
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

function formatStatusMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) {
    return renderTelegramText([
      bold("Codex"),
      "\n\n● Stopped",
      "\ncwd: none",
      "\nUse /cd <name> to select or create a cwd.",
    ]);
  }
  const parts: TelegramTextPart[] = [
    bold("Codex"),
    "\n\n",
    statusDot(status),
    " ",
    statusLabel(status),
    "\ncwd: ",
    code(truncateForTelegramLabel(status.workspaceName, 32)),
    "\nModel: ",
    status.model ? code(truncateForTelegramLabel(status.model, 28)) : "unknown",
  ];
  if (status.reasoningEffort) parts.push(" / ", status.reasoningEffort);
  parts.push(
    "\nContext: ",
    formatContext(status),
    "\nWaiting: ",
    formatWaiting(status),
    "\nPrompts: ",
    formatTaskCounts(status),
  );
  if (status.recentOutputAt) parts.push("\nLast output: ", relativeTime(status.recentOutputAt));
  if (status.recentError) parts.push("\nError: ", truncateForTelegramLabel(status.recentError.trim(), 120));
  return renderTelegramText(parts);
}

function formatDetailsMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) return formatStatusMessage(status);
  const parts: TelegramTextPart[] = [
    bold("Codex status"),
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
    "\nToken usage: ",
    formatTokens(status),
  );
  return renderTelegramText(parts);
}

function statusDot(status: StatusView): string {
  if (status.recentError) return "●";
  if (status.waitingForApproval || status.waitingForUserInput) return "●";
  return status.running ? "●" : "●";
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
      bold("Select cwd"),
      "\n\nNo cwd directories found.\nUse /cd <name> to create one.",
    ]);
  }
  const parts: TelegramTextPart[] = [bold("Select cwd"), `\n\nPage ${pageIndex + 1}/${totalPages}`];
  for (const workspace of workspaces) {
    parts.push("\n", workspace.selected ? "● " : "○ ", code(workspace.name));
  }
  return renderTelegramText(parts);
}

function formatRelayHelp(): RenderedTelegramText {
  return renderTelegramText([
    bold("Codex commands"),
    "\n\n",
    "Send any message to Codex, like ",
    code("fix the failing tests"),
    ". Slash text that is not a relay command is also sent to Codex.\n\n",
    code("/codex"),
    " - show the Codex panel\n",
    code("/cd <name>"),
    " - select or create the cwd under WORKSPACE_ROOT\n",
    code("/status"),
    " - show session status\n",
    code("/new"),
    " - start a fresh Codex session\n",
    code("/exec <prompt>"),
    " - send a prompt explicitly\n",
    code("/add"),
    " - add to the active turn\n",
    code("/queue <prompt>"),
    " - queue a prompt for later\n",
    code("/queue"),
    " - show queued prompts\n",
    code("/init"),
    " - ask Codex to create AGENTS.md\n",
    code("/review"),
    " - start a Codex review\n",
    code("/compact"),
    " - compact the current thread\n",
    code("/model"),
    " - show current and available models\n",
    code("/clear"),
    " - alias for /new\n",
    code("/resume"),
    " - resume a saved session",
  ]);
}

function formatModelInfo(status: AgentSessionStatus | undefined, models: AgentModelSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [
    bold("Codex model"),
    "\n\nCurrent: ",
    status?.model ? code(status.model) : "unknown",
  ];
  if (status?.reasoningEffort) parts.push("\nReasoning: ", code(status.reasoningEffort));
  if (models.length > 0) {
    parts.push("\n\n", bold("Available:"));
    for (const model of models.slice(0, 12)) {
      const label = model.displayName ?? model.id;
      const current = status?.model && (status.model === model.id || status.model === model.model) ? " current" : "";
      const def = model.isDefault ? " default" : "";
      parts.push("\n- ", code(model.id), ` ${label}${current}${def}`);
    }
  } else {
    parts.push("\n\nModel list is unavailable from this Codex app-server.");
  }
  return renderTelegramText(parts);
}

function formatResumeThreads(threads: AgentThreadSummary[], pageIndex: number, totalPages: number): RenderedTelegramText {
  if (threads.length === 0) {
    return renderTelegramText([
      bold("Resume session"),
      "\n\nNo saved sessions were found for the current workspace.",
    ]);
  }
  const start = pageIndex * LIST_PAGE_SIZE;
  const items = threads.slice(start, start + LIST_PAGE_SIZE);
  const parts: TelegramTextPart[] = [bold("Resume session"), `\n\nPage ${pageIndex + 1}/${totalPages}`];
  for (const [index, thread] of items.entries()) {
    const title = thread.name || thread.preview || thread.id;
    const updated = thread.updatedAt ? ` ${new Date(thread.updatedAt * 1000).toISOString()}` : "";
    parts.push(`\n${start + index + 1}. `, code(title.slice(0, 80)), updated);
  }
  return renderTelegramText(parts);
}

function resumeThreadButtonText(thread: AgentThreadSummary): string {
  const value = thread.name || thread.preview || thread.id;
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

function consoleKeyboard(status: { workspaceName?: string; running?: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (status.workspaceName) {
    rows.push([
      { text: "✎ Prompt", callback_data: "ar:i" },
      { text: "🔍 Review", callback_data: "ar:review" },
      { text: "📦 Compact", callback_data: "ar:compact" },
    ]);
    rows.push([
      { text: "📂 cwd", callback_data: "ar:w" },
      { text: "⏎ Resume", callback_data: "ar:rl:0" },
      { text: "🆕 New", callback_data: "ar:clear?" },
    ]);
    rows.push(status.running
      ? [
        { text: "ℹ️ Status", callback_data: "ar:d" },
        { text: "🛑 Stop", callback_data: "ar:x?" },
        { text: "↻", callback_data: "ar:s" },
      ]
      : [{ text: "↻", callback_data: "ar:s" }]);
  } else {
    rows.push([
      { text: "📂 cwd", callback_data: "ar:w" },
      { text: "➕ cwd", callback_data: "ar:n" },
      { text: "↻", callback_data: "ar:s" },
    ]);
  }
  return {
    inline_keyboard: rows,
  };
}

function queueKeyboard(tasks: RelayTask[]): InlineKeyboardMarkup {
  const rows = tasks.flatMap((task) => [
    [{ text: `▶ Run #${task.id}`, callback_data: `ar:qt:${task.id}:run` }],
    [{ text: `🗑 Delete #${task.id}`, callback_data: `ar:qt:${task.id}:del` }],
  ]);
  rows.push([{ text: "↻ Codex", callback_data: "ar:home" }]);
  return { inline_keyboard: rows };
}

function queuedTaskKeyboard(task: RelayTask): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "▶ Run now", callback_data: `ar:qt:${task.id}:run` },
      { text: "🗑 Delete", callback_data: `ar:qt:${task.id}:del` },
    ], [
      { text: "🧾 Backlog", callback_data: "ar:queue" },
      { text: "↻ Codex", callback_data: "ar:home" },
    ]],
  };
}

function resultKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "✎ Prompt", callback_data: "ar:i" },
      { text: "🧾 Backlog", callback_data: "ar:queue" },
      { text: "↻ Codex", callback_data: "ar:home" },
    ]],
  };
}

function workspacesKeyboard(workspaces: WorkspaceRecord[], selected: string | undefined, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  const rows = workspaces.map((workspace) => [{
    text: `${workspace.name === selected ? "● " : "○ "}${buttonLabel(workspace.name)}`,
    callback_data: workspaceCallbackData(workspace.name),
  }]);
  if (totalPages > 1) {
    rows.push([
      { text: "◀", callback_data: `ar:wl:${Math.max(0, pageIndex - 1)}` },
      { text: "▶", callback_data: `ar:wl:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }

  return {
    inline_keyboard: [
      ...rows,
      [
        { text: "➕ cwd", callback_data: "ar:n" },
        { text: "↻", callback_data: "ar:s" },
      ],
    ],
  };
}

function resumeThreadsKeyboard(
  chatId: ChatId,
  workspace: WorkspaceRecord,
  threads: AgentThreadSummary[],
  pageIndex: number,
  remember: (chatId: ChatId, workspace: WorkspaceRecord, thread: AgentThreadSummary) => string,
): InlineKeyboardMarkup {
  const totalPages = Math.max(1, Math.ceil(threads.length / LIST_PAGE_SIZE));
  const start = pageIndex * LIST_PAGE_SIZE;
  const rows = threads.slice(start, start + LIST_PAGE_SIZE).map((thread) => {
    const token = remember(chatId, workspace, thread);
    return [{ text: resumeThreadButtonText(thread), callback_data: `ar:r:${token}` }];
  });
  if (totalPages > 1) {
    rows.push([
      { text: "◀", callback_data: `ar:rl:${Math.max(0, pageIndex - 1)}` },
      { text: "▶", callback_data: `ar:rl:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }
  rows.push([{ text: "🔄", callback_data: "ar:rl:0" }]);
  return { inline_keyboard: rows.length > 0 ? rows : [[{ text: "🔄", callback_data: "ar:s" }]] };
}

function clearConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "🆕", callback_data: "ar:clear!" },
      { text: "⬅", callback_data: "ar:c" },
    ]],
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

function workspaceCallbackData(name: string): string {
  const callbackData = `ar:uh:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

function workspaceCallbackToken(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

function isConsolePayload(payload: string): boolean {
  return payload === "s"
    || payload === "w"
    || payload === "n"
    || payload === "i"
    || payload === "d"
    || payload === "review"
    || payload === "compact"
    || payload === "x?"
    || payload === "clear?"
    || payload === "queue"
    || payload.startsWith("wl:")
    || payload.startsWith("rl:")
    || payload.startsWith("uh:")
    || payload.startsWith("u:");
}

function exitConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🛑", callback_data: "ar:x!" },
        { text: "⬅", callback_data: "ar:c" },
      ],
    ],
  };
}
