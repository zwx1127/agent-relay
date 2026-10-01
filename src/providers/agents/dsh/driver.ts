import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sessionKey } from "../../../domain/session.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import type {
  AgentDriver, AgentExitHandler, AgentOutputHandler, AgentOutputEvent, AgentSessionStatus,
  StartAgentOptions, AgentSendOptions, AgentSendResult, AgentInterruptResult,
  AgentNativeCommandSummary, AgentNativeCommandResult, AgentThreadListOptions,
  AgentThreadSummary, AgentModelSummary, AgentUserInputQuestion,
} from "../../../ports/agent.ts";
import { imageLimits, promptContent, validatedImageOutput, type ImageLimits } from "./media.ts";
import { DshWebTransport, type DshTransportOptions } from "./transport.ts";
import { VERIFIED_DSH_VERSION, record, string, integer, array, textBlocks, commandDescriptors, browserOnlyCommand, safeMessage, type JsonRecord } from "./protocol.ts";

export interface DshDriverOptions extends DshTransportOptions {}
interface RunningSession {
  status: AgentSessionStatus;
  cursor?: number;
  dispose?: () => void;
  tail: Promise<void>;
  activeStartedAt?: number;
  ready: boolean;
  commandAbort?: AbortController;
  imageLimits?: ImageLimits;
}
interface NativeQuestion { id: string; question: string; header?: string; detail?: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }
interface PendingInteraction {
  id: string;
  session: RunningSession;
  eventId?: string;
  clientId?: string;
  callId?: string;
  kind: "approval" | "questions";
  questions?: NativeQuestion[];
  responding: boolean;
}

/** DSH's native Web command and interaction plane; no Codex prompts or settings are injected. */
export class DshDriver implements AgentDriver {
  readonly providerId = "dsh";
  readonly displayName = "DeepSeek Harness";
  readonly capabilities = {
    userInputRequests: true, approvals: true, builtinCommands: false, threadFork: false,
    sideConversation: false, threadRename: true, threadArchive: false, threadDelete: false,
    threadGoals: false, threadList: true, modelList: true, backgroundTerminals: false,
    localImages: true, structuredInputs: true, localAudio: false, skillList: false,
    fileSearch: false, imageOutput: true, interrupt: true,
  };
  private readonly sessions = new Map<string, RunningSession>();
  private readonly starting = new Map<string, Promise<AgentSessionStatus>>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly reservedThreads = new Set<string>();
  private transport?: DshWebTransport;
  private connecting?: Promise<DshWebTransport>;
  private clientId?: string;
  private eventsReady?: Promise<void>;
  private resolveEventsReady?: () => void;
  private rejectEventsReady?: (error: Error) => void;

