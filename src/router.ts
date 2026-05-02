import { existsSync } from "node:fs";
import type { AppConfig } from "./config.ts";
import { isAuthorized } from "./config.ts";
import { sessionKey } from "./agent.ts";
import type { AgentDriver, ChatId, IMAdapter, InboundMessage, WorkspaceRecord } from "./types.ts";
import type { Store } from "./store.ts";
import { createWorkspace, resolveWorkspacePath, validateWorkspaceName } from "./workspace.ts";
import { tailLines } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

const HELP = [
  "Commands:",
  "/help - show this help",
  "/workspaces - list workspaces",
  "/new <name> - create workspace under WORKSPACE_ROOT",
  "/use <name> - switch this chat to a workspace",
  "/status - show current workspace and Codex session",
  "/tail [n] - show recent agent output, default 50 entries",
  "/exit - stop the current Codex session",
  "/send <text> - send text that starts with / to Codex",
].join("\n");

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<IMAdapter, "sendMessage">;
  agent: AgentDriver;
  logger?: Logger;
}

export class MessageRouter {
  private readonly logger: Logger;

  constructor(private readonly deps: RouterDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  async handle(message: InboundMessage): Promise<void> {
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
      await this.deps.adapter.sendMessage(message.chatId, "Unauthorized.");
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
      await this.deps.adapter.sendMessage(message.chatId, `Error: ${detail}`);
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
    await this.deps.adapter.sendMessage(parsed.chatId, exitText);
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
        await this.deps.adapter.sendMessage(chatId, HELP);
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
    this.logger.info("router.workspaces_listed", { chat_id: chatId, count: workspaces.length });
    if (workspaces.length === 0) {
      await this.deps.adapter.sendMessage(chatId, "No workspaces. Use /new <name>.");
      return;
    }
    await this.deps.adapter.sendMessage(chatId, workspaces.map((workspace) => `- ${workspace.name}`).join("\n"));
  }

  private async newWorkspace(chatId: ChatId, name?: string): Promise<void> {
    if (!name) throw new Error("Usage: /new <name>");
    validateWorkspaceName(name);
    const path = await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindChat(chatId, name);
    this.logger.info("router.workspace_created", { chat_id: chatId, workspace: name, path });
    await this.deps.adapter.sendMessage(chatId, `Workspace '${name}' created and selected.`);
  }

  private async useWorkspace(chatId: ChatId, name?: string): Promise<void> {
    if (!name) throw new Error("Usage: /use <name>");
    const workspace = this.requireWorkspace(name);
    this.deps.store.bindChat(chatId, workspace.name);
    this.logger.info("router.workspace_selected", { chat_id: chatId, workspace: workspace.name, path: workspace.path });
    await this.deps.adapter.sendMessage(chatId, `Using workspace '${workspace.name}'.`);
  }

  private async status(chatId: ChatId): Promise<void> {
    const workspace = this.currentWorkspace(chatId);
    if (!workspace) {
      await this.deps.adapter.sendMessage(chatId, "No workspace selected. Use /new <name> or /use <name>.");
      return;
    }
    const status = this.deps.agent.getStatus(sessionKey(chatId, workspace.name));
    this.logger.info("router.status_reported", {
      chat_id: chatId,
      workspace: workspace.name,
      running: Boolean(status?.running),
    });
    await this.deps.adapter.sendMessage(chatId, [
      `Workspace: ${workspace.name}`,
      `Path: ${workspace.path}`,
      `Codex: ${status?.running ? "running" : "stopped"}`,
    ].join("\n"));
  }

  private async tail(chatId: ChatId, rawCount?: string): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const count = rawCount ? Number(rawCount) : 50;
    if (!Number.isInteger(count) || count < 1) throw new Error("Usage: /tail [positive integer]");
    const text = this.deps.store.recentTranscript(chatId, workspace.name, "agent", 500);
    this.logger.info("router.tail_reported", { chat_id: chatId, workspace: workspace.name, count, text_len: text.length });
    await this.deps.adapter.sendMessage(chatId, text ? tailLines(text, count) : "No agent output yet.");
  }

  private async exit(chatId: ChatId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(chatId);
    const key = sessionKey(chatId, workspace.name);
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.logger.info("router.session_stopped", { chat_id: chatId, workspace: workspace.name, session_key: key });
    await this.deps.adapter.sendMessage(chatId, "Codex session stopped.");
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
        void this.deps.adapter.sendMessage(chatId, state.text).catch((error) => {
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
