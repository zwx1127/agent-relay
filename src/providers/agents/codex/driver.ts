import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { sessionKey } from "../../../domain/session.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import type {
  AgentBuiltinCommand,
  AgentBuiltinResult,
  AgentSendOptions,
  AgentDriver,
  AgentExitHandler,
  AgentModelSummary,
  AgentOutputHandler,
  AgentSessionStatus,
  AgentThreadSwitchResult,
  AgentThreadListOptions,
  AgentThreadSummary,
  AgentUserInputQuestion,
  StartAgentOptions,
} from "../../../ports/agent.ts";
import { applySessionMetadata, applyThreadMetadata, approvalCopy, approvalKindForMethod, asRecord, collaborationModePayload, getString, getThreadId, getTurnId, imageOutputEvent, isNoActiveTurnToSteerError, reviewTargetPayload, summarizeUnknown, toModelSummary, toQuestion, toThreadSummary, toTokenBreakdown, updateActiveTurnFromResult, userInputPayload } from "./protocol.ts";

interface RunningSession {
  status: AgentSessionStatus;
}

export interface CodexDriverOptions {
  codexBin: string;
  sandbox: string;
  approval: string;
  developerInstructions?: string;
  baseInstructions?: string;
  env?: Record<string, string>;
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

export class CodexDriver implements AgentDriver {
  readonly providerId = "codex";
  readonly capabilities = {
    userInputRequests: true,
    approvals: true,
    builtinCommands: true,
    threadFork: true,
    threadRename: true,
    threadList: true,
    modelList: true,
    localImages: true,
    imageOutput: true,
  };

  private readonly sessions = new Map<string, RunningSession>();
  private readonly threadToSession = new Map<string, string>();
  private readonly pending = new Map<number | string, PendingRpc>();
  private readonly inputQueues = new Map<string, Promise<{ turnId?: string }>>();
  private proc?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private ready?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly options: CodexDriverOptions,
    private readonly onOutput: AgentOutputHandler,
    private readonly onExit: AgentExitHandler,
    private readonly logger: Logger = noopLogger,
  ) {}

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const key = sessionKey(options.conversationId, options.workspaceName, this.providerId);
    const existing = this.sessions.get(key);
    if (existing) {
      this.logger.info("codex.session_reused", {
        session_key: key,
        conversation_id: options.conversationId,
        workspace: options.workspaceName,
        thread_id: existing.status.threadId,
      });
      return existing.status;
    }

    await this.ensureServer();

    const status: AgentSessionStatus = {
      sessionKey: key,
      conversationId: options.conversationId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: Date.now(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    };

    this.logger.info("codex.session_starting", {
      session_key: key,
      conversation_id: options.conversationId,
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
      ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
      ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
    });
    const threadId = getThreadId(result) ?? options.threadId;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    status.threadId = threadId;
    applySessionMetadata(status, result);
    this.threadToSession.set(threadId, key);
    this.sessions.set(key, { status });

    this.logger.info("codex.session_started", {
      session_key: key,
      conversation_id: options.conversationId,
      workspace: options.workspaceName,
      thread_id: threadId,
    });
    return status;
  }