  constructor(
    private readonly options: DshDriverOptions,
    private readonly onOutput: AgentOutputHandler,
    private readonly onExit: AgentExitHandler,
    private readonly logger: Logger = noopLogger,
  ) {}

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const key = sessionKey(options.scopeKey ?? String(options.conversationId), options.workspaceName, this.providerId);
    const current = this.sessions.get(key);
    if (current) {
      if (resolve(options.workspacePath) !== current.status.workspacePath || (options.threadId && options.threadId !== current.status.threadId)) {
        throw new Error("Stop the current DSH session before switching its workspace or thread.");
      }
      return current.status;
    }
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight;
    const operation = this.startSession(key, options);
    this.starting.set(key, operation);
    try { return await operation; } finally { this.starting.delete(key); }
  }
  private async startSession(key: string, options: StartAgentOptions): Promise<AgentSessionStatus> {
    if (options.threadId && (this.reservedThreads.has(options.threadId) || [...this.sessions.values()].some(s => s.status.threadId === options.threadId))) {
      throw new Error("This DSH thread is already controlled by another Relay session.");
    }
    if (options.threadId) this.reservedThreads.add(options.threadId);
    try {
    const transport = await this.ensureTransport(options.workspacePath);
    const created = record(await transport.call("session/create", { request: {
      cwd: resolve(options.workspacePath), ...(options.threadId ? { sessionId: options.threadId } : {}),
    } }));
    const threadId = string(created?.sessionId);
    if (!threadId) throw new Error("DSH did not return a session identity.");
    if (options.threadId && threadId !== options.threadId) throw new Error("DSH resumed a different session than requested.");
    if ([...this.sessions.values()].some(session => session.status.threadId === threadId)) throw new Error("DSH returned a thread already controlled by another Relay session.");
    const running: RunningSession = { status: {
      sessionKey: key, conversationId: options.conversationId, scopeKey: options.scopeKey ?? String(options.conversationId),
      workspaceName: options.workspaceName, workspacePath: resolve(options.workspacePath),
      threadId, running: true, startedAt: Date.now(), threadStatus: "idle", canAcceptDirectInput: true,
      appServerVersion: VERIFIED_DSH_VERSION,
    }, tail: Promise.resolve(), ready: false };
    this.sessions.set(key, running);
    try {
      await this.follow(running);
      return running.status;
    } catch (error) {
      running.dispose?.(); this.sessions.delete(key);
      if (this.sessions.size === 0 && this.starting.size <= 1) await this.shutdownTransport();
      throw error;
    }
    } finally { if (options.threadId) this.reservedThreads.delete(options.threadId); }
  }
  private async ensureTransport(cwd: string): Promise<DshWebTransport> {
    if (this.connecting) return this.connecting;
    const transport = new DshWebTransport(this.options, resolve(cwd), () => this.disconnected(), (code, signal) => this.exited(transport, code, signal));
    this.transport = transport;
    const connection = (async () => {
      await transport.start();
      this.eventsReady = new Promise<void>((resolve, reject) => { this.resolveEventsReady = resolve; this.rejectEventsReady = reject; });
      transport.subscribe("$events", {}, value => this.onEvent(value), error => {
        this.rejectEventsReady?.(error);
        this.disconnected();
        void transport.close();
      });
      const timer = setTimeout(() => this.rejectEventsReady?.(new Error("DSH event readiness timed out.")), this.options.requestTimeoutMs ?? 30_000);
      try { await this.eventsReady; } finally { clearTimeout(timer); }
      return transport;
    })();
    this.connecting = connection;
    try { return await connection; } catch (error) {
      if (this.connecting === connection) this.connecting = undefined;
      await transport.close(); throw error;
    }
  }
  private async follow(session: RunningSession): Promise<void> {
    const transport = this.requireTransport();
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("DSH session history did not become ready.")), this.options.requestTimeoutMs ?? 30_000);
      session.dispose = transport.subscribe("session/follow", { request: { address: { kind: "session", sessionId: session.status.threadId }, maxMessages: 64 } }, value => {
        session.tail = session.tail.then(async () => {
          if (!this.isCurrent(session)) { clearTimeout(timer); reject(new Error("DSH session was stopped during history loading.")); return; }
          await this.historyFrame(session, value);
          if (session.ready) { clearTimeout(timer); resolveReady(); }
        }).catch(error => {
          clearTimeout(timer); reject(error);
          if (!this.isCurrent(session)) return;
          session.ready = false;
          session.status.recentError = safeMessage(error);
          this.historyFailed(session, error);
        });
      }, error => { clearTimeout(timer); reject(error); this.historyFailed(session, error); });
    });
  }
  private historyFailed(session: RunningSession, error: unknown): void {
    if (!this.isCurrent(session)) return;
    session.ready = false; session.status.recentError = safeMessage(error);
    void this.emit({ type: "activity", sessionKey: session.status.sessionKey, activity: { kind: "notice", level: "error", title: "DSH history failed; restart this session", detail: safeMessage(error) } });
    // A broken authoritative stream cannot safely accept more commands. Stop the
    // owned runtime; native persisted sessions remain available for explicit resume.
    void this.transport?.close();
  }
  private async historyFrame(session: RunningSession, value: unknown): Promise<void> {
    if (!this.isCurrent(session)) return;
    const frame = record(value);
    if (!frame) throw new Error("DSH returned an invalid history frame.");
    if (frame.type === "snapshot") {
      if (record(frame.header)?.id !== session.status.threadId || integer(frame.cursor) === undefined) throw new Error("DSH returned another session's history.");
      const cursor = frame.cursor as number;
      let entries = array(frame.records).map(record).filter((v): v is JsonRecord => Boolean(v)).map(v => record(v.event)).filter((v): v is JsonRecord => Boolean(v));
      if (session.cursor !== undefined) {
        let hasMore = frame.hasMore === true;
        while (hasMore && (!entries.length || Number(entries[0]?.seq) > session.cursor + 1)) {
          const beforeSeq = integer(entries[0]?.seq);
          if (beforeSeq === undefined) throw new Error("DSH reconnect history cannot advance.");
          const page = record(await this.requireTransport().call("session/page", { request: { address: { kind: "session", sessionId: session.status.threadId }, throughSeq: cursor, beforeSeq, maxMessages: 256 } }));
          if (!this.isCurrent(session)) return;
          const previous = array(page?.records).map(record).map(v => record(v?.event)).filter((v): v is JsonRecord => Boolean(v));
          if (previous.length === 0 || Number(previous[0]?.seq) >= beforeSeq) throw new Error("DSH reconnect history has a gap.");
          entries = [...previous, ...entries]; hasMore = page?.hasMore === true;
        }
        for (const event of entries) {
          await this.durableEvent(session, event, true);
          if (!this.isCurrent(session)) return;
        }
        if (session.cursor !== cursor) throw new Error("DSH reconnect history is incomplete.");
      } else {
        for (const event of entries) {
          await this.durableEvent(session, event, false);
          if (!this.isCurrent(session)) return;
        }
        session.cursor = cursor;
      }
      this.projections(session, record(frame.projections)?.values);
      session.ready = true; session.status.recentWarning = undefined;
      return;
    }
    if (frame.type === "event") {
      const event = record(frame.event);
      if (!event) throw new Error("DSH returned an invalid event.");
      await this.durableEvent(session, event, true);
    }
  }
  private async durableEvent(session: RunningSession, event: JsonRecord, publish: boolean): Promise<void> {
    if (!this.isCurrent(session)) return;
    const seq = integer(event.seq);
    if (seq === undefined) throw new Error("DSH event is missing its sequence.");
    if (session.cursor !== undefined && seq <= session.cursor) return;
    if (publish && session.cursor !== undefined && seq !== session.cursor + 1) throw new Error("DSH event sequence skipped; reconnect before sending more work.");
    session.cursor = seq;
    const data = record(event.data) ?? {};
    const turnId = typeof data.turn === "number" ? `${session.status.threadId}:${data.turn}` : session.status.activeTurnId;
    const base = { sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId };
    if (event.type === "turn/start") {
      session.status.activeTurnId = turnId; session.status.threadStatus = "running";
      session.activeStartedAt = typeof event.time === "number" ? event.time : Date.now();
      if (publish) await this.emit({ type: "activity", ...base, activity: { kind: "notice", level: "info", title: "DeepSeek Harness started working" } });
    } else if (event.type === "turn/end") {
      const reason = record(data.reason);
      const kind = string(reason?.kind);
      const status = kind === "completed" ? "completed" : ["aborted", "interrupted", "forked"].includes(kind ?? "") ? "interrupted" : "failed";
      const detail = kind === "error" ? safeMessage(record(reason?.error)?.message) : status === "failed" ? `DSH turn ended: ${kind ?? "unknown"}.` : undefined;
      session.status.activeTurnId = undefined; session.status.threadStatus = "idle";
      session.status.recentError = detail;
      if (turnId) session.status.latestTurn = { id: turnId, status, activities: [], completedAt: Date.now(), ...(detail ? { error: { message: detail } } : {}) };
      if (publish) await this.emit({ type: "turn_completed", ...base, status,
        ...(detail ? { error: { message: detail } } : {}),
        ...(session.activeStartedAt ? { durationMs: Date.now() - session.activeStartedAt } : {}),
      });
    } else if (event.type === "assistant/message") {
      const message = record(data.message);
      if (publish) for (const part of array(message?.content).map(record)) {
        if (!this.isCurrent(session)) return;
        if (part?.type === "text" && typeof part.text === "string") await this.emit({ type: "message", ...base, chunk: part.text, itemId: string(message?.id) });
        if (part?.type === "image") await this.publishImage(session, part, turnId, string(message?.id));
        // Raw reasoning is intentionally not copied into IM messages.
      }
    } else if (event.type === "tool/call" && publish) {
      await this.emit({ type: "activity", ...base, itemId: string(data.callId), activity: {
        kind: "item", category: "other", label: string(data.name) ?? "DSH tool", status: "inProgress",
        detail: typeof data.arguments === "string" ? safeMessage(data.arguments) : undefined,
      } });
    } else if (event.type === "tool/result" && publish) {
      const message = record(data.message);
      await this.emit({ type: "activity", ...base, itemId: string(message?.toolCallId), activity: {
        kind: "item", category: "other", label: "DSH tool result", status: message?.isError === true ? "failed" : "completed",
        detail: textBlocks(message?.content),
      } });
      for (const part of array(message?.content).map(record)) {
        if (!this.isCurrent(session)) return;
        if (part?.type === "image") await this.publishImage(session, part, turnId, string(message?.toolCallId));
      }
      if (!this.isCurrent(session)) return;
      // Timed native questions can remain answerable after their tool returns.
      await this.refreshProjections(session).catch(() => { session.status.recentWarning = "DSH question state is temporarily unavailable."; });
    } else if (event.type === "request/context" || event.type === "model/selection") {
      this.selection(session, data);
    } else if (event.type === "session/title") {
      session.status.threadName = string(data.title);
    } else if (event.type === "permission/preset") {
      session.status.sandboxPolicy = string(data.name) ?? string(data.preset);
    }
  }
  private async publishImage(session: RunningSession, block: JsonRecord, turnId?: string, itemId?: string): Promise<void> {
    const attachmentId = string(record(block.attachment)?.attachmentId);
    if (!attachmentId || !this.isCurrent(session)) return;
    try {
      const image = validatedImageOutput(await this.requireTransport().call("session/attachment", { request: { sessionId: session.status.threadId, attachmentId } }));
      if (!image) throw new Error("DSH returned an unsupported or oversized image.");
      if (this.isCurrent(session)) void this.emit({ type: "image", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId, itemId, ...image });
    } catch (error) {
      if (this.isCurrent(session)) void this.emit({ type: "activity", sessionKey: session.status.sessionKey, activity: { kind: "notice", level: "warning", title: "DSH image unavailable", detail: safeMessage(error) } });
    }
  }
  private selection(session: RunningSession, value: unknown): void {
    const selected = record(value);
    if (typeof selected?.provider === "string") session.status.modelProvider = selected.provider;
    if (typeof selected?.model === "string") session.status.model = selected.model;
    if (selected) session.status.reasoningEffort = string(selected.reasoningEffort) ?? null;
    if (typeof selected?.contextWindow === "number") session.status.contextWindow = selected.contextWindow;
  }
  private projections(session: RunningSession, value: unknown): void {
    if (!this.isCurrent(session)) return;
    const values = record(value);
    session.imageLimits = imageLimits(values?.imageLimits);
    const model = record(values?.modelSelection);
    this.selection(session, model?.next ?? model?.lastUsed);
    if (typeof values?.title === "string") session.status.threadName = values.title;
    const permissions = record(values?.permissions);
    if (typeof permissions?.currentValue === "string") session.status.sandboxPolicy = permissions.currentValue;
    const questions = record(values?.userQuestions);
    if (questions) {
      const continued = array(questions.active).map(record).filter(item => item?.state === "continued" && typeof item.callId === "string");
      const live = new Set(continued.map(item => `continued:${session.status.threadId}:${item!.callId}`));
      for (const request of this.pending.values()) if (request.session === session && !request.eventId && !live.has(request.id)) this.withdraw(request);
      for (const item of continued) {
        const id = `continued:${session.status.threadId}:${item!.callId}`;
        if (this.pending.has(id)) continue;
        const parsed = parseQuestions(item!.questions);
        if (!parsed) continue;
        const request: PendingInteraction = { id, session, kind: "questions", questions: parsed, callId: item!.callId as string, responding: false };
        this.pending.set(id, request); void this.publishQuestions(request, false);
      }
    }
  }
  private async refreshProjections(session: RunningSession): Promise<void> {
    const result = record(await this.requireTransport().call("session/projections", { request: { sessionId: session.status.threadId } }));
    this.projections(session, result?.values);
  }
  async send(key: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult> {
    const session = this.requireSession(key);
    if (!session.ready || !this.clientId) throw new Error("DSH is reconnecting; wait for native session recovery.");
    if (session.commandAbort) throw new Error("A native DSH command is still running; answer its interaction or interrupt it first.");
    if (options?.collaborationModeExplicit) throw new Error("Use DSH's native /plan command to change its mode.");
    if (text.startsWith("/")) throw new Error("Use the native-command route for slash commands; they are never sent as DSH prompts.");
    if (!text.trim() && !options?.attachments?.length && !options?.images?.length) throw new Error("A non-empty DSH prompt or image is required.");
    if (session.status.waitingForApproval || session.status.waitingForUserInput) throw new Error("Answer the pending DSH interaction or interrupt before sending a prompt.");
    const content = await promptContent(text, options, session.status.workspacePath, session.imageLimits);
    if (!this.isCurrent(session) || !session.ready || !this.clientId) throw new Error("The DSH session changed while preparing input.");
    if (session.commandAbort || session.status.waitingForApproval || session.status.waitingForUserInput) throw new Error("DSH is waiting for a native command or interaction; the prepared input was not submitted.");
    const requestId = options?.clientUserMessageId ?? randomUUID();
    await this.requireTransport().call("session/prompt", { request: {
      sessionId: session.status.threadId, requestId, mode: session.status.activeTurnId ? "steer" : "queue",
      content,
    } });
    return { turnId: session.status.activeTurnId };
  }
  getStatus(key: string): AgentSessionStatus | undefined { return this.sessions.get(key)?.status; }
  async interrupt(key: string): Promise<AgentInterruptResult> {
    const session = this.requireSession(key);
    const turnId = session.status.activeTurnId;
    const commandPending = Boolean(session.commandAbort);
    session.commandAbort?.abort();
    await this.requireTransport().call("session/cancel", { request: { sessionId: session.status.threadId } });
    return { interrupted: Boolean(turnId || commandPending || session.status.waitingForApproval || session.status.waitingForUserInput), turnId };
  }
  async stop(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.commandAbort || session.status.activeTurnId || session.status.waitingForApproval || session.status.waitingForUserInput) await this.interrupt(key);
    session.dispose?.(); this.sessions.delete(key);
    for (const request of this.pending.values()) if (request.session === session) {
      if (request.eventId && request.clientId && this.transport) {
        await this.transport.call("$events/result", { clientId: request.clientId, eventId: request.eventId, outcome: { kind: "next" } }).catch(() => undefined);
      }
      this.withdraw(request);
    }
    session.status.running = false;
    if (this.sessions.size === 0) await this.shutdownTransport();
  }
  async listNativeCommands(key?: string): Promise<AgentNativeCommandSummary[]> {
    if (!key) return [{ command: "/model", description: "Native model picker in DSH Web; start a session to discover plugin commands.", availability: "local-only" }];
    const session = this.requireSession(key);
    const commands = commandDescriptors(await this.requireTransport().call("commands/list", { agentId: session.status.threadId }));
    const result: AgentNativeCommandSummary[] = commands.map(command => ({
      command: `/${command.name}`, description: `${command.description}${command.input?.hint ? ` ${command.input.hint}` : ""}${browserOnlyCommand(command) ? " (requires the native browser download UI)" : ""}`,
      availability: browserOnlyCommand(command) ? "local-only" : "supported",
    }));
    if (!commands.some(command => command.name === "model")) result.push({ command: "/model", description: "Native DSH model picker using the live provider catalog.", availability: "supported" });
    return result;
  }
  async runNativeCommand(key: string, text: string): Promise<AgentNativeCommandResult> {
    const session = this.requireSession(key);
    if (!session.ready || !this.clientId) throw new Error("DSH is reconnecting; native command dispatch is unavailable.");
    const name = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/.exec(text)?.[1];
    if (!name) throw new Error("Invalid DSH native command syntax.");
    if (session.commandAbort) throw new Error("A native DSH command is still running; answer its interaction or interrupt it first.");
    const commandAbort = new AbortController();
    session.commandAbort = commandAbort;
    let dispatched = false;
    try {
    const commands = commandDescriptors(await this.requireTransport().call("commands/list", { agentId: session.status.threadId }));
    const command = commands.find(item => item.name === name);
    if (!command) throw new Error(name === "model" ? "/model is DSH's native browser picker. Use the DSH Web model selector; no fabricated slash arguments are accepted." : `/${name} is not registered for this DSH session.`);
    if (browserOnlyCommand(command)) throw new Error("/export opens a download in DSH Web. Run it in the native browser interface; Relay cannot complete its download UI.");
    // Native commands can wait for human interaction. Do not hold Relay's inbound
    // queue while DSH awaits a response that must enter through that same queue.
    void this.requireTransport().call("commands/execute", { agentId: session.status.threadId, line: text, submittedAttachments: [] }, 0, commandAbort.signal)
      .then(async value => {
        if (!this.isCurrent(session)) return;
        const execution = record(value);
        const result = record(execution?.result);
        if (!execution || !result || !["success", "error"].includes(String(result.kind))) throw new Error("DSH did not execute that native command.");
        if (result.kind === "error") throw new Error(safeMessage(result.text));
        void this.emit({ type: "message", sessionKey: key, chunk: string(result.text) ?? `/${name} completed.` });
        if (this.sessions.get(key) === session) await this.refreshProjections(session).catch(() => {
          session.status.recentWarning = "The native command finished, but its refreshed DSH settings are temporarily unavailable.";
        });
      }).catch(error => { if (!this.isCurrent(session)) return; void this.emit({ type: "activity", sessionKey: key, activity: { kind: "notice", level: commandAbort.signal.aborted ? "info" : "error", title: commandAbort.signal.aborted ? `DSH /${name} interrupted` : `DSH /${name} failed`, detail: commandAbort.signal.aborted ? undefined : safeMessage(error) } }); })
      .finally(() => { if (session.commandAbort === commandAbort) session.commandAbort = undefined; });
    dispatched = true;
    return { message: `Submitted /${name} to DeepSeek Harness.`, threadId: session.status.threadId };
    } finally { if (!dispatched && session.commandAbort === commandAbort) session.commandAbort = undefined; }
  }
  async listThreads(options: AgentThreadListOptions): Promise<AgentThreadSummary[]> {
    const transport = await this.ensureTransport(options.workspacePath);
    const result = record(await transport.call("session/list", { _request: {} }));
    return array(result?.items).map(record).filter((row): row is JsonRecord => Boolean(row && typeof row.sessionId === "string" && typeof row.cwd === "string" && resolve(row.cwd) === resolve(options.workspacePath) && row.origin !== "subagent"))
      .map(row => ({ id: row.sessionId as string, cwd: row.cwd as string, name: string(record(record(row.projections)?.values)?.title), updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : undefined, status: row.running === true ? "running" : "idle" }))
      .filter(row => !options.searchTerm || `${row.id} ${row.name ?? ""}`.toLowerCase().includes(options.searchTerm.toLowerCase()))
      .slice(0, options.limit ?? 100);
  }
  async listModels(): Promise<AgentModelSummary[]> {
    const value = record(await this.requireTransport().call("session/modelCatalog", {}));
    const selected = record(value?.default);
    return array(value?.groups).flatMap(groupValue => {
      const group = record(groupValue);
      return array(group?.models).map(record).filter((model): model is JsonRecord => Boolean(model && typeof model.id === "string"))
        .map(model => ({ id: JSON.stringify([group?.id, model.id]), model: model.id as string, displayName: `${string(group?.name) ?? string(group?.id) ?? ""}: ${string(model.name) ?? model.id}`,
          description: string(model.description), isDefault: group?.id === selected?.provider && model.id === selected?.model,
          supportedReasoningEfforts: array(record(model.reasoning)?.efforts).map(record).map(item => string(item?.id)).filter((v): v is string => v !== undefined),
        }));
    });
  }
  async setModel(key: string, modelId: string): Promise<void> {
    let route: unknown;
    try { route = JSON.parse(modelId); } catch { throw new Error("Invalid DSH model selection."); }
    if (!Array.isArray(route) || route.length !== 2 || route.some(value => typeof value !== "string")) throw new Error("Invalid DSH model selection.");
    const available = await this.listModels();
    if (!available.some(model => model.id === modelId)) throw new Error("This DSH model is no longer in the live catalog.");
    await this.selectModel(key, route[0], route[1]);
  }
  /** Explicit Relay controls may use the real selector API; /model text is never reinterpreted. */
  async selectModel(key: string, provider: string, model: string, reasoningEffort?: string): Promise<void> {
    const session = this.requireSession(key);
    const result = record(await this.requireTransport().call("session/selectModel", { request: { sessionId: session.status.threadId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }));
    this.selection(session, result?.selected);
  }
  async renameThread(key: string, name: string): Promise<void> {
    const session = this.requireSession(key);
    const result = record(await this.requireTransport().call("session/rename", { request: { sessionId: session.status.threadId, title: name } }));
    session.status.threadName = string(result?.title);
  }
  async respond(key: string, id: string | number, result: unknown): Promise<void> {
    const request = this.pending.get(String(id));
    if (!request || request.session.status.sessionKey !== key || request.responding) throw new Error("This DSH interaction has expired, is already being answered, or belongs to another session.");
    if (request.eventId && (!request.clientId || request.clientId !== this.clientId)) throw new Error("This DSH interaction belongs to an expired connection.");
    let value: unknown;
    if (request.kind === "approval") {
      const action = record(result)?.action;
      if (action !== "once" && action !== "decline") throw new Error("DSH permits only the offered one-shot approval or rejection.");
      value = action === "once" ? "allowed-once" : "rejected";
    } else value = encodeAnswers(request.questions!, result);
    request.responding = true;
    try {
      if (request.eventId) await this.requireTransport().call("$events/result", { clientId: request.clientId, eventId: request.eventId, outcome: { kind: "result", value } });
      else {
        const accepted = await this.requireTransport().call("userQuestions/answer", { agentId: request.session.status.threadId, callId: request.callId, answer: value });
        if (accepted !== true) throw new Error("The native DSH question is no longer answerable.");
      }
      this.withdraw(request, value);
    } catch (error) {
      // A transport failure may follow admission. Never replay the answer automatically.
      this.withdraw(request); throw error;
    }
  }
  private onEvent(value: unknown): void {
    const frame = record(value);
    if (!frame) return;
    if (frame.type === "ready" && typeof frame.clientId === "string") {
      this.clientId = frame.clientId; this.resolveEventsReady?.(); return;
    }
    if (frame.type === "cancel" && typeof frame.eventId === "string") {
      for (const request of this.pending.values()) if (request.eventId === frame.eventId) {
        this.withdraw(request); void this.refreshProjections(request.session).catch(() => undefined);
      }
      return;
    }
    if (frame.type === "emit") {
      const args = array(frame.args);
      const session = [...this.sessions.values()].find(item => item.status.threadId === args[0]);
      if (!session) return;
      if (frame.event === "api-session/status" && typeof args[1] === "boolean") session.status.threadStatus = args[1] ? "running" : "idle";
      if (frame.event === "api-session/error") {
        session.status.recentError = safeMessage(args[1]);
        void this.emit({ type: "activity", sessionKey: session.status.sessionKey, activity: { kind: "notice", level: "error", title: "DSH error", detail: session.status.recentError } });
      }
      return;
    }
    if (frame.type !== "waterfall" || typeof frame.eventId !== "string" || !this.clientId) return;
    const session = [...this.sessions.values()].find(item => item.status.threadId === frame.agentId);
    const native = record(frame.request);
    if (!session || !native || !["approval/request", "user-questions/request"].includes(String(frame.event))) {
      void this.requireTransport().call("$events/result", { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: "next" } }).catch(() => undefined); return;
    }
    const id = `dsh:${this.clientId}:${frame.eventId}`;
    if (this.pending.has(id)) return;
    const request: PendingInteraction = { id, session, eventId: frame.eventId, clientId: this.clientId, kind: frame.event === "approval/request" ? "approval" : "questions", responding: false };
    if (request.kind === "approval") {
      if (typeof native.toolName !== "string") {
        void this.requireTransport().call("$events/result", { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: "result", value: "unavailable" } }).catch(() => undefined); return;
      }
      this.pending.set(id, request); this.waiting(session);
      this.emitInteraction({ type: "approval_request", sessionKey: session.status.sessionKey, threadId: session.status.threadId, turnId: session.status.activeTurnId,
        requestId: id, method: "approval/request", approvalKind: "native_tool", itemId: string(native.callId),
        title: `DSH approval: ${native.toolName}`, body: safeMessage(native.reason ?? "Allow this native tool action once?"),
        params: { choices: [{ action: "once", label: "Allow once" }, { action: "decline", label: "Reject" }] },
      }, request);
    } else {
      const questions = parseQuestions(native.questions);
      if (!questions) {
        void this.requireTransport().call("$events/result", { clientId: this.clientId, eventId: frame.eventId, outcome: { kind: "next" } }).catch(() => undefined); return;
      }
      request.questions = questions; request.callId = string(record(native.wait)?.callId);
      this.pending.set(id, request); this.waiting(session); void this.publishQuestions(request, true);
    }
  }
  private async publishQuestions(request: PendingInteraction, blocking: boolean): Promise<void> {
    if (!this.isCurrent(request.session)) return;
    const questions: AgentUserInputQuestion[] = request.questions!.map(item => ({ id: item.id, header: item.header ?? "Question", question: `${item.question}${item.detail ? `\n\n${item.detail}` : ""}`, options: item.options, isOther: true, multiSelect: item.multiSelect === true }));
    this.emitInteraction({ type: "user_input_request", sessionKey: request.session.status.sessionKey, threadId: request.session.status.threadId,
      turnId: request.session.status.activeTurnId, itemId: request.callId, requestId: request.id, questions, isBlocking: blocking }, request);
  }
  private emitInteraction(event: AgentOutputEvent, request: PendingInteraction): void {
    try { void Promise.resolve(this.onOutput(event)).catch(() => this.deliveryFailed(request)); }
    catch { this.deliveryFailed(request); }
  }
  private deliveryFailed(request: PendingInteraction): void {
    this.logger.warn("dsh.interaction_delivery_failed");
    if (this.pending.get(request.id) !== request || request.responding) return;
    if (!request.eventId || request.clientId !== this.clientId || !this.transport) { this.withdraw(request); return; }
    request.responding = true;
    const outcome = request.kind === "approval"
      ? { kind: "result", value: "unavailable" }
      : { kind: "rejected", error: { name: "UserQuestionError", code: "NO_PROVIDER", message: "Relay could not deliver the native question." } };
    void this.transport.call("$events/result", { clientId: request.clientId, eventId: request.eventId, outcome })
      .then(() => { this.withdraw(request); })
      .catch(() => { this.withdraw(request); void this.transport?.close(); });
  }
  private waiting(session: RunningSession): void {
    const pending = [...this.pending.values()].filter(item => item.session === session && item.eventId);
    session.status.waitingForApproval = pending.some(item => item.kind === "approval");
    session.status.waitingForUserInput = pending.some(item => item.kind === "questions");
  }
  private withdraw(request: PendingInteraction, result?: unknown): void {
    if (!this.pending.delete(request.id)) return;
    this.waiting(request.session);
    if (!this.isCurrent(request.session)) return;
    void this.emit({ type: "server_request_resolved", sessionKey: request.session.status.sessionKey, requestId: request.id,
      threadId: request.session.status.threadId, ...(result === undefined ? {} : { result }) });
  }
  private disconnected(): void {
    this.clientId = undefined;
    for (const session of this.sessions.values()) { session.ready = false; session.status.recentWarning = "DSH connection lost; restoring the native session."; }
    for (const request of this.pending.values()) if (request.eventId) this.withdraw(request);
  }
  private exited(transport: DshWebTransport, code: number | null, signal: string | null): void {
    if (this.transport !== transport) return;
    this.rejectEventsReady?.(new Error("DSH exited before event readiness."));
    this.disconnected(); this.transport = undefined; this.connecting = undefined;
    for (const [key, session] of this.sessions) {
      session.status.running = false; session.dispose?.();
      void Promise.resolve(this.onExit({ sessionKey: key, exitCode: code, signalCode: signal })).catch(() => this.logger.warn("dsh.exit_delivery_failed"));
    }
    this.sessions.clear(); this.pending.clear();
  }
  private async shutdownTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined; this.connecting = undefined; this.clientId = undefined;
    if (transport) await transport.close();
  }
  private isCurrent(session: RunningSession): boolean {
    return this.sessions.get(session.status.sessionKey) === session && session.status.running;
  }
  private requireTransport(): DshWebTransport {
    if (!this.transport) throw new Error("Start a DSH session before using its native controls.");
    return this.transport;
  }
  private requireSession(key: string): RunningSession {
    const session = this.sessions.get(key);
    if (!session?.status.running) throw new Error("No running DSH session exists for this conversation.");
    return session;
  }
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) { session.commandAbort?.abort(); session.dispose?.(); session.status.running = false; }
    for (const request of this.pending.values()) this.withdraw(request);
    this.sessions.clear();
    await this.shutdownTransport();
  }
  private emit(event: AgentOutputEvent): Promise<void> {
    // Delivery may itself be queued behind the method driving this protocol.
    try { void Promise.resolve(this.onOutput(event)).catch(() => this.logger.warn("dsh.output_delivery_failed")); }
    catch { this.logger.warn("dsh.output_delivery_failed"); }
    return Promise.resolve();
  }
}

