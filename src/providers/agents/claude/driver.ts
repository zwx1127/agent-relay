import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import { sessionKey } from "../../../domain/session.ts";
import type {
  AgentApprovalRequestEvent, AgentDriver, AgentExitHandler,
  AgentModelSummary, AgentNativeCommandResult, AgentNativeCommandSummary, AgentOutputHandler, AgentOutputEvent,
  AgentSendOptions, AgentSendResult, AgentSessionStatus, StartAgentOptions,
} from "../../../ports/agent.ts";
import {
  commandsFrom, isSessionId, isSupportedClaudeVersion, MINIMUM_CLAUDE_VERSION, modelsFrom, parseClaudeVersion,
  questionAnswer, questionsFrom, record, string, strings, toolCategory, toolDetail, safeMessage, elicitationSchema, validateElicitationContent, type JsonObject,
} from "./protocol.ts";
import { ClaudeTransport, claudeVersion } from "./transport.ts";
import { nativeInput } from "./input.ts";

export interface ClaudeDriverOptions {
  claudeBin: string;
  env?: Record<string, string>;
  appendSystemPrompt?: string;
  /** Test override for handshake/control deadlines. */
  controlTimeoutMs?: number;
}

interface PendingPrompt { request: JsonObject; kind: "permission" | "question" | "elicitation"; responding?: boolean }
interface Turn {
  id: string; startedAt: number; interrupted: boolean; emittedText: boolean;
  streamedMessages: Set<string>; assistantMessages: Set<string>; streamMessageId?: string;
  tools: Map<string, { name: string; input: JsonObject }>;
  renameTo?: string;
  completion?: { resolve(frame: JsonObject): void; reject(error: Error): void };
}
interface Session {
  options: StartAgentOptions;
  status: AgentSessionStatus;
  transport: ClaudeTransport;
  commands: AgentNativeCommandSummary[];
  aliases: Map<string, string>;
  models: AgentModelSummary[];
  terminalCommands: Set<string>;
  capabilities: Set<string>;
  prompts: Map<string, PendingPrompt>;
  resolvedPrompts: Set<string>;
  turn?: Turn;
  stopping: boolean;
  sending: boolean;
}

const LOCAL_ONLY: AgentNativeCommandSummary[] = [
  { command: "permissions", description: "Manage native permission rules in your local Claude terminal", availability: "local-only" },
  { command: "login", description: "Sign in using your independently installed Claude CLI", availability: "local-only" },
  { command: "theme", description: "Native terminal appearance", availability: "local-only" },
  { command: "terminal-setup", description: "Configure your local terminal", availability: "local-only" },
];
const HOST_COMMANDS: AgentNativeCommandSummary[] = [
  { command: "help", description: "Show this session's native Claude command catalog", availability: "supported" },
  { command: "resume", description: "Resume a native Claude session: /resume <session UUID>", availability: "supported" },
  { command: "plan", description: "Enter native Claude plan mode: /plan [task]", availability: "supported" },
];

/** A thin host for the user's native Claude CLI. No model/tool loop or credential handling lives here. */
export class ClaudeDriver implements AgentDriver {
  readonly providerId = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities = {
    userInputRequests: true, approvals: true, builtinCommands: false, interrupt: true, modelList: true,
    threadRename: true, threadList: false, threadFork: false, sideConversation: false, threadArchive: false,
    threadDelete: false, threadGoals: false, backgroundTerminals: false, localImages: true,
    structuredInputs: false, localAudio: false, skillList: false, fileSearch: false, imageOutput: false,
  };
  private readonly sessions = new Map<string, Session>();
  private readonly starts = new Map<string, Promise<AgentSessionStatus>>();
  private readonly threadClaims = new Set<string>();
  private disposed = false;

