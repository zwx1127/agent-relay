import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { BaseAgentDriver, sessionKey } from "./agent.ts";
import { noopLogger, type Logger } from "./logger.ts";
import type {
  AgentApprovalKind,
  AgentExitHandler,
  AgentOutputHandler,
  AgentSessionStatus,
  AgentUserInputQuestion,
  StartAgentOptions,
} from "./types.ts";

interface RunningSession {
  status: AgentSessionStatus;
}

export interface CodexDriverOptions {
  codexBin: string;
  sandbox: string;
  approval: string;
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: Timer;
};

export class CodexDriver extends BaseAgentDriver {
  private readonly sessions = new Map<string, RunningSession>();
  private readonly threadToSession = new Map<string, string>();
  private readonly pending = new Map<number | string, PendingRpc>();
  private proc?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private ready?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly options: CodexDriverOptions,
    onOutput: AgentOutputHandler,
    onExit: AgentExitHandler,
    private readonly logger: Logger = noopLogger,
  ) {
    super(onOutput, onExit);
  }

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const existing = this.sessions.get(key);
    if (existing) {
      this.logger.info("codex.session_reused", {
        session_key: key,
        chat_id: options.chatId,
        workspace: options.workspaceName,
        thread_id: existing.status.threadId,
      });
      return existing.status;
    }

    await this.ensureServer();

    const status: AgentSessionStatus = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: Date.now(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    };

    this.logger.info("codex.session_starting", {
      session_key: key,
      chat_id: options.chatId,
      workspace: options.workspaceName,
      workspace_path: options.workspacePath,
      thread_id: options.threadId,
      codex_bin: this.options.codexBin,
      sandbox: this.options.sandbox,
      approval: this.options.approval,
    });

    const result = await this.request(options.threadId ? "thread/resume" : "thread/start", {
      ...(options.threadId ? { threadId: options.threadId, excludeTurns: true } : {}),
      cwd: options.workspacePath,
      approvalPolicy: this.options.approval,
      approvalsReviewer: "user",
      sandbox: this.options.sandbox,
    });
    const threadId = getThreadId(result) ?? options.threadId;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    status.threadId = threadId;
    this.threadToSession.set(threadId, key);
    this.sessions.set(key, { status });

    this.logger.info("codex.session_started", {
      session_key: key,
      chat_id: options.chatId,
      workspace: options.workspaceName,
      thread_id: threadId,
    });
    return status;
  }

  async send(key: string, text: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.warn("codex.send_without_session", { session_key: key, text_len: text.length });
      throw new Error("Codex session is not running.");
    }

    const input = [{ type: "text", text }];
    const method = running.status.activeTurnId ? "turn/steer" : "turn/start";
    const params = running.status.activeTurnId
      ? { threadId: running.status.threadId, expectedTurnId: running.status.activeTurnId, input }
      : { threadId: running.status.threadId, input };

    this.logger.info("codex.input_sent", {
      session_key: key,
      chat_id: running.status.chatId,
      workspace: running.status.workspaceName,
      thread_id: running.status.threadId,
      active_turn_id: running.status.activeTurnId,
      method,
      text_len: text.length,
    });
    this.logger.debug("codex.input_text", { session_key: key, message_text: text });
    const result = await this.request(method, params);
    const turnId = getTurnId(result);
    if (turnId) running.status.activeTurnId = turnId;
  }

  async stop(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) {
      this.logger.info("codex.stop_without_session", { session_key: key });
      return;
    }

    this.logger.info("codex.session_stop_requested", {
      session_key: key,
      chat_id: running.status.chatId,
      workspace: running.status.workspaceName,
      thread_id: running.status.threadId,
      active_turn_id: running.status.activeTurnId,
    });
    if (running.status.threadId && running.status.activeTurnId) {
      await this.request("turn/interrupt", {
        threadId: running.status.threadId,
        turnId: running.status.activeTurnId,
      }).catch((error) => {
        this.logger.warn("codex.turn_interrupt_failed", {
          session_key: key,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
      running.status.activeTurnId = undefined;
    }
    running.status.running = false;
    if (running.status.threadId) this.threadToSession.delete(running.status.threadId);
    this.sessions.delete(key);
    this.logger.info("codex.session_stopped", { session_key: key });
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.sessions.get(key)?.status;
  }

  async respond(_sessionKey: string, requestId: string | number, result: unknown): Promise<void> {
    await this.writeMessage({ id: requestId, result });
  }

  private async ensureServer(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.startServer();
    return this.ready;
  }

  private async startServer(): Promise<void> {
    this.stopping = false;
    this.proc = spawn(this.options.codexBin, ["app-server", "--listen", "stdio://"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc = this.proc;
    createInterface({ input: proc.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: proc.stderr }).on("line", (line) => {
      if (line.trim()) this.logger.debug("codex.app_server_stderr", { line });
    });
    proc.on("exit", (exitCode, signalCode) => this.handleServerExit(exitCode, signalCode));

    await this.request("initialize", {
      clientInfo: { name: "agent-relay", title: "Agent Relay", version: "0.0.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/commandExecution/outputDelta",
          "item/commandExecution/terminalInteraction",
        ],
      },
    });
    this.logger.info("codex.app_server_started");
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;
    } catch (error) {
      this.logger.warn("codex.app_server_invalid_json", {
        line,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }
    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message as JsonRpcRequest);
      return;
    }
    if ("method" in message) {
      void this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.logger.debug("codex.unmatched_response", { id: message.id });
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`Codex ${pending.method} failed: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleNotification(message: JsonRpcNotification): Promise<void> {
    const params = asRecord(message.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const key = threadId ? this.threadToSession.get(threadId) : undefined;

    if (message.method === "thread/started") {
      const startedThreadId = getThreadId({ thread: params?.thread });
      const session = startedThreadId ? this.threadToSession.get(startedThreadId) : undefined;
      this.logger.debug("codex.thread_started", { thread_id: startedThreadId, session_key: session });
      return;
    }

    if (!key) return;
    const running = this.sessions.get(key);
    if (!running) return;

    if (message.method === "item/agentMessage/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      if (delta) await this.onOutput({ type: "message", sessionKey: key, chunk: delta });
      return;
    }

    if (message.method === "turn/started") {
      const turnId = getTurnId({ turn: params?.turn });
      if (turnId) running.status.activeTurnId = turnId;
      return;
    }

    if (message.method === "turn/completed") {
      running.status.activeTurnId = undefined;
      await this.onOutput({ type: "turn_completed", sessionKey: key });
      return;
    }
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const params = asRecord(message.params);
    const threadId = typeof params?.threadId === "string"
      ? params.threadId
      : typeof params?.conversationId === "string"
        ? params.conversationId
        : undefined;
    const key = threadId ? this.threadToSession.get(threadId) : undefined;
    if (!key) {
      await this.writeMessage({ id: message.id, error: { code: -32000, message: "Unknown thread." } });
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params?.questions) ? params.questions.map(toQuestion).filter(Boolean) as AgentUserInputQuestion[] : [];
      await this.onOutput({ type: "user_input_request", sessionKey: key, requestId: message.id, questions });
      return;
    }

    const approvalKind = approvalKindForMethod(message.method);
    if (approvalKind) {
      const { title, body } = approvalCopy(approvalKind, params);
      await this.onOutput({
        type: "approval_request",
        sessionKey: key,
        requestId: message.id,
        method: message.method,
        approvalKind,
        title,
        body,
        params: message.params,
      });
      return;
    }

    await this.writeMessage({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, method, timer });
      void this.writeMessage({ id, method, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async writeMessage(message: JsonRpcRequest | JsonRpcResponse | { id: string | number; result?: unknown; error?: unknown }): Promise<void> {
    await this.ensureWritable();
    this.proc!.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async ensureWritable(): Promise<void> {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      this.ready = undefined;
      await this.ensureServer();
    }
  }

  private handleServerExit(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.stopping) return;
    this.logger.warn("codex.app_server_exited", { exit_code: exitCode, signal_code: signalCode });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server exited."));
    }
    this.pending.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.threadToSession.clear();
    this.ready = undefined;
    for (const running of sessions) {
      running.status.running = false;
      void this.onExit({ sessionKey: running.status.sessionKey, exitCode, signalCode });
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function getThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  const thread = asRecord(record?.thread);
  return typeof thread?.id === "string" ? thread.id : undefined;
}

function getTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  const turn = asRecord(record?.turn);
  if (typeof turn?.id === "string") return turn.id;
  return typeof record?.turnId === "string" ? record.turnId : undefined;
}

function toQuestion(value: unknown): AgentUserInputQuestion | undefined {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.header !== "string" || typeof record.question !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    header: record.header,
    question: record.question,
    ...(typeof record.isSecret === "boolean" ? { isSecret: record.isSecret } : {}),
    ...(typeof record.isOther === "boolean" ? { isOther: record.isOther } : {}),
    options: Array.isArray(record.options)
      ? record.options.map((option) => {
        const optionRecord = asRecord(option);
        return optionRecord && typeof optionRecord.label === "string"
          ? { label: optionRecord.label, description: typeof optionRecord.description === "string" ? optionRecord.description : "" }
          : undefined;
      }).filter(Boolean) as Array<{ label: string; description: string }>
      : null,
  };
}

function approvalKindForMethod(method: string): AgentApprovalKind | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command";
    case "item/fileChange/requestApproval":
      return "file_change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "execCommandApproval":
      return "legacy_command";
    case "applyPatchApproval":
      return "legacy_patch";
    default:
      return undefined;
  }
}

function approvalCopy(kind: AgentApprovalKind, params: Record<string, unknown> | undefined): { title: string; body: string } {
  if (kind === "command" || kind === "legacy_command") {
    const command = Array.isArray(params?.command) ? params.command.join(" ") : typeof params?.command === "string" ? params.command : "(command unavailable)";
    const cwd = typeof params?.cwd === "string" ? params.cwd : undefined;
    const reason = typeof params?.reason === "string" ? params.reason : undefined;
    return {
      title: "Approve command?",
      body: [reason, cwd ? `cwd: ${cwd}` : undefined, command].filter(Boolean).join("\n"),
    };
  }
  if (kind === "permissions") {
    const cwd = typeof params?.cwd === "string" ? params.cwd : undefined;
    const reason = typeof params?.reason === "string" ? params.reason : undefined;
    return {
      title: "Approve permission change?",
      body: [reason, cwd ? `cwd: ${cwd}` : undefined].filter(Boolean).join("\n") || "Codex requested additional permissions.",
    };
  }
  return {
    title: "Approve file changes?",
    body: typeof params?.reason === "string" ? params.reason : "Codex requested permission to modify files.",
  };
}