function parseQuestions(value: unknown): NativeQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids = new Set<string>(); const result: NativeQuestion[] = [];
  for (const item of value.map(record)) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.question !== "string") return undefined;
    ids.add(item.id);
    const options = array(item.options).map(record);
    if (options.some(option => typeof option?.label !== "string")) return undefined;
    result.push({ id: item.id, question: item.question, header: string(item.header), detail: string(item.detail), multiSelect: item.multiSelect === true,
      options: options.map(option => ({ label: option!.label as string, description: string(option!.description) ?? "" })) });
  }
  return result;
}
function encodeAnswers(questions: NativeQuestion[], result: unknown): unknown {
  const supplied = record(record(result)?.answers);
  if (!supplied || Object.keys(supplied).length !== questions.length || questions.some(question => !Object.hasOwn(supplied, question.id))) throw new Error("Answer every native DSH question exactly once.");
  return { answers: questions.map(question => {
    const values = record(supplied[question.id])?.answers;
    if (!Array.isArray(values) || values.some(value => typeof value !== "string") || new Set(values).size !== values.length) throw new Error("Invalid native DSH question answer.");
    const labels = new Set(question.options.map(option => option.label));
    const selected = values.filter((value: string) => labels.has(value));
    const other = values.filter((value: string) => !labels.has(value));
    if ((!question.multiSelect && values.length > 1) || other.length > 1) throw new Error("This DSH question does not permit that answer combination.");
    return { id: question.id, selected: !question.multiSelect && other.length ? [] : selected, ...(other.length ? { custom: other[0] } : {}) };
  }) };
}