  async send(key: string, text: string, options?: AgentSendOptions): Promise<{ turnId?: string }> {
    const previous = this.inputQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.sendNow(key, text, options));
    this.inputQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.inputQueues.get(key) === current) this.inputQueues.delete(key);
    }
  }

  private async sendNow(key: string, text: string, options?: AgentSendOptions): Promise<{ turnId?: string }> {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.warn("codex.send_without_session", { session_key: key, text_len: text.length });
      throw new Error("Codex session is not running.");
    }

    const input = userInputPayload(text, options?.images);
    const method = running.status.activeTurnId ? "turn/steer" : "turn/start";
    const collaborationMode = options?.collaborationMode ? collaborationModePayload(running.status, options.collaborationMode) : undefined;
    const params = running.status.activeTurnId
      ? { threadId: running.status.threadId, expectedTurnId: running.status.activeTurnId, input }
      : { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}) };

    this.logger.info("codex.input_sent", {
      session_key: key,
      conversation_id: running.status.conversationId,
      workspace: running.status.workspaceName,
      thread_id: running.status.threadId,
      active_turn_id: running.status.activeTurnId,
      method,
      text_len: text.length,
    });
    this.logger.debug("codex.input_text", { session_key: key, message_text: text });
    let result: unknown;
    try {
      result = await this.request(method, params);
    } catch (error) {
      if (method !== "turn/steer" || !isNoActiveTurnToSteerError(error)) throw error;
      this.logger.warn("codex.stale_active_turn_recovered", {
        session_key: key,
        conversation_id: running.status.conversationId,
        workspace: running.status.workspaceName,
        thread_id: running.status.threadId,
        stale_turn_id: running.status.activeTurnId,
      });
      running.status.activeTurnId = undefined;
      result = await this.request("turn/start", { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}) });
    }
    updateActiveTurnFromResult(running, result);
    return { turnId: getTurnId(result) };
  }

  async stop(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) {
      this.logger.info("codex.stop_without_session", { session_key: key });
      return;
    }

    this.logger.info("codex.session_stop_requested", {
      session_key: key,
      conversation_id: running.status.conversationId,
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
    this.inputQueues.delete(key);
    this.logger.info("codex.session_stopped", { session_key: key });
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.sessions.get(key)?.status;
  }

  async respond(_sessionKey: string, requestId: string | number, result: unknown): Promise<void> {
    await this.writeMessage({ id: requestId, result });
  }

  async runBuiltinCommand(key: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult> {
    const running = this.requireRunningSession(key);
    if (command.type === "review") {
      const result = await this.request("review/start", {
        threadId: running.status.threadId,
        target: reviewTargetPayload(command.target ?? { type: "uncommittedChanges" }),
        delivery: "inline",
      });
      updateActiveTurnFromResult(running, result);
      return {
        message: "Review started.",
        threadId: getString(asRecord(result), "reviewThreadId") ?? running.status.threadId,
        turnId: getTurnId(result),
      };
    }

    const result = await this.request("thread/compact/start", { threadId: running.status.threadId });
    updateActiveTurnFromResult(running, result);
    return { message: "Compaction started.", threadId: running.status.threadId, turnId: getTurnId(result) };
  }

  async forkThread(key: string): Promise<AgentThreadSwitchResult> {
    const running = this.requireRunningSession(key);
    const result = await this.request("thread/fork", {
      threadId: running.status.threadId,
      cwd: running.status.workspacePath,
      approvalPolicy: this.options.approval,
      approvalsReviewer: "user",
      sandbox: this.options.sandbox,
      ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
      ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      excludeTurns: true,
    });
    const threadId = getThreadId(result);
    if (!threadId) throw new Error("Codex app-server did not return a forked thread id.");
    if (running.status.threadId) this.threadToSession.delete(running.status.threadId);
    running.status.threadId = threadId;
    applySessionMetadata(running.status, result);
    this.threadToSession.set(threadId, key);
    return { threadId, threadName: running.status.threadName };
  }

  async renameThread(key: string, name: string): Promise<void> {
    const running = this.requireRunningSession(key);
    await this.request("thread/name/set", { threadId: running.status.threadId, name });
    running.status.threadName = name;
  }

  async cleanBackgroundTerminals(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    await this.request("thread/backgroundTerminals/clean", { threadId: running.status.threadId });
  }

  async listThreads(options: AgentThreadListOptions): Promise<AgentThreadSummary[]> {
    await this.ensureServer();
    const result = await this.request("thread/list", {
      cwd: options.workspacePath,
      limit: options.limit ?? 10,
      sortKey: "updated_at",
      sortDirection: "desc",
      ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    const data = Array.isArray(asRecord(result)?.data) ? asRecord(result)!.data as unknown[] : [];
    return data.map(toThreadSummary).filter((thread): thread is AgentThreadSummary => Boolean(thread));
  }

  async listModels(): Promise<AgentModelSummary[]> {
    await this.ensureServer();
    const result = await this.request("model/list", { includeHidden: false });
    const data = Array.isArray(asRecord(result)?.data) ? asRecord(result)!.data as unknown[] : [];
    return data.map(toModelSummary).filter((model): model is AgentModelSummary => Boolean(model));
  }

  private async ensureServer(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.startServer();
    return this.ready;
  }

  private async startServer(): Promise<void> {
    this.stopping = false;
    this.proc = spawn(this.options.codexBin, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, ...this.options.env },
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
      const running = session ? this.sessions.get(session) : undefined;
      if (running) applyThreadMetadata(running.status, asRecord(params?.thread));
      this.logger.debug("codex.thread_started", { thread_id: startedThreadId, session_key: session });
      return;
    }

    if (!key) return;
    const running = this.sessions.get(key);
    if (!running) return;

    if (message.method === "item/agentMessage/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const turnId = getTurnId(params);
      const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
      if (delta) await this.onOutput({ type: "message", sessionKey: key, chunk: delta, turnId, itemId });
      return;
    }

    if (message.method === "item/plan/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const turnId = getTurnId(params);
      const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
      if (delta) await this.onOutput({ type: "message", sessionKey: key, chunk: delta, turnId, itemId });
      return;
    }

    if (message.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "exitedReviewMode" && typeof item.review === "string" && item.review) {
        await this.onOutput({ type: "message", sessionKey: key, chunk: item.review, turnId: getTurnId(params), itemId: getString(item, "id") });
      }
      if (item?.type === "imageGeneration") {
        await this.onOutput(imageOutputEvent(key, item, getTurnId(params)));
      }
      return;
    }

    if (message.method === "rawResponseItem/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "image_generation_call") {
        await this.onOutput(imageOutputEvent(key, item, getTurnId(params)));
      }
      return;
    }

    if (message.method === "turn/started") {
      const turnId = getTurnId({ turn: params?.turn });
      if (turnId) running.status.activeTurnId = turnId;
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
      return;
    }

    if (message.method === "turn/completed") {
      const turnId = getTurnId(params);
      running.status.activeTurnId = undefined;
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
      await this.onOutput({ type: "turn_completed", sessionKey: key, turnId });
      return;
    }

    if (message.method === "thread/status/changed") {
      const threadStatus = asRecord(params?.status);
      running.status.threadStatus = typeof threadStatus?.type === "string" ? threadStatus.type : undefined;
      const activeFlags = Array.isArray(threadStatus?.activeFlags) ? threadStatus.activeFlags : [];
      running.status.waitingForApproval = activeFlags.includes("waitingOnApproval");
      running.status.waitingForUserInput = activeFlags.includes("waitingOnUserInput");
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params?.tokenUsage);
      running.status.tokenUsage = {
        last: toTokenBreakdown(asRecord(tokenUsage?.last)),
        total: toTokenBreakdown(asRecord(tokenUsage?.total)),
      };
      const contextWindow = tokenUsage?.modelContextWindow;
      running.status.contextWindow = typeof contextWindow === "number" ? contextWindow : undefined;
      return;
    }

    if (message.method === "thread/name/updated") {
      running.status.threadName = typeof params?.threadName === "string" ? params.threadName : undefined;
      return;
    }

    if (message.method === "model/rerouted") {
      const toModel = typeof params?.toModel === "string" ? params.toModel : undefined;
      if (toModel) running.status.model = toModel;
      return;
    }

    if (message.method === "warning") {
      const warning = typeof params?.message === "string" ? params.message : undefined;
      if (warning) running.status.recentError = warning;
      return;
    }

    if (message.method === "error") {
      running.status.recentError = summarizeUnknown(params?.error);
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
      await this.onOutput({
        type: "user_input_request",
        sessionKey: key,
        requestId: message.id,
        questions,
        turnId: getTurnId(params),
        itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
      });
      const running = this.sessions.get(key);
      if (running) running.status.waitingForUserInput = true;
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
        turnId: getTurnId(params),
        itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
      });
      const running = this.sessions.get(key);
      if (running) running.status.waitingForApproval = true;
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

  private requireRunningSession(key: string): RunningSession {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.warn("codex.builtin_without_session", { session_key: key });
      throw new Error("Codex session is not running.");
    }
    return running;
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
