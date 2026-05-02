import { existsSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { isAuthorized } from "./config.ts";
import { sessionKey } from "./agent.ts";
import type { AgentDriver, ChatId, IMAdapter, InboundMessage, InlineKeyboardMarkup, SendMessageResult, WorkspaceRecord } from "./types.ts";
import type { Store } from "./store.ts";
import { createWorkspace, resolveWorkspacePath, validateWorkspaceName } from "./workspace.ts";
import { formatError, formatStatus, formatWorkspaces, htmlEscape, renderCodexMarkdownForTelegram, splitRenderedForTelegram, tailLines } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

const CALLBACK_PREFIX = "ar:";
const CALLBACK_LIMIT_BYTES = 64;
const HTML = { parseMode: "HTML" as const };
const STREAM_QUIET_MS = 800;
const STREAM_MAX_MS = 3000;
const STREAM_FLUSH_CHARS = 3400;

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

  async handleAgentOutput(session: { sessionKey: string; chunk: string }): Promise<void> {
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

  private async tail(chatId: ChatId, rawCount?: string): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const count = rawCount ? Number(rawCount) : 50;
    if (!Number.isInteger(count) || count < 1) throw new Error("Tail count must be a positive integer.");
    const text = this.deps.store.recentTranscript(chatId, workspace.name, "agent", 500);
    this.logger.info("router.tail_reported", { chat_id: chatId, workspace: workspace.name, count, text_len: text.length });
    if (!text) {
      await this.deps.adapter.sendMessage(chatId, "No agent output yet.");
      return;
    }
    const rendered = renderCodexMarkdownForTelegram(tailLines(text, count));
    await this.deps.adapter.sendMessage(chatId, rendered.text, {
      entities: rendered.entities,
      disableWebPagePreview: true,
    });
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
    if (payload === "t50") {
      await this.tail(message.chatId, "50");
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
      await this.deps.agent.start({ chatId, workspaceName: workspace.name, workspacePath: workspace.path });
      this.deps.store.markSessionStarted(key, chatId, workspace.name);
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

function consoleKeyboard(status: { workspaceName?: string; running?: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [
      { text: "Workspaces", callback_data: "ar:w" },
      { text: "New workspace", callback_data: "ar:n" },
    ],
  ];
  if (status.workspaceName) {
    rows.push([
      { text: "Tail 50", callback_data: "ar:t50" },
      ...(status.running ? [{ text: "Stop", callback_data: "ar:x?" }] : []),
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
