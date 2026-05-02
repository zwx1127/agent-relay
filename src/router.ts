import { existsSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { isAuthorized } from "./config.ts";
import { sessionKey } from "./agent.ts";
import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentDriver,
  AgentOutputEvent,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
  ChatId,
  IMAdapter,
  InboundMessage,
  InlineKeyboardMarkup,
  SendMessageResult,
  WorkspaceRecord,
} from "./types.ts";
import type { Store } from "./store.ts";
import { createWorkspace, resolveWorkspacePath, validateWorkspaceName } from "./workspace.ts";
import { formatError, formatStatus, formatWorkspaces, htmlEscape, renderCodexMarkdownForTelegram, splitRenderedForTelegram } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

const CALLBACK_PREFIX = "ar:";
const CALLBACK_LIMIT_BYTES = 64;
const HTML = { parseMode: "HTML" as const };
const STREAM_QUIET_MS = 800;
const STREAM_MAX_MS = 3000;
const STREAM_FLUSH_CHARS = 3400;
const CODEX_PROMPT_TTL_MS = 30 * 60 * 1000;

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<IMAdapter, "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction">;
  agent: AgentDriver;
  logger?: Logger;
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
      await this.deps.adapter.sendMessage(message.chatId, "Unauthorized.", HTML);
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
      } else if (command === "/relay" || command === "/start") {
        await this.renderConsole(message.chatId);
      } else {
        await this.forwardToAgent(message.chatId, text);
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
      await this.deps.adapter.sendMessage(message.chatId, formatError(detail), HTML);
      this.appendSystem(message.chatId, `Error: ${detail}\n`);
    }
  }

  async handleAgentOutput(session: AgentOutputEvent): Promise<void> {
    if (session.type === "turn_completed") {
      await this.flushSessionOutput(session.sessionKey);
      return;
    }
    if (session.type === "user_input_request") {
      await this.handleCodexUserInputRequest(session);
      return;
    }
    if (session.type === "approval_request") {
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
    await this.bufferAgentOutput(session.sessionKey, parsed.chatId, session.chunk);
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
    await this.flushSessionOutput(sessionKeyValue);
    this.liveOutput.delete(sessionKeyValue);
    await this.deps.adapter.sendMessage(parsed.chatId, `<b>${htmlEscape(exitText)}</b>`, HTML);
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
      await this.renderCallbackPage(message, formatError(detail), consoleKeyboard(this.statusView(message.chatId)));
      this.appendSystem(message.chatId, `Error: ${detail}\n`);
    }
  }

  private async routeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (!message.data.startsWith(CALLBACK_PREFIX)) throw new Error("Unknown callback.");
    const payload = message.data.slice(CALLBACK_PREFIX.length);

    if (payload === "s") {
      await this.renderStatusCallback(message);
      return;
    }
    if (payload === "w") {
      await this.renderWorkspacesCallback(message);
      return;
    }
    if (payload === "n") {
      await this.promptForWorkspaceName(message.chatId);
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
    if (payload === "x?") {
      await this.renderCallbackPage(message, [
        "<b>Stop Codex session?</b>",
        "",
        "The current workspace binding will remain selected.",
      ].join("\n"), exitConfirmKeyboard());
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
    if (payload.startsWith("u:")) {
      const name = payload.slice("u:".length);
      const workspace = this.requireWorkspace(name);
      this.deps.store.bindChat(message.chatId, workspace.name);
      this.logger.info("router.workspace_selected", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
      await this.renderStatusCallback(message);
      return;
    }

    throw new Error("Unknown callback.");
  }

  private async renderStatusCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.chatId);
    await this.renderCallbackPage(message, formatStatus(status), consoleKeyboard(status));
  }

  private async renderWorkspacesCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspaces = this.deps.store.listWorkspaces();
    const selected = this.currentWorkspace(message.chatId)?.name;
    await this.renderCallbackPage(message, formatWorkspaces(workspaces.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    }))), workspacesKeyboard(workspaces, selected));
  }

  private async stopFromCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace.name);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.logger.info("router.session_stopped", { chat_id: message.chatId, workspace: workspace.name, session_key: key });
    await this.renderCallbackPage(message, "<b>Codex session stopped.</b>", consoleKeyboard(this.statusView(message.chatId)));
  }

  private async renderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    if (!message.messageId) {
      await this.deps.adapter.sendMessage(message.chatId, text, { ...HTML, replyMarkup });
      return;
    }
    try {
      await this.deps.adapter.editMessageText(message.chatId, text, {
        ...HTML,
        messageId: message.messageId,
        replyMarkup,
      });
    } catch (error) {
      this.logger.warn("router.callback_edit_fallback", {
        chat_id: message.chatId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.deps.adapter.sendMessage(message.chatId, text, { ...HTML, replyMarkup });
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

  private async renderConsole(chatId: ChatId): Promise<void> {
    const status = this.statusView(chatId);
    this.logger.info("router.console_rendered", {
      chat_id: chatId,
      workspace: status.workspaceName,
      running: Boolean(status.running),
    });
    await this.deps.adapter.sendMessage(chatId, formatStatus(status), { ...HTML, replyMarkup: consoleKeyboard(status) });
  }

  private async promptForWorkspaceName(chatId: ChatId): Promise<void> {
    const result = await this.deps.adapter.sendMessage(chatId, "Reply with the new workspace name.", {
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
    validateWorkspaceName(name);
    const path = await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindChat(chatId, name);
    this.deps.store.deletePendingPrompt(chatId, promptMessageId);
    this.logger.info("router.workspace_created", { chat_id: chatId, workspace: name, path });
    await this.deps.adapter.sendMessage(chatId, `Workspace <code>${htmlEscape(name)}</code> created and selected.`, {
      ...HTML,
      replyMarkup: consoleKeyboard(this.statusView(chatId)),
    });
  }

  private async forwardToAgent(chatId: ChatId, text: string): Promise<void> {
    if (!text) return;
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) {
      await this.renderConsole(chatId);
      return;
    }
    if (!existsSync(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const key = sessionKey(chatId, workspace.name);
    if (!this.deps.agent.getStatus(key)) {
      this.logger.info("router.session_starting", { chat_id: chatId, workspace: workspace.name, session_key: key });
      const previous = this.deps.store.getSession(key);
      const status = await this.deps.agent.start({ chatId, workspaceName: workspace.name, workspacePath: workspace.path, threadId: previous?.thread_id ?? undefined });
      this.deps.store.markSessionStarted(key, chatId, workspace.name, Date.now(), status.threadId);
      this.logger.info("router.session_started", { chat_id: chatId, workspace: workspace.name, session_key: key });
    }
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
    await this.deps.agent.send(key, text);
  }

  private currentWorkspace(chatId: ChatId): WorkspaceRecord | undefined {
    const binding = this.deps.store.getBinding(chatId);
    return binding ? this.deps.store.getWorkspace(binding.workspaceName) : undefined;
  }

  private requireCurrentWorkspace(chatId: ChatId): WorkspaceRecord {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) throw new Error("No workspace selected. Open /relay to select or create one.");
    if (!existsSync(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    return workspace;
  }

  private requireWorkspace(name: string): WorkspaceRecord {
    validateWorkspaceName(name);
    const workspace = this.deps.store.getWorkspace(name) ?? {
      name,
      path: resolveWorkspacePath(this.deps.config.workspaceRoot, name),
      createdAt: Date.now(),
    };
    if (!existsSync(workspace.path)) throw new Error(`Workspace '${name}' does not exist. Create it from the relay console first.`);
    this.deps.store.upsertWorkspace(workspace);
    return workspace;
  }

  private appendSystem(chatId: ChatId, text: string): void {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return;
    this.deps.store.appendTranscript({ chatId, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  private statusView(chatId: ChatId): { workspaceName?: string; workspacePath?: string; running?: boolean; recentOutputAt?: number; recentError?: string } {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(chatId, workspace.name));
    const recentOutput = this.deps.store.latestTranscriptEvent(chatId, workspace.name, "agent");
    const recentError = this.deps.store.latestTranscriptEvent(chatId, workspace.name, "system");
    return {
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      running: Boolean(status?.running),
      recentOutputAt: recentOutput?.createdAt,
      recentError: recentError?.text,
    };
  }

  private readonly liveOutput = new Map<string, {
    chatId: ChatId;
    text: string;
    startedAt: number;
    timer?: Timer;
    messageId?: number;
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

    for (const [index, question] of event.questions.entries()) {
      const options = question.options ?? [];
      const payload = JSON.stringify({
        token,
        requestId: event.requestId,
        questionIndex: index,
        questionId: question.id,
        isSecret: Boolean(question.isSecret),
        options,
      });
      const text = formatCodexQuestion(question);
      const result = question.isSecret || options.length === 0
        ? await this.deps.adapter.sendMessage(parsed.chatId, text, { ...HTML, forceReply: true, disableWebPagePreview: true })
        : await this.deps.adapter.sendMessage(parsed.chatId, text, {
          ...HTML,
          replyMarkup: codexQuestionKeyboard(token, index, options),
          disableWebPagePreview: true,
        });
      if (!result.messageId) throw new Error("Telegram did not return a prompt message id.");
      this.deps.store.setPendingPrompt({
        chatId: parsed.chatId,
        promptMessageId: result.messageId,
        kind: "codex_user_input",
        createdAt: Date.now(),
        sessionKey: event.sessionKey,
        payloadJson: payload,
        expiresAt,
      });
    }
  }

  private async handleCodexApprovalRequest(event: AgentApprovalRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const result = await this.deps.adapter.sendMessage(parsed.chatId, formatApproval(event.title, event.body), {
      ...HTML,
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
      const result = await this.deps.adapter.sendMessage(message.chatId, "Reply with your answer.", {
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
      await this.renderCallbackPage(message, "<b>Waiting for custom answer.</b>", { inline_keyboard: [] });
      return;
    }

    const option = options[optionIndex] as { label?: unknown } | undefined;
    if (!option || typeof option.label !== "string") throw new Error("Invalid question option.");
    await this.recordCodexAnswer(pending, data, option.label);
    await this.renderCallbackPage(message, `<b>Answered:</b> ${htmlEscape(option.label)}`, { inline_keyboard: [] });
  }

  private async answerCodexFreeText(chatId: ChatId, promptMessageId: number, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(chatId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(chatId, promptMessageId);
      await this.deps.adapter.sendMessage(chatId, "Question expired.");
      return;
    }
    await this.recordCodexAnswer(pending, data, text);
    this.deps.store.deletePendingPrompt(chatId, promptMessageId);
    await this.deps.adapter.sendMessage(chatId, data.isSecret ? "<b>Answered.</b>" : `<b>Answered:</b> ${htmlEscape(text)}`, HTML);
  }

  private async recordCodexAnswer(pending: NonNullable<ReturnType<Store["getPendingPrompt"]>>, data: Record<string, unknown>, answer: string): Promise<void> {
    if (!pending.sessionKey) throw new Error("Question session is missing.");
    const requestId = data.requestId as string | number | undefined;
    const questionId = typeof data.questionId === "string" ? data.questionId : undefined;
    if (requestId === undefined || !questionId) throw new Error("Question payload is invalid.");

    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) {
      this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
      await this.deps.adapter.sendMessage(pending.chatId, "Question expired.");
      return;
    }

    request.answers[questionId] = { answers: [answer] };
    this.deps.store.deletePendingPrompt(pending.chatId, pending.promptMessageId);
    if (Object.keys(request.answers).length !== request.questions.length) return;
    this.codexRequests.delete(codexRequestKey(pending.sessionKey, requestId));
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer Codex prompts.");
    await this.deps.agent.respond(pending.sessionKey, requestId, { answers: request.answers });
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
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, approved, data.params));
    this.deps.store.deletePendingPrompt(message.chatId, pending.promptMessageId);
    await this.renderCallbackPage(message, approved ? "<b>Approved.</b>" : "<b>Denied.</b>", { inline_keyboard: [] });
  }

  private async expireCallbackPrompt(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.chatId, message.messageId);
    await this.renderCallbackPage(message, "<b>Question expired.</b>", { inline_keyboard: [] });
  }

  private async bufferAgentOutput(sessionKeyValue: string, chatId: ChatId, chunk: string): Promise<void> {
    let state = this.liveOutput.get(sessionKeyValue);
    if (!state) {
      state = { chatId, text: "", startedAt: Date.now() };
      this.liveOutput.set(sessionKeyValue, state);
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
    state.timer = setTimeout(() => {
      void this.flushSessionOutput(sessionKeyValue).catch((error) => {
        this.logger.error("router.agent_output_send_failed", {
          chat_id: chatId,
          session_key: sessionKeyValue,
          text_len: state?.text.length ?? 0,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }, delay);
  }

  private async flushSessionOutput(sessionKeyValue: string): Promise<void> {
    const state = this.liveOutput.get(sessionKeyValue);
    if (!state || state.text.length === 0) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    const rendered = renderCodexMarkdownForTelegram(state.text);
    const chunks = splitRenderedForTelegram(rendered);
    this.logger.debug("router.agent_output_flushed", {
      chat_id: state.chatId,
      session_key: sessionKeyValue,
      text_len: state.text.length,
      chunks: chunks.length,
    });

    if (chunks.length === 1 && rendered.text.length < STREAM_FLUSH_CHARS) {
      const chunk = chunks[0]!;
      if (state.messageId) {
        try {
          await this.deps.adapter.editMessageText(state.chatId, chunk.text, {
            messageId: state.messageId,
            entities: chunk.entities,
            disableWebPagePreview: true,
          });
          return;
        } catch (error) {
          this.logger.warn("router.agent_output_edit_fallback", {
            chat_id: state.chatId,
            message_id: state.messageId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.deps.adapter.sendMessage(state.chatId, chunk.text, {
        entities: chunk.entities,
        disableWebPagePreview: true,
      });
      state.messageId = result.messageId;
      return;
    }

    if (state.messageId && chunks[0]) {
      try {
        await this.deps.adapter.editMessageText(state.chatId, chunks[0].text, {
          messageId: state.messageId,
          entities: chunks[0].entities,
          disableWebPagePreview: true,
        });
      } catch {
        await this.deps.adapter.sendMessage(state.chatId, chunks[0].text, {
          entities: chunks[0].entities,
          disableWebPagePreview: true,
        });
      }
    } else if (chunks[0]) {
      await this.deps.adapter.sendMessage(state.chatId, chunks[0].text, {
        entities: chunks[0].entities,
        disableWebPagePreview: true,
      });
    }

    let lastResult: SendMessageResult | undefined;
    for (const chunk of chunks.slice(1)) {
      lastResult = await this.deps.adapter.sendMessage(state.chatId, chunk.text, {
        entities: chunk.entities,
        disableWebPagePreview: true,
      });
    }
    state.text = "";
    state.startedAt = Date.now();
    state.messageId = lastResult?.messageId;
  }
}

function commandName(text: string): string | undefined {
  const [command = ""] = text.split(/\s+/);
  return command.split("@")[0] || undefined;
}

export function parseSessionKey(key: string): { chatId: ChatId; workspaceName: string } | undefined {
  const index = key.indexOf(":");
  if (index < 1) return undefined;
  const chatId = Number(key.slice(0, index));
  const workspaceName = key.slice(index + 1);
  if (!Number.isFinite(chatId) || workspaceName.length === 0) return undefined;
  return { chatId, workspaceName };
}

function shortToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

function codexRequestKey(sessionKeyValue: string, requestId: string | number): string {
  return `${sessionKeyValue}:${String(requestId)}`;
}

function formatCodexQuestion(question: AgentUserInputQuestion): string {
  const lines = [
    `<b>${htmlEscape(question.header)}</b>`,
    "",
    htmlEscape(question.question),
  ];
  const options = question.options ?? [];
  if (!question.isSecret && options.length > 0) {
    lines.push("", ...options.map((option) => `<b>${htmlEscape(option.label)}</b>${option.description ? ` - ${htmlEscape(option.description)}` : ""}`));
  }
  return lines.join("\n");
}

function formatApproval(title: string, body: string): string {
  return [`<b>${htmlEscape(title)}</b>`, "", htmlEscape(body)].join("\n");
}

function codexQuestionKeyboard(token: string, questionIndex: number, options: Array<{ label: string }>): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const [index, option] of options.entries()) {
    rows.push([{ text: option.label, callback_data: `ar:q:${token}:${questionIndex}:${index}` }]);
  }
  rows.push([{ text: "Other", callback_data: `ar:q:${token}:${questionIndex}:${options.length}` }]);
  return { inline_keyboard: rows };
}

function approvalKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `ar:a:${token}:y` },
      { text: "Deny", callback_data: `ar:a:${token}:n` },
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

function consoleKeyboard(status: { workspaceName?: string; running?: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "Workspaces", callback_data: "ar:w" },
      { text: "New workspace", callback_data: "ar:n" },
    ],
  ];
  if (status.workspaceName && status.running) {
    rows.push([
      { text: "Stop", callback_data: "ar:x?" },
    ]);
  }
  rows.push([{ text: "Refresh", callback_data: "ar:s" }]);
  return {
    inline_keyboard: rows,
  };
}

function workspacesKeyboard(workspaces: WorkspaceRecord[], selected?: string): InlineKeyboardMarkup {
  const rows = workspaces
    .map((workspace) => {
      const callbackData = `ar:u:${workspace.name}`;
      if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) return undefined;
      return [{
        text: `${workspace.name === selected ? "Current: " : "Use: "}${workspace.name}`,
        callback_data: callbackData,
      }];
    })
    .filter((row): row is Array<{ text: string; callback_data: string }> => Boolean(row));

  return {
    inline_keyboard: [
      ...rows,
      [
        { text: "New workspace", callback_data: "ar:n" },
        { text: "Refresh", callback_data: "ar:s" },
      ],
    ],
  };
}

function exitConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Stop session", callback_data: "ar:x!" },
        { text: "Cancel", callback_data: "ar:c" },
      ],
    ],
  };
}