  constructor(private readonly options: ClaudeDriverOptions, private readonly onOutput: AgentOutputHandler,
    private readonly onExit: AgentExitHandler, private readonly logger: Logger = noopLogger) {}

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    if (this.disposed) throw new Error("Claude driver has been disposed.");
    const key = sessionKey(options.scopeKey ?? options.conversationId, options.workspaceName, this.providerId);
    const existing = this.sessions.get(key);
    if (existing?.status.running) {
      if (resolve(options.workspacePath) !== resolve(existing.status.workspacePath) || options.threadId && options.threadId !== existing.status.threadId) throw new Error("Stop the current Claude session before changing its workspace or native thread.");
      return { ...existing.status };
    }
    const pending = this.starts.get(key);
    if (pending) return pending;
    if (options.threadId) {
      if (this.threadClaims.has(options.threadId)) throw new Error("This Claude thread is already being started by another Relay session.");
      this.threadClaims.add(options.threadId);
    }
    const starting = this.startSession(key, options);
    this.starts.set(key, starting);
    try { return await starting; } finally { this.starts.delete(key); if (options.threadId) this.threadClaims.delete(options.threadId); }
  }

  private async startSession(key: string, options: StartAgentOptions): Promise<AgentSessionStatus> {
    if (options.threadId && !isSessionId(options.threadId)) throw new Error("Claude resume requires a native session UUID.");
    if (options.threadId && [...this.sessions.values()].some((s) => s.status.running && s.status.threadId === options.threadId)) {
      throw new Error("This Claude thread is already controlled by another Relay session.");
    }
    const env = { ...process.env, ...this.options.env };
    const version = parseClaudeVersion(await claudeVersion(this.options.claudeBin, env));
    if (this.disposed) throw new Error("Claude driver has been disposed.");
    if (!version) throw new Error("Unable to parse Claude --version output.");
    if (!isSupportedClaudeVersion(version)) throw new Error(`This Claude adapter requires ${MINIMUM_CLAUDE_VERSION} or newer in the 2.x release series.`);
    const threadId = options.threadId ?? randomUUID();
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
    args.push(options.threadId ? `--resume=${threadId}` : `--session-id=${threadId}`);
    if (this.options.appendSystemPrompt) args.push("--append-system-prompt", this.options.appendSystemPrompt);
    const status: AgentSessionStatus = {
      ...options, sessionKey: key, threadId, running: true, startedAt: Date.now(), threadStatus: "idle",
      modelProvider: "anthropic", appServerVersion: version, canAcceptDirectInput: false,
    };
    const session: Session = { options: { ...options }, status, commands: [], aliases: new Map(), models: [], terminalCommands: new Set<string>(),
      capabilities: new Set<string>(), prompts: new Map<string, PendingPrompt>(), resolvedPrompts: new Set<string>(), stopping: false, sending: false,
      transport: undefined as unknown as ClaudeTransport };
    session.transport = new ClaudeTransport(this.options.claudeBin, args, options.workspacePath, env,
      (frame) => this.frame(session, frame), (code, signal, error) => this.closed(session, code, signal, error), this.options.controlTimeoutMs);
    this.sessions.set(key, session);
    try {
      const init = await session.transport.request({ subtype: "initialize" });
      this.replaceCommands(session, init.commands);
      session.models = modelsFrom(init.models);
      status.approvalPolicy = string(init.current_permission_mode);
      status.collaborationMode = init.current_permission_mode === "plan" ? "plan" : "default";
      status.collaborationModeApplied = true;
      return { ...status };
    } catch (error) {
      session.stopping = true;
      await session.transport.close();
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.starts.values()]);
    await Promise.all([...this.sessions.keys()].map((key) => this.stop(key)));
  }

  private emit(event: AgentOutputEvent): void {
    const owner = this.sessions.get(event.sessionKey);
    const failed = async () => {
      this.logger.warn("claude.output_delivery_failed", { type: event.type ?? "message" });
      if (event.type === "approval_request" || event.type === "user_input_request" || event.type === "mcp_elicitation_request") {
        const session = this.sessions.get(event.sessionKey);
        const id = String(event.requestId);
        const pending = session?.prompts.get(id);
        if (session && session === owner && pending && !pending.responding) {
          await session.transport.respond(id, pending.kind === "elicitation" ? { action: "cancel" }
            : { behavior: "deny", message: "Relay could not deliver the approval prompt.", toolUseID: pending.request.tool_use_id });
          await this.expirePrompt(session, id);
        }
      }
    };
    try { void Promise.resolve(this.onOutput(event)).catch(() => failed().catch(() => undefined)); }
    catch { void failed().catch(() => undefined); }
  }

  getStatus(key: string): AgentSessionStatus | undefined { const status = this.sessions.get(key)?.status; return status ? { ...status } : undefined; }
  private session(key: string): Session {
    const value = this.sessions.get(key);
    if (!value?.status.running || value.stopping) throw new Error("Claude session is not running.");
    return value;
  }

  async send(key: string, text: string, options: AgentSendOptions = {}): Promise<AgentSendResult> {
    const session = this.session(key);
    if (session.turn || session.sending) throw new Error("Claude is still working. Wait for the turn or interrupt it before sending another prompt.");
    if (session.prompts.size) throw new Error("Answer or cancel the pending Claude prompt first.");
    // Unknown slash commands can consume a model turn in modern Claude; never silently fall through.
    if (text.trimStart().startsWith("/")) this.validateCommand(session, text);
    session.sending = true;
    let turn: Turn | undefined;
    try {
      const content = await nativeInput(text, options);
      if (this.session(key) !== session) throw new Error("Claude session changed while preparing input.");
      let modeApplied = false;
      if (options.collaborationMode && options.collaborationModeExplicit) {
        await this.setMode(session, options.collaborationMode); modeApplied = true;
      }
      turn = this.newTurn(session);
      const rename = text.trim().match(/^\/(?:rename|name)\s+([\s\S]+)$/);
      if (rename) turn.renameTo = rename[1]!.trim();
      await session.transport.write({ type: "user", uuid: turn.id, session_id: session.status.threadId,
        parent_tool_use_id: null, message: { role: "user", content } });
      return { turnId: turn.id, ...(modeApplied ? { collaborationModeApplied: true } : {}) };
    } catch (error) {
      if (turn && session.turn === turn) { session.turn = undefined; session.status.activeTurnId = undefined; session.status.threadStatus = "idle"; }
      throw error;
    } finally { session.sending = false; }
  }

  private newTurn(session: Session): Turn {
    const turn: Turn = { id: randomUUID(), startedAt: Date.now(), interrupted: false, emittedText: false,
      streamedMessages: new Set(), assistantMessages: new Set(), tools: new Map() };
    session.turn = turn; session.status.activeTurnId = turn.id; session.status.threadStatus = "active";
    session.status.recentError = undefined; return turn;
  }

  async stop(key: string): Promise<void> {
    const starting = this.starts.get(key);
    if (starting) await starting.catch(() => undefined);
    const session = this.sessions.get(key);
    if (!session) return;
    session.stopping = true;
    if (session.turn) session.turn.interrupted = true;
    await session.transport.close();
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }
  release(key: string): Promise<void> { return this.stop(key); }

  async interrupt(key: string) {
    const session = this.session(key);
    const turn = session.turn;
    if (!turn && !session.prompts.size) return { interrupted: false };
    if (turn) turn.interrupted = true;
    await session.transport.request({ subtype: "interrupt", ...(session.capabilities.has("interrupt_cancel_queued_v1") ? { cancel_queued: true } : {}) });
    await this.expirePrompts(session);
    return { interrupted: true, turnId: turn?.id };
  }

  async listModels(): Promise<AgentModelSummary[]> {
    const session = [...this.sessions.values()].find((s) => s.status.running);
    if (!session) throw new Error("Start a Claude session to discover the models available to your account.");
    return session.models.map((model) => ({ ...model }));
  }

  async listNativeCommands(key?: string): Promise<AgentNativeCommandSummary[]> {
    const session = key ? this.sessions.get(key) : undefined;
    const commands = new Map<string, AgentNativeCommandSummary>();
    for (const command of [...LOCAL_ONLY, ...(session?.commands ?? []), ...HOST_COMMANDS]) {
      commands.set(command.command, { ...command,
        ...(session && this.terminalCommand(session, command.command) ? { availability: "local-only" as const } : {}) });
    }
    return [...commands.values()].map((entry) => ({ ...entry, command: `/${entry.command}` }));
  }

  private validateCommand(session: Session, text: string): { name: string; args: string } {
    const match = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
    if (!match) throw new Error("Invalid Claude command.");
    const name = match[1]!;
    const native = session.commands.find((entry) => entry.command === name);
    if (this.terminalCommand(session, name) || !native && LOCAL_ONLY.some((entry) => entry.command === name)) {
      throw new Error(`/${name} needs your local Claude terminal; the stream-json interface cannot open that dialog.`);
    }
    if (!native) throw new Error(`/${name} is not in this Claude session's native command catalog. Use /help.`);
    return { name, args: match[2]?.trim() ?? "" };
  }

  async runNativeCommand(key: string, text: string): Promise<AgentNativeCommandResult> {
    const session = this.session(key);
    const match = text.trim().match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
    if (!match) throw new Error("Invalid Claude command.");
    const name = match[1]!; const args = match[2]?.trim() ?? "";
    if (name === "help") {
      const commands = await this.listNativeCommands(key);
      return { message: commands.map((entry) => `${entry.command} — ${entry.description}${entry.availability === "local-only" ? " (local terminal only)" : ""}`).join("\n") };
    }
    if (name === "resume") {
      if (!isSessionId(args)) throw new Error("Use /resume <native Claude session UUID>. Browse all sessions with claude --resume in your local terminal.");
      if (session.turn || session.prompts.size) throw new Error("Interrupt the current Claude turn before resuming another session.");
      if (args === session.status.threadId) return { message: "Already using that Claude session.", threadId: args };
      const options = { ...session.options, threadId: args };
      const previousOptions = { ...session.options, threadId: session.status.threadId };
      await this.stop(key);
      try {
        const status = await this.start(options);
        return { message: "Resumed the native Claude session.", threadId: status.threadId, threadChanged: true, clearDisplay: true };
      } catch (error) {
        try { await this.start(previousOptions); }
        catch { throw new Error(`${safeMessage(error)} The previous Claude session also could not be reopened; start it again from its native session ID.`); }
        throw new Error(`${safeMessage(error)} The previous Claude session has been restored.`);
      }
    }
    if (name === "plan") {
      if (session.turn) throw new Error("Interrupt the current Claude turn before entering plan mode.");
      await this.setMode(session, "plan");
      return args ? { message: "Claude is planning.", ...await this.send(key, args) } : { message: "Claude plan mode enabled." };
    }
    this.validateCommand(session, text);
    if (name === "model" && !args) return { message: session.models.map((model) => `${model.id}: ${model.displayName ?? model.id}${model.description ? ` — ${model.description}` : ""}`).join("\n") + "\nUse /model <model>." };
    if (name === "clear" || name === "reset" || name === "new") {
      const previous = session.status.threadId;
      // A local command completes without a model request. Wait to return the actual new identity.
      if (session.turn || session.prompts.size) throw new Error("Interrupt the current Claude turn before clearing context.");
      const turn = this.newTurn(session);
      const completed = new Promise<JsonObject>((resolve, reject) => { turn.completion = { resolve, reject }; });
      const timeout = setTimeout(() => turn.completion?.reject(new Error("Claude /clear did not return a result in time; its outcome is unknown. The session was stopped safely.")), this.options.controlTimeoutMs ?? 30_000);
      try {
        await session.transport.write({ type: "user", uuid: turn.id, session_id: previous, parent_tool_use_id: null, message: { role: "user", content: text } });
        const result = await completed;
        if (result.is_error || result.subtype !== "success") throw new Error(string(result.result) ?? "Claude could not clear the session.");
        return { message: string(result.result) || "Claude context cleared.", threadId: session.status.threadId,
          threadChanged: previous !== session.status.threadId, clearDisplay: true };
      } catch (error) {
        // A missing result or failed write must not wedge a permanently busy host.
        // Terminate only the uncertain process we own, then let a later start retry.
        if (this.sessions.get(key) === session && this.sessions.get(key)?.turn === turn) {
          turn.completion = undefined;
          await this.stop(key);
        }
        throw error;
      } finally { clearTimeout(timeout); }
    }
    return { message: `Sent /${name} to Claude.`, ...await this.send(key, text), threadId: session.status.threadId };
  }

  async renameThread(key: string, name: string): Promise<void> { await this.runNativeCommand(key, `/rename ${name}`); }
  private async setMode(session: Session, mode: "default" | "plan"): Promise<void> {
    await session.transport.request({ subtype: "set_permission_mode", mode });
    session.status.approvalPolicy = mode; session.status.collaborationMode = mode; session.status.collaborationModeApplied = true;
  }

  async respond(key: string, id: string | number, result: unknown): Promise<void> {
    const session = this.session(key);
    if (typeof id !== "string") throw new Error("Invalid Claude request ID.");
    const pending = session.prompts.get(id);
    if (!pending || pending.responding) throw new Error("That Claude request has expired or was already answered.");
    let response: JsonObject;
    const action = string(record(result)?.action);
    if (pending.kind === "elicitation") {
      if (!["accept", "decline", "cancel"].includes(action ?? "")) throw new Error("Invalid Claude elicitation response.");
      const content = record(result)?.content;
      if (action === "accept" && pending.request.mode === "form") {
        const schema = elicitationSchema(pending.request.requested_schema);
        if (!schema) throw new Error("Unsupported Claude form schema.");
        validateElicitationContent(schema, content);
      }
      response = { action, ...(action === "accept" && record(content) ? { content } : {}) };
    } else {
      const input = record(pending.request.input)!;
      const toolUseID = string(pending.request.tool_use_id)!;
      if (pending.kind === "question" && action !== "decline" && action !== "cancel") {
        response = { behavior: "allow", updatedInput: questionAnswer(input, result), toolUseID };
      } else if (action === "once" && pending.kind === "permission") {
        response = { behavior: "allow", updatedInput: input, toolUseID };
      } else if (action === "decline" || action === "cancel") {
        response = { behavior: "deny", message: action === "cancel" ? "Cancelled by the user." : "Declined by the user.", toolUseID,
          ...(action === "cancel" ? { interrupt: true } : {}) };
      } else throw new Error("Choose a valid live Claude permission action: once, decline, or cancel.");
    }
    pending.responding = true;
    try {
      await session.transport.respond(id, response);
      if (action === "cancel" && session.turn) session.turn.interrupted = true;
      session.prompts.delete(id); session.resolvedPrompts.add(id); this.updateWaiting(session);
      this.emit({ type: "server_request_resolved", sessionKey: key, requestId: id, threadId: session.status.threadId,
        turnId: session.turn?.id, requestMethod: String(pending.request.subtype), result });
    } catch (error) { pending.responding = false; throw error; }
  }

  private async frame(session: Session, frame: JsonObject): Promise<void> {
    if (this.sessions.get(session.status.sessionKey) !== session || session.stopping) return;
    const type = string(frame.type);
    if (type === "control_request") { await this.requestFromClaude(session, frame); return; }
    if (type === "control_cancel_request") { const id = string(frame.request_id); if (id) await this.expirePrompt(session, id); return; }
    // Lifecycle/replayed frames can carry the pre-clear identity. Only authoritative
    // root initialization and the current result establish the current native session.
    if (type === "system" && !frame.parent_tool_use_id) {
      if (frame.subtype === "init" && isSessionId(string(frame.session_id) ?? "")) session.status.threadId = frame.session_id as string;
      await this.systemFrame(session, frame); return;
    }
    const turn = session.turn;
    if (!turn) return;
    if (type === "result" && !frame.parent_tool_use_id) {
      const userId = string(frame.user_message_uuid);
      if (userId && userId !== turn.id && !strings(frame.user_message_uuids).includes(turn.id)) return;
      if (isSessionId(string(frame.session_id) ?? "")) session.status.threadId = frame.session_id as string;
      await this.result(session, frame); return;
    }
    if (type === "stream_event") {
      const event = record(frame.event);
      if (event?.type === "message_start" && !frame.parent_tool_use_id) turn.streamMessageId = string(record(event.message)?.id) ?? string(frame.uuid);
      if (event?.type === "content_block_delta" && !frame.parent_tool_use_id) {
        const delta = record(event.delta);
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          const itemId = turn.streamMessageId ?? `${turn.id}:text`;
          turn.streamedMessages.add(itemId); turn.emittedText = true;
          this.emit({ sessionKey: session.status.sessionKey, threadId: session.status.threadId, chunk: delta.text, turnId: turn.id, itemId });
        }
      }
      return;
    }
    if (type === "tool_progress" && string(frame.tool_use_id) && string(frame.tool_name)) {
      this.emit({ type: "activity", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: turn.id,
        itemId: frame.tool_use_id as string, activity: { kind: "item", category: toolCategory(frame.tool_name as string), label: frame.tool_name as string,
          status: "inProgress", ...(typeof frame.elapsed_time_seconds === "number" ? { durationMs: frame.elapsed_time_seconds * 1000 } : {}) } });
      return;
    }
    if (type === "assistant") {
      const message = record(frame.message);
      const itemId = string(message?.id) ?? string(frame.uuid) ?? turn.id;
      if (turn.assistantMessages.has(itemId)) return;
      turn.assistantMessages.add(itemId);
      for (const raw of Array.isArray(message?.content) ? message.content : []) {
        const block = record(raw);
        if (block?.type === "text" && !frame.parent_tool_use_id && !turn.streamedMessages.has(itemId) && typeof block.text === "string") {
          turn.emittedText = true;
          this.emit({ sessionKey: session.status.sessionKey, threadId: session.status.threadId, chunk: block.text, turnId: turn.id, itemId });
        }
        if (block?.type === "tool_use" && string(block.id) && string(block.name)) {
          const input = record(block.input) ?? {};
          turn.tools.set(block.id as string, { name: block.name as string, input });
          this.emit({ type: "activity", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: turn.id, itemId: block.id as string,
            activity: { kind: "item", category: toolCategory(block.name as string), label: block.name as string, status: "started", detail: toolDetail(input) ? safeMessage(toolDetail(input)) : undefined } });
        }
      }
    }
    if (type === "user") {
      const message = record(frame.message);
      for (const raw of Array.isArray(message?.content) ? message.content : []) {
        const block = record(raw); const toolId = string(block?.tool_use_id); const tool = toolId ? turn.tools.get(toolId) : undefined;
        if (block?.type === "tool_result" && toolId && tool) {
          turn.tools.delete(toolId);
          this.emit({ type: "activity", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: turn.id, itemId: toolId,
            activity: { kind: "item", category: toolCategory(tool.name), label: tool.name, status: block.is_error ? "failed" : "completed", detail: toolDetail(tool.input) ? safeMessage(toolDetail(tool.input)) : undefined } });
        }
      }
    }
  }

  private async systemFrame(session: Session, frame: JsonObject): Promise<void> {
    if (frame.subtype === "init") {
      session.status.model = string(frame.model); session.status.approvalPolicy = string(frame.permissionMode);
      session.status.appServerVersion = string(frame.claude_code_version) ?? session.status.appServerVersion;
      session.status.collaborationMode = frame.permissionMode === "plan" ? "plan" : "default";
      session.status.reasoningEffort = typeof frame.effort === "string" || frame.effort === null ? frame.effort : undefined;
      session.capabilities = new Set(strings(frame.capabilities)); session.terminalCommands = new Set(strings(frame.terminal_slash_commands));
      if (Array.isArray(frame.slash_commands)) {
        const previous = new Map(session.commands.map((entry) => [entry.command, entry]));
        session.commands = commandsFrom(frame.slash_commands).map((entry) => previous.get(entry.command) ?? entry);
        const names = new Set(session.commands.map((entry) => entry.command));
        for (const [alias, canonical] of session.aliases) {
          if (names.has(canonical) && !names.has(alias) && previous.has(alias)) session.commands.push(previous.get(alias)!);
        }
      }
    } else if (frame.subtype === "commands_changed") this.replaceCommands(session, frame.commands);
    else if (frame.subtype === "local_command_output" && string(frame.content)) {
      if (session.turn) session.turn.emittedText = true;
      this.emit({ sessionKey: session.status.sessionKey, turnId: session.turn?.id, chunk: frame.content as string });
    } else if (frame.subtype === "status" && string(frame.permissionMode)) {
      session.status.approvalPolicy = frame.permissionMode as string;
      session.status.collaborationMode = frame.permissionMode === "plan" ? "plan" : "default";
    }
    else if (frame.subtype === "compact_boundary") {
      this.emit({ type: "activity", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: session.turn?.id,
        activity: { kind: "item", category: "compaction", label: "Claude context compacted", status: "completed" } });
    } else if (["api_retry", "permission_denied", "warning"].includes(String(frame.subtype))) {
      const raw = string(frame.message) ?? string(frame.reason) ?? string(frame.error);
      const detail = raw ? safeMessage(raw) : undefined;
      session.status.recentWarning = detail;
      this.emit({ type: "activity", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: session.turn?.id,
        activity: { kind: "notice", level: "warning", title: `Claude ${String(frame.subtype).replaceAll("_", " ")}`, detail } });
    }
  }

  private async result(session: Session, frame: JsonObject): Promise<void> {
    const turn = session.turn!;
    const failed = frame.is_error === true || frame.subtype !== "success";
    const error = safeMessage(strings(frame.errors).join("\n") || string(frame.result) || "Claude turn failed.");
    if (!turn.emittedText && typeof frame.result === "string" && frame.result) {
      this.emit({ sessionKey: session.status.sessionKey, threadId: session.status.threadId, chunk: failed ? safeMessage(frame.result) : frame.result, turnId: turn.id });
    }
    const usage = record(frame.usage);
    if (usage) {
      const input = Number(usage.input_tokens ?? 0), output = Number(usage.output_tokens ?? 0);
      session.status.tokenUsage = { total: { inputTokens: input, outputTokens: output, cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0), totalTokens: input + output } };
    }
    const status = turn.interrupted || ["aborted_streaming", "aborted_tools"].includes(String(frame.terminal_reason)) ? "interrupted" : failed ? "failed" : "completed";
    session.status.latestTurn = { id: turn.id, status, startedAt: turn.startedAt, completedAt: Date.now(), activities: [],
      durationMs: typeof frame.duration_ms === "number" ? frame.duration_ms : Date.now() - turn.startedAt, ...(failed ? { error: { message: error } } : {}) };
    session.status.recentError = failed ? error : undefined; session.status.activeTurnId = undefined; session.status.threadStatus = "idle";
    if (!failed && turn.renameTo) session.status.threadName = turn.renameTo;
    session.turn = undefined; await this.expirePrompts(session);
    turn.completion?.resolve(frame);
    this.emit({ type: "turn_completed", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: turn.id, status,
      ...(failed ? { error: { message: error } } : {}), durationMs: session.status.latestTurn.durationMs });
  }

  private async requestFromClaude(session: Session, frame: JsonObject): Promise<void> {
    const id = string(frame.request_id), request = record(frame.request);
    if (!id || !request) throw new Error("Malformed Claude control request.");
    if (session.resolvedPrompts.has(id)) return;
    const old = session.prompts.get(id);
    if (old) {
      if (JSON.stringify(old.request) !== JSON.stringify(request)) {
        await session.transport.reject(id, "Conflicting duplicate Claude request."); await this.expirePrompt(session, id);
      }
      return;
    }
    const key = session.status.sessionKey;
    if (request.subtype === "can_use_tool") {
      const tool = string(request.tool_name), input = record(request.input), toolId = string(request.tool_use_id);
      if (!tool || !input || !toolId) { await session.transport.reject(id, "Invalid Claude permission request."); return; }
      const kind = tool === "AskUserQuestion" ? "question" : "permission";
      try {
        if (kind === "question") {
          const questions = questionsFrom(input);
          session.prompts.set(id, { request, kind }); this.updateWaiting(session);
          this.emit({ type: "user_input_request", sessionKey: key, requestId: id, threadId: session.status.threadId,
            turnId: session.turn?.id, itemId: toolId, questions, isBlocking: true });
        } else {
          session.prompts.set(id, { request, kind }); this.updateWaiting(session);
          const event: AgentApprovalRequestEvent = {
            type: "approval_request", sessionKey: key, requestId: id, threadId: session.status.threadId,
            turnId: session.turn?.id, itemId: toolId, approvalId: id, method: "claude/can_use_tool", approvalKind: "native_tool",
            title: string(request.title) ?? `Claude wants to use ${tool}`,
            body: [string(request.description), string(request.decision_reason), toolDetail(input),
              // The native tool input is review data, never evaluated by the relay.
              JSON.stringify(input, null, 2)].filter(Boolean).join("\n"),
            params: { ...request, choices: request.default_to_no === true
              ? [{ action: "decline", label: "Deny" }, { action: "cancel", label: "Stop turn" }, { action: "once", label: "Allow once" }]
              : [{ action: "once", label: "Allow once" }, { action: "decline", label: "Deny" }, { action: "cancel", label: "Stop turn" }] },
          };
          this.emit(event);
        }
      } catch (error) {
        await session.transport.respond(id, { behavior: "deny", message: "Relay could not safely display this request.", toolUseID: toolId });
        await this.expirePrompt(session, id);
        this.logger.warn("claude.prompt_delivery_failed", { error: error instanceof Error ? error : new Error(String(error)) });
      }
      return;
    }
    if (request.subtype === "elicitation") {
      const mode = request.mode ?? "form";
      const schema = elicitationSchema(request.requested_schema);
      const url = string(request.url);
      if (mode !== "form" && mode !== "url" || mode === "form" && !schema || mode === "url" && (!url || !/^https?:\/\//i.test(url))) {
        await session.transport.respond(id, { action: "cancel" }); return;
      }
      session.prompts.set(id, { request: { ...request, mode }, kind: "elicitation" }); this.updateWaiting(session);
      try {
        this.emit({ type: "mcp_elicitation_request", sessionKey: key, requestId: id, threadId: session.status.threadId, turnId: session.turn?.id,
          serverName: string(request.mcp_server_name) ?? "MCP server", mode, message: string(request.message) ?? "Claude requested input.",
          ...(schema ? { requestedSchema: schema } : {}), ...(url ? { url } : {}), elicitationId: string(request.elicitation_id) });
      } catch { await session.transport.respond(id, { action: "cancel" }); await this.expirePrompt(session, id); }
      return;
    }
    // No auto-approval of future dialogs, hooks, OAuth refresh or tool subtypes.
    await session.transport.reject(id, `Relay does not support Claude control request ${String(request.subtype)}.`);
  }

  private updateWaiting(session: Session): void {
    session.status.waitingForApproval = [...session.prompts.values()].some((p) => p.kind === "permission");
    session.status.waitingForUserInput = [...session.prompts.values()].some((p) => p.kind !== "permission");
  }
  private replaceCommands(session: Session, value: unknown): void {
    session.commands = commandsFrom(value); session.aliases.clear();
    for (const raw of Array.isArray(value) ? value : []) {
      const command = record(raw), name = string(command?.name);
      if (name) for (const alias of strings(command?.aliases)) session.aliases.set(alias, name);
    }
  }
  private terminalCommand(session: Session, name: string): boolean {
    return session.terminalCommands.has(name) || session.terminalCommands.has(session.aliases.get(name) ?? name);
  }
  private async expirePrompt(session: Session, id: string): Promise<void> {
    if (!session.prompts.delete(id)) return;
    session.resolvedPrompts.add(id); this.updateWaiting(session);
    if (this.sessions.get(session.status.sessionKey) !== session) return;
    this.emit({ type: "server_request_resolved", sessionKey: session.status.sessionKey, requestId: id, threadId: session.status.threadId, turnId: session.turn?.id });
  }
  private async expirePrompts(session: Session): Promise<void> { for (const id of [...session.prompts.keys()]) await this.expirePrompt(session, id); }
  private closed(session: Session, code: number | null, signal: string | null, error: Error): void {
    if (!session.status.running) return;
    session.status.running = false; session.status.threadStatus = "closed";
    const turn = session.turn;
    session.turn = undefined; session.status.activeTurnId = undefined;
    session.status.recentError = session.stopping ? undefined : safeMessage(error);
    turn?.completion?.reject(error);
    void (async () => {
      if (this.sessions.get(session.status.sessionKey) !== session) return;
      await this.expirePrompts(session);
      if (this.sessions.get(session.status.sessionKey) !== session) return;
      if (turn) this.emit({ type: "turn_completed", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: turn.id,
        status: session.stopping || turn.interrupted ? "interrupted" : "failed", ...(session.stopping ? {} : { error: { message: safeMessage(error) } }) });
      // An intentional restart must not tear down the new session through an exit callback.
      if (!session.stopping) void Promise.resolve(this.onExit({ sessionKey: session.status.sessionKey, exitCode: code, signalCode: signal })).catch(() => this.logger.warn("claude.exit_delivery_failed"));
    })().catch((cause: unknown) => this.logger.warn("claude.exit_delivery_failed", { error: cause instanceof Error ? cause : new Error(String(cause)) }));
  }
}
