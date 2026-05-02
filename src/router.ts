import { existsSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { isAuthorized } from "./config.ts";
import { sessionKey } from "./agent.ts";
import type { AgentDriver, ChatId, IMAdapter, InboundMessage, InlineKeyboardMarkup, WorkspaceRecord } from "./types.ts";
import type { Store } from "./store.ts";
import { createWorkspace, resolveWorkspacePath, validateWorkspaceName } from "./workspace.ts";
import { formatAgentMarkdownForTelegramHtml, formatError, formatHelp, formatStatus, formatWorkspaces, htmlEscape, tailLines } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

const CALLBACK_PREFIX = "ar:";
const CALLBACK_LIMIT_BYTES = 64;
const HTML = { parseMode: "HTML" as const };

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<IMAdapter, "sendMessage" | "editMessageText" | "answerCallbackQuery">;
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
      if (text.startsWith("/")) {
        await this.handleCommand(message.chatId, text);
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
    await this.debouncedSend(parsed.chatId, session.chunk);
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
    await this.deps.adapter.sendMessage(parsed.chatId, `<b>${htmlEscape(exitText)}</b>`, HTML);
  }

  private async handleCommand(chatId: ChatId, text: string): Promise<void> {
    const [command = "", ...rest] = text.split(/\s+/);
    const normalizedCommand = command.split("@")[0];
    const argText = text.slice(command.length).trim();
    this.logger.info("router.command_received", {
      chat_id: chatId,
      command: normalizedCommand,
      arg_len: argText.length,
    });
    this.logger.debug("router.command_text", {
      chat_id: chatId,
      command: normalizedCommand,
      command_text: text,
    });
    switch (normalizedCommand) {
      case "/help":
        await this.deps.adapter.sendMessage(chatId, formatHelp(), { ...HTML, replyMarkup: mainMenuKeyboard() });
        return;
      case "/workspaces":
        await this.listWorkspaces(chatId);
        return;
      case "/new":
        await this.newWorkspace(chatId, rest[0]);
        return;
      case "/use":
        await this.useWorkspace(chatId, rest[0]);
        return;
      case "/status":
        await this.status(chatId);
        return;
      case "/tail":
        await this.tail(chatId, rest[0]);
        return;
      case "/exit":
        await this.exit(chatId);
        return;
      case "/send":
        if (!argText) throw new Error("Usage: /send <text>");
        await this.forwardToAgent(chatId, argText);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private async listWorkspaces(chatId: ChatId): Promise<void> {
    const workspaces = this.deps.store.listWorkspaces();
    const selected = this.currentWorkspace(chatId)?.name;
    this.logger.info("router.workspaces_listed", { chat_id: chatId, count: workspaces.length });
    await this.deps.adapter.sendMessage(chatId, formatWorkspaces(workspaces.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    }))), { ...HTML, replyMarkup: workspacesKeyboard(workspaces, selected) });
  }

  private async newWorkspace(chatId: ChatId, name?: string): Promise<void> {
    if (!name) throw new Error("Usage: /new <name>");
    validateWorkspaceName(name);
    const path = await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindChat(chatId, name);
    this.logger.info("router.workspace_created", { chat_id: chatId, workspace: name, path });
    await this.deps.adapter.sendMessage(chatId, `Workspace <code>${htmlEscape(name)}</code> created and selected.`, {
      ...HTML,
      replyMarkup: statusKeyboard(),
    });
  }

  private async useWorkspace(chatId: ChatId, name?: string): Promise<void> {
    if (!name) throw new Error("Usage: /use <name>");
    const workspace = this.requireWorkspace(name);
    this.deps.store.bindChat(chatId, workspace.name);
    this.logger.info("router.workspace_selected", { chat_id: chatId, workspace: workspace.name, path: workspace.path });
    await this.deps.adapter.sendMessage(chatId, `Using workspace <code>${htmlEscape(workspace.name)}</code>.`, {
      ...HTML,
      replyMarkup: statusKeyboard(),
    });
  }

  private async status(chatId: ChatId): Promise<void> {
    const status = this.statusView(chatId);
    this.logger.info("router.status_reported", {
      chat_id: chatId,
      workspace: status.workspaceName,
      running: Boolean(status.running),
    });
    await this.deps.adapter.sendMessage(chatId, formatStatus(status), { ...HTML, replyMarkup: statusKeyboard() });
  }

  private async tail(chatId: ChatId, rawCount?: string): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const count = rawCount ? Number(rawCount) : 50;
    if (!Number.isInteger(count) || count < 1) throw new Error("Usage: /tail [positive integer]");
    const text = this.deps.store.recentTranscript(chatId, workspace.name, "agent", 500);
    this.logger.info("router.tail_reported", { chat_id: chatId, workspace: workspace.name, count, text_len: text.length });
    await this.deps.adapter.sendMessage(chatId, text ? formatAgentMarkdownForTelegramHtml(tailLines(text, count)) : "No agent output yet.", HTML);
  }

  private async exit(chatId: ChatId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const key = sessionKey(chatId, workspace.name);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.logger.info("router.session_stopped", { chat_id: chatId, workspace: workspace.name, session_key: key });
    await this.deps.adapter.sendMessage(chatId, "<b>Codex session stopped.</b>", { ...HTML, replyMarkup: statusKeyboard() });
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
      await this.renderCallbackPage(message, formatError(detail), mainMenuKeyboard());
      this.appendSystem(message.chatId, `Error: ${detail}\n`);
    }
  }

  private async routeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (!message.data.startsWith(CALLBACK_PREFIX)) throw new Error("Unknown callback.");
    const payload = message.data.slice(CALLBACK_PREFIX.length);

    if (payload === "help") {
      await this.renderCallbackPage(message, formatHelp(), mainMenuKeyboard());
      return;
    }
    if (payload === "status") {
      await this.renderStatusCallback(message);
      return;
    }
    if (payload === "workspaces") {
      await this.renderWorkspacesCallback(message);
      return;
    }
    if (payload === "tail:50") {
      await this.tail(message.chatId, "50");
      return;
    }
    if (payload === "exit:confirm") {
      await this.renderCallbackPage(message, [
        "<b>Stop Codex session?</b>",
        "",
        "The current workspace binding will remain selected.",
      ].join("\n"), exitConfirmKeyboard());
      return;
    }
    if (payload === "exit:run") {
      await this.stopFromCallback(message);
      return;
    }
    if (payload === "cancel") {
      await this.renderStatusCallback(message);
      return;
    }
    if (payload.startsWith("use:")) {
      const name = payload.slice("use:".length);
      const workspace = this.requireWorkspace(name);
      this.deps.store.bindChat(message.chatId, workspace.name);
      this.logger.info("router.workspace_selected", { chat_id: message.chatId, workspace: workspace.name, path: workspace.path });
      await this.renderStatusCallback(message);
      return;
    }

    throw new Error("Unknown callback.");
  }

  private async renderStatusCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    await this.renderCallbackPage(message, formatStatus(this.statusView(message.chatId)), statusKeyboard());
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
    await this.renderCallbackPage(message, "<b>Codex session stopped.</b>", statusKeyboard());
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

  private async forwardToAgent(chatId: ChatId, text: string): Promise<void> {
    if (!text) return;
    const workspace = this.requireCurrentWorkspace(chatId);
    const key = sessionKey(chatId, workspace.name);
    if (!this.deps.agent.getStatus(key)) {
      this.logger.info("router.session_starting", { chat_id: chatId, workspace: workspace.name, session_key: key });
      await this.deps.agent.start({ chatId, workspaceName: workspace.name, workspacePath: workspace.path });
      this.deps.store.markSessionStarted(key, chatId, workspace.name);
      this.logger.info("router.session_started", { chat_id: chatId, workspace: workspace.name, session_key: key });
    }
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
    if (!workspace) throw new Error("No workspace selected. Use /new <name> or /use <name>.");
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
    if (!existsSync(workspace.path)) throw new Error(`Workspace '${name}' does not exist. Use /new ${name} first.`);
    this.deps.store.upsertWorkspace(workspace);
    return workspace;
  }

  private appendSystem(chatId: ChatId, text: string): void {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return;
    this.deps.store.appendTranscript({ chatId, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  private statusView(chatId: ChatId): { workspaceName?: string; workspacePath?: string; running?: boolean } {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(chatId, workspace.name));
    return {
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      running: Boolean(status?.running),
    };
  }

  private readonly pendingOutput = new Map<ChatId, { text: string; timer: Timer }>();

  private async debouncedSend(chatId: ChatId, chunk: string): Promise<void> {
    const pending = this.pendingOutput.get(chatId);
    if (pending) {
      pending.text += chunk;
      this.logger.debug("router.agent_output_buffered", { chat_id: chatId, chunk_len: chunk.length, buffered_len: pending.text.length });
      return;
    }
    const state = {
      text: chunk,
      timer: setTimeout(() => {
        this.pendingOutput.delete(chatId);
        this.logger.debug("router.agent_output_flushed", { chat_id: chatId, text_len: state.text.length });
        void this.sendAgentOutput(chatId, state.text).catch((error) => {
          this.logger.error("router.agent_output_send_failed", {
            chat_id: chatId,
            text_len: state.text.length,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
      }, 800),
    };
    this.pendingOutput.set(chatId, state);
  }

  private async sendAgentOutput(chatId: ChatId, text: string): Promise<void> {
    try {
      await this.deps.adapter.sendMessage(chatId, formatAgentMarkdownForTelegramHtml(text), HTML);
    } catch (error) {
      this.logger.warn("router.agent_output_html_send_failed", {
        chat_id: chatId,
        text_len: text.length,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.deps.adapter.sendMessage(chatId, text);
    }
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

function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Workspaces", callback_data: "ar:workspaces" },
        { text: "Status", callback_data: "ar:status" },
      ],
      [
        { text: "Tail 50", callback_data: "ar:tail:50" },
        { text: "Stop", callback_data: "ar:exit:confirm" },
      ],
    ],
  };
}

function statusKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Refresh", callback_data: "ar:status" },
        { text: "Workspaces", callback_data: "ar:workspaces" },
      ],
      [
        { text: "Tail 50", callback_data: "ar:tail:50" },
        { text: "Stop", callback_data: "ar:exit:confirm" },
      ],
    ],
  };
}

function workspacesKeyboard(workspaces: WorkspaceRecord[], selected?: string): InlineKeyboardMarkup {
  const rows = workspaces
    .map((workspace) => {
      const callbackData = `ar:use:${workspace.name}`;
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
      [{ text: "Status", callback_data: "ar:status" }],
    ],
  };
}

function exitConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Stop session", callback_data: "ar:exit:run" },
        { text: "Cancel", callback_data: "ar:cancel" },
      ],
    ],
  };
}
