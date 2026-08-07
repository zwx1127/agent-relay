import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import packageJson from "../../../../package.json" with { type: "json" };
import { sessionKey } from "../../../domain/session.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import type {
  AgentBackgroundTerminalSummary,
  AgentActivity,
  AgentBuiltinCommand,
  AgentBuiltinResult,
  AgentCollaborationMode,
  AgentFileSearchOptions,
  AgentFileSearchResult,
  AgentInterruptResult,
  AgentSendOptions,
  AgentSendResult,
  AgentDriver,
  AgentExitHandler,
  AgentModelSummary,
  AgentOutputEvent,
  AgentOutputHandler,
  AgentRelayCommandContent,
  AgentRelayCommandKind,
  AgentRelayCommandMetadata,
  AgentRelayCommandPhase,
  AgentRelayCommandState,
  AgentRelayThreadState,
  AgentRelayThreadStateUpdate,
  AgentSessionStatus,
  AgentSideConversationResult,
  AgentSkillListOptions,
  AgentSkillSummary,
  AgentThreadGoal,
  AgentThreadGoalSetOptions,
  AgentThreadSwitchResult,
  AgentThreadListOptions,
  AgentThreadSummary,
  AgentTurnCompletedEvent,
  AgentTurnSnapshot,
  StartAgentOptions,
} from "../../../ports/agent.ts";
import {
  RELAY_CONTROL_COMMAND_METHOD,
  RELAY_CONTROL_ACK_METHOD,
  RELAY_CONTROL_HELLO_METHOD,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_CONTROL_RESYNC_METHOD,
  RELAY_CONTROL_SNAPSHOT_METHOD,
  RELAY_CONTROL_THREAD_STATE_METHOD,
  RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
} from "../../../ports/agent/control.ts";
import { applySessionMetadata, applyThreadMetadata, applyThreadSettings, asRecord, collaborationModePayload, getString, getThreadId, getTurnId, imageOutputEvent, isNoActiveTurnToInterruptError, isNoActiveTurnToSteerError, reviewTargetPayload, summarizeUnknown, toModelSummary, toThreadGoal, toThreadSummary, toTokenBreakdown, toTurnCompletedEvent, updateActiveTurnFromResult, userInputPayload, userMessageInput } from "./protocol.ts";
import { codexAppServerSpawnCommand, codexVersionSpawnCommand, formatCodexSpawnError, isCodexVersionSupported, MINIMUM_CODEX_VERSION, parseCodexVersion, type CodexSpawnCommand } from "./spawn.ts";
import { BackgroundTerminalTracker } from "./background-terminals.ts";
import { CodexRpcClient, type JsonRpcMessage, type JsonRpcNotification, type JsonRpcRequest, type JsonRpcResponse } from "./rpc.ts";
import { RecentStderrBuffer } from "./stderr-buffer.ts";
import { activityStatus, itemActivity, planStepStatus, turnSnapshot } from "./activity.ts";
import { changedSettings, globalNoticeFor, nullableNumber, settingsSnapshot } from "./notices.ts";
import { runCommandForOutput } from "./process.ts";
import { sideBoundaryPromptItem, sideDeveloperInstructions } from "./side-conversation.ts";
import { clearRecentError, type PendingGlobalNotice, type RunningSession, type SideConversationCollector } from "./state.ts";
import { handleCodexServerRequest } from "./server-request.ts";

export interface CodexDriverOptions {
  codexBin: string;
  /** Connect through the already-running experimental Gateway instead of spawning stdio. */
  gatewayUrl?: string;
  /** Resolve the manually controlled Gateway only when a connection is needed. */
  gatewayUrlProvider?: () => string;
  sandbox: string;
  approval: string;
  developerInstructions?: string;
  baseInstructions?: string;
  env?: Record<string, string>;
  /** Test override; production uses the fixed five-minute failed-command stall threshold. */
  stallTimeoutMs?: number;
}

function relayCommandState(record: Record<string, unknown> | undefined): AgentRelayCommandState | undefined {
  const commandId = getString(record, "commandId");
  const threadId = getString(record, "threadId");
  const childThreadId = getString(record, "childThreadId");
  const kind = relayCommandKind(getString(record, "kind"));
  const phase = relayCommandPhase(getString(record, "phase"));
  const source = getString(record, "source");
  if (!commandId || !threadId || !kind || !phase || (source !== "relay" && source !== "codex")) return undefined;
  if (typeof record?.revision !== "number" || typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined;
  return {
    commandId,
    threadId,
    ...(childThreadId ? { childThreadId } : {}),
    kind,
    phase,
    source,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.question === "string" ? { question: record.question } : {}),
    ...(typeof record.answer === "string" ? { answer: record.answer } : {}),
  };
}

function relayThreadState(value: unknown): AgentRelayThreadState | undefined {
  const record = asRecord(value);
  const threadId = getString(record, "threadId");
  const mode = getString(record, "collaborationMode");
  if (!threadId || (mode !== "default" && mode !== "plan") || typeof record?.collaborationModeApplied !== "boolean") return undefined;
  if (typeof record.revision !== "number" || typeof record.updatedAt !== "number") return undefined;
  return {
    threadId,
    collaborationMode: mode,
    collaborationModeApplied: record.collaborationModeApplied,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function relayCommandContent(value: unknown): AgentRelayCommandContent | undefined {
  const record = asRecord(value);
  const type = getString(record, "type");
  const text = getString(record, "text");
  return text && (type === "side_question" || type === "side_delta") ? { type, text } : undefined;
}

function relayCommandKind(value: string | undefined): AgentRelayCommandKind | undefined {
  return value === "review" || value === "compact" || value === "side" || value === "rename"
    || value === "goal_update" || value === "goal_clear" || value === "archive" || value === "delete"
    || value === "terminals_clean" || value === "terminal_stop" ? value : undefined;
}

function relayCommandPhase(value: string | undefined): AgentRelayCommandPhase | undefined {
  return value === "accepted" || value === "running" || value === "completed" || value === "failed" || value === "interrupted" ? value : undefined;
}

function isRelayCommandTerminal(phase: AgentRelayCommandPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function interactiveRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function commandExecutionFailed(item: Record<string, unknown>): boolean {
  return getString(item, "status") === "failed"
    || (typeof item.exitCode === "number" && item.exitCode !== 0);
}

interface PendingInteractiveRequest {
  threadId: string;
  sessionKeys: Set<string>;
  resolved: boolean;
  resolutionEmitted: boolean;
}

interface PendingUserMessageOrigin {
  sessionKey: string;
  createdAt: number;
}

interface PendingRelayCommandOrigin {
  sessionKey: string;
  createdAt: number;
}

const USER_MESSAGE_TRACKING_TTL_MS = 10 * 60_000;
const USER_MESSAGE_TRACKING_LIMIT = 2_048;
const FAILED_COMMAND_STALL_MS = 5 * 60_000;
const TERMINAL_TURN_TRACKING_LIMIT = 2_048;

interface TurnStallWatch {
  threadId: string;
  turnId: string;
  stalled: boolean;
  timer?: Timer;
}

type TurnReconcileResult = "terminal" | "active" | "unknown";

export class CodexDriver implements AgentDriver {
  readonly providerId = "codex";
  readonly capabilities = {
    userInputRequests: true,
    approvals: true,
    builtinCommands: true,
    threadFork: true,
    sideConversation: true,
    threadRename: true,
    threadArchive: true,
    threadDelete: true,
    threadGoals: true,
    threadList: true,
    modelList: true,
    backgroundTerminals: true,
    localImages: true,
    structuredInputs: true,
    localAudio: true,
    skillList: true,
    fileSearch: true,
    imageOutput: true,
    interrupt: true,
  };

  private readonly sessions = new Map<string, RunningSession>();
  // Codex notifications are thread-scoped, while relay routing is session-scoped.
  private readonly threadToSessions = new Map<string, Set<string>>();
  private readonly pendingInteractiveRequests = new Map<string, PendingInteractiveRequest>();
  private readonly pendingUserMessageOrigins = new Map<string, PendingUserMessageOrigin>();
  private readonly mirroredUserMessageItems = new Map<string, number>();
  private readonly relayCommandOrigins = new Map<string, PendingRelayCommandOrigin>();
  private readonly relayControlRevisions = new Map<string, { gatewayEpoch: string; revision: number }>();
  private readonly relayResyncRequested = new Set<string>();
  // Sends for the same relay session must be ordered so steering input cannot
  // overtake the turn/start request that created the active turn.
  private readonly inputQueues = new Map<string, Promise<AgentSendResult>>();
  private readonly rpc = new CodexRpcClient((message, options) => this.writeMessage(message, options));
  private readonly recentServerStderr = new RecentStderrBuffer();
  private proc?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private stopping = false;
  private appServerCommand?: CodexSpawnCommand;
  private readonly sideConversations = new Map<string, SideConversationCollector>();
  private readonly requestedLifecycle = new Map<string, "archived" | "deleted">();
  private readonly requestedGoalMutation = new Map<string, { action: "updated" | "cleared"; objective?: string; expiresAt: number }>();
  private readonly pendingGlobalNotices: PendingGlobalNotice[] = [];
  private readonly globalNoticeKeys = new Set<string>();
  private readonly terminalTurns = new Map<string, number>();
  private readonly turnStallWatches = new Map<string, TurnStallWatch>();
  private appServerVersion?: string;
  private defaultModel?: string;
  private currentGatewayUrl?: string;
  private readonly relayInstanceId = randomUUID();
  private gatewayEpoch?: string;

  constructor(
    private readonly options: CodexDriverOptions,
    private readonly onOutput: AgentOutputHandler,
    private readonly onExit: AgentExitHandler,
    private readonly logger: Logger = noopLogger,
  ) {}

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const scopeKey = options.scopeKey ?? String(options.conversationId);
    const key = sessionKey(scopeKey, options.workspaceName, this.providerId);
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
      scopeKey,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: Date.now(),
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(this.usesGateway() ? {
        collaborationMode: "default" as const,
        collaborationModeApplied: true,
        relayStateConsistency: "resyncing" as const,
      } : {}),
    };

    const gateway = this.usesGateway();
    this.logger.info("codex.session_starting", {
      session_key: key,
      conversation_id: options.conversationId,
      workspace: options.workspaceName,
      workspace_path: options.workspacePath,
      thread_id: options.threadId,
      codex_bin: this.options.codexBin,
      security_source: gateway ? "shared_codex_config" : "relay_environment",
      ...(gateway ? {} : { sandbox: this.options.sandbox, approval: this.options.approval }),
    });

    const result = await this.request(options.threadId ? "thread/resume" : "thread/start", {
      ...(options.threadId ? {
        threadId: options.threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
      } : {}),
      ...(!gateway || !options.threadId ? { cwd: options.workspacePath } : {}),
      ...(!gateway ? {
        approvalPolicy: this.options.approval,
        approvalsReviewer: "user",
        sandbox: this.options.sandbox,
      } : {}),
      ...(!gateway ? {
        ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
        ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      } : {}),
    });
    const threadId = getThreadId(result) ?? options.threadId;
    if (!threadId) throw new Error("Codex app-server did not return a thread id.");
    status.threadId = threadId;
    status.appServerVersion = this.appServerVersion;
    applySessionMetadata(status, result);
    if (options.threadId) this.applyResumedTurnState(status, result);
    const sharedSession = this.firstSessionForThread(threadId);
    this.sessions.set(key, { status, backgroundTerminals: sharedSession?.backgroundTerminals ?? new BackgroundTerminalTracker() });
    this.bindSession(threadId, key);
    this.mirrorThreadStatus(key);
    if (options.threadId && status.activeTurnId) await this.reconcileActiveTurn(key, "resume");
    try {
      const [terminals, goalResult] = await Promise.all([
        this.request("thread/backgroundTerminals/list", { threadId, limit: 1 }).then(asRecord),
        this.request("thread/goal/get", { threadId }).then(asRecord),
      ]);
      if (!Array.isArray(terminals?.data)) throw new Error("thread/backgroundTerminals/list returned an invalid response.");
      status.threadGoal = toThreadGoal(goalResult?.goal) ?? null;
      if (gateway) await this.requestRelayControlResync(threadId);
    } catch (error) {
      await this.release(key);
      throw new Error(`Codex ${this.appServerVersion ?? "unknown"} is missing required background-terminal APIs: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.logger.info("codex.session_started", {
      session_key: key,
      conversation_id: options.conversationId,
      workspace: options.workspaceName,
      thread_id: threadId,
    });
    return status;
  }

  async send(key: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult> {
    const previous = this.inputQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.sendNow(key, text, options));
    this.inputQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.inputQueues.get(key) === current) this.inputQueues.delete(key);
    }
  }

  private async sendNow(key: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult> {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.warn("codex.send_without_session", { session_key: key, text_len: text.length });
      throw new Error("Codex session is not running.");
    }

    if (running.status.activeTurnId) await this.reconcileActiveTurn(key, "before_send");

    const input = userInputPayload(text, options?.attachments, options?.images);
    const method = running.status.activeTurnId ? "turn/steer" : "turn/start";
    const gateway = this.usesGateway();
    const collaborationMode = options?.collaborationMode && (!gateway || options.collaborationModeExplicit)
      ? collaborationModePayload(running.status, options.collaborationMode, this.defaultModel)
      : undefined;
    const clientUserMessageId = this.usesGateway() ? `agent-relay:${randomUUID()}` : undefined;
    if (clientUserMessageId) this.registerUserMessageOrigin(clientUserMessageId, key);
    const originParams = clientUserMessageId ? { clientUserMessageId } : {};
    const params = running.status.activeTurnId
      ? { threadId: running.status.threadId, expectedTurnId: running.status.activeTurnId, input, ...originParams }
      : { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}), ...originParams };
    clearRecentError(running);

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
    let collaborationModeApplied = method === "turn/start" && Boolean(collaborationMode);
    try {
      try {
        result = await this.request(method, params);
      } catch (error) {
        if (method !== "turn/steer" || !isNoActiveTurnToSteerError(error)) throw error;
        // The app-server may complete a turn before relay receives the completion
        // notification. Recover by clearing the stale turn and starting a new one.
        this.logger.warn("codex.stale_active_turn_recovered", {
          session_key: key,
          conversation_id: running.status.conversationId,
          workspace: running.status.workspaceName,
          thread_id: running.status.threadId,
          stale_turn_id: running.status.activeTurnId,
        });
        if (running.status.activeTurnId) this.clearTurnStallWatch(running.status.threadId, running.status.activeTurnId);
        running.status.activeTurnId = undefined;
        this.mirrorThreadStatus(key);
        result = await this.request("turn/start", { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}), ...originParams });
        collaborationModeApplied = Boolean(collaborationMode);
      }
    } catch (error) {
      if (clientUserMessageId) this.pendingUserMessageOrigins.delete(clientUserMessageId);
      throw error;
    }
    updateActiveTurnFromResult(running, result);
    const resultTurnId = getTurnId(result);
    if (method === "turn/steer" && resultTurnId) await this.noteTurnProgress(running.status.threadId, resultTurnId);
    this.mirrorThreadStatus(key);
    return { turnId: resultTurnId, ...(collaborationModeApplied ? { collaborationModeApplied: true } : {}) };
  }

  private applyResumedTurnState(status: AgentSessionStatus, result: unknown): void {
    const thread = asRecord(asRecord(result)?.thread);
    const initialTurnsPage = asRecord(asRecord(result)?.initialTurnsPage);
    const initialTurns = Array.isArray(initialTurnsPage?.data) ? initialTurnsPage.data : [];
    const embeddedTurns = Array.isArray(thread?.turns) ? thread.turns : [];
    const latest = turnSnapshot(initialTurns[0] ?? embeddedTurns.at(-1));
    if (!latest) return;
    status.latestTurn = latest;
    if (latest.status === "inProgress") status.activeTurnId = latest.id;
  }

  private async reconcileActiveTurn(key: string, reason: string): Promise<TurnReconcileResult> {
    const running = this.sessions.get(key);
    const threadId = running?.status.threadId;
    const activeTurnId = running?.status.activeTurnId;
    if (!running || !threadId || !activeTurnId) return "unknown";

    this.logger.info("codex.turn_reconcile_started", {
      session_key: key,
      thread_id: threadId,
      turn_id: activeTurnId,
      reason,
    });
    let result: Record<string, unknown> | undefined;
    try {
      result = asRecord(await this.request("thread/read", { threadId, includeTurns: true }));
    } catch (error) {
      this.logger.warn("codex.turn_reconcile_failed", {
        session_key: key,
        thread_id: threadId,
        turn_id: activeTurnId,
        reason,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return "unknown";
    }

    const current = this.sessions.get(key);
    if (!current || current.status.threadId !== threadId || current.status.activeTurnId !== activeTurnId) return "unknown";
    const thread = asRecord(result?.thread);
    applyThreadMetadata(current.status, thread);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const matchingRaw = turns.find((value) => getTurnId({ turn: value }) === activeTurnId);
    const matchingSnapshot = turnSnapshot(matchingRaw);
    if (matchingSnapshot && matchingSnapshot.status !== "inProgress") {
      const completed = toTurnCompletedEvent(key, { turn: matchingRaw });
      this.logger.warn("codex.turn_reconcile_recovered", {
        session_key: key,
        thread_id: threadId,
        turn_id: activeTurnId,
        turn_status: matchingSnapshot.status,
        reason,
      });
      await this.handleTerminalTurn(key, completed, matchingSnapshot, "reconcile");
      return "terminal";
    }

    if (matchingSnapshot) current.status.latestTurn = matchingSnapshot;
    const runtimeStatus = getString(asRecord(thread?.status), "type");
    if (runtimeStatus === "idle" || runtimeStatus === "systemError" || runtimeStatus === "notLoaded") {
      const detail = `Codex thread is ${runtimeStatus}, but turn ${activeTurnId} is still marked in progress. Relay recovered the stale turn because its terminal event is missing.`;
      const snapshot: AgentTurnSnapshot = {
        id: activeTurnId,
        status: "failed",
        activities: matchingSnapshot?.activities ?? current.status.latestTurn?.activities ?? [],
        ...(matchingSnapshot?.startedAt !== undefined ? { startedAt: matchingSnapshot.startedAt } : {}),
        ...(matchingSnapshot?.durationMs !== undefined ? { durationMs: matchingSnapshot.durationMs } : {}),
        error: { message: detail },
      };
      this.logger.warn("codex.turn_reconcile_inconsistent", {
        session_key: key,
        thread_id: threadId,
        turn_id: activeTurnId,
        thread_status: runtimeStatus,
        reason,
      });
      await this.handleTerminalTurn(key, {
        type: "turn_completed",
        sessionKey: key,
        turnId: activeTurnId,
        status: "failed",
        error: snapshot.error,
        ...(snapshot.durationMs !== undefined ? { durationMs: snapshot.durationMs } : {}),
      }, snapshot, "reconcile_inconsistent");
      return "terminal";
    }

    this.mirrorThreadStatus(key);
    this.logger.info("codex.turn_reconcile_still_active", {
      session_key: key,
      thread_id: threadId,
      turn_id: activeTurnId,
      thread_status: runtimeStatus,
      reason,
    });
    return "active";
  }

  private async handleTerminalTurn(
    key: string,
    completed: AgentTurnCompletedEvent,
    snapshot: AgentTurnSnapshot | undefined,
    source: string,
  ): Promise<boolean> {
    if (completed.status === "inProgress") {
      this.logger.warn("codex.turn_completed_in_progress", { session_key: key, turn_id: completed.turnId, source });
      return false;
    }
    const running = this.sessions.get(key);
    const threadId = running?.status.threadId;
    if (!running || !threadId) return false;
    const terminalKey = completed.turnId ? this.turnTrackingKey(threadId, completed.turnId) : undefined;
    if (terminalKey && this.terminalTurns.has(terminalKey)) {
      this.logger.info("codex.turn_terminal_late_duplicate_ignored", {
        session_key: key,
        thread_id: threadId,
        turn_id: completed.turnId,
        source,
      });
      return false;
    }
    if (terminalKey) {
      while (this.terminalTurns.size >= TERMINAL_TURN_TRACKING_LIMIT) {
        const oldest = this.terminalTurns.keys().next().value;
        if (typeof oldest !== "string") break;
        this.terminalTurns.delete(oldest);
      }
      this.terminalTurns.set(terminalKey, Date.now());
    }

    const hadNoLatest = !running.status.latestTurn;
    const matchesActive = Boolean(completed.turnId && running.status.activeTurnId === completed.turnId);
    const matchesLatest = Boolean(completed.turnId && running.status.latestTurn?.id === completed.turnId);
    const hasDifferentActive = Boolean(running.status.activeTurnId && running.status.activeTurnId !== completed.turnId);
    if (hasDifferentActive) {
      this.logger.info("codex.turn_terminal_late_scoped", {
        session_key: key,
        thread_id: threadId,
        turn_id: completed.turnId,
        active_turn_id: running.status.activeTurnId,
        source,
      });
    }
    if (matchesActive) {
      running.status.activeTurnId = undefined;
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
    }
    if (snapshot && !hasDifferentActive && (matchesActive || matchesLatest || hadNoLatest)) {
      running.status.latestTurn = snapshot;
    } else if (completed.turnId && !hasDifferentActive && (matchesActive || matchesLatest || hadNoLatest)) {
      running.status.latestTurn = {
        id: completed.turnId,
        status: completed.status ?? "failed",
        activities: matchesLatest ? running.status.latestTurn?.activities ?? [] : [],
        ...(completed.durationMs !== undefined ? { durationMs: completed.durationMs } : {}),
        ...(completed.error ? { error: completed.error } : {}),
      };
    }
    if (running.reviewTurnId === completed.turnId) {
      running.reviewTurnId = undefined;
      running.status.reviewInProgress = false;
    }
    if (!hasDifferentActive && (matchesActive || matchesLatest || hadNoLatest)) {
      if (completed.status === "failed") running.status.recentError = completed.error?.message ?? "Codex turn failed.";
      else clearRecentError(running);
    }
    if (completed.turnId) this.clearTurnStallWatch(threadId, completed.turnId);
    this.mirrorThreadStatus(key);
    await this.emitOutputForSessions(key, (sessionKeyValue) => ({ ...completed, sessionKey: sessionKeyValue }));
    return true;
  }

  async syncThreadCollaborationMode(
    key: string,
    currentMode: AgentCollaborationMode,
    update: AgentRelayThreadStateUpdate,
  ): Promise<AgentCollaborationMode> {
    const running = this.requireRunningSession(key);
    if (!this.usesGateway()) {
      return update.operation === "toggle"
        ? currentMode === "plan" ? "default" : "plan"
        : update.mode ?? currentMode;
    }
    const result = asRecord(await this.request(RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD, {
      threadId: running.status.threadId,
      operation: update.operation,
      ...(update.mode ? { mode: update.mode } : {}),
    }));
    const mode = getString(result, "collaborationMode");
    if (mode !== "plan" && mode !== "default") throw new Error("Relay Gateway returned an invalid collaboration mode.");
    running.status.collaborationMode = mode;
    running.status.collaborationModeApplied = result?.collaborationModeApplied === true;
    return mode;
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
      this.clearThreadBusyState(running.status.threadId);
    }
    await this.release(key);
    this.logger.info("codex.session_stopped", { session_key: key });
  }

  async release(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) return;
    const threadId = running.status.threadId;
    running.status.running = false;
    this.sessions.delete(key);
    this.inputQueues.delete(key);
    for (const request of this.pendingInteractiveRequests.values()) request.sessionKeys.delete(key);
    for (const [clientId, origin] of this.pendingUserMessageOrigins) {
      if (origin.sessionKey === key) this.pendingUserMessageOrigins.delete(clientId);
    }
    if (!threadId || !this.unbindSession(threadId, key)) return;
    this.clearThreadStallWatches(threadId);
    await this.request("thread/unsubscribe", { threadId }).catch((error) => {
      this.logger.warn("codex.thread_unsubscribe_failed", {
        session_key: key,
        thread_id: threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.sessions.get(key)?.status;
  }

  async interrupt(key: string): Promise<AgentInterruptResult> {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.info("codex.interrupt_without_session", { session_key: key });
      return { interrupted: false };
    }
    const turnId = running.status.activeTurnId;
    if (!turnId) {
      this.logger.info("codex.interrupt_without_active_turn", {
        session_key: key,
        thread_id: running.status.threadId,
      });
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
      this.mirrorThreadStatus(key);
      return { interrupted: false };
    }

    this.logger.info("codex.turn_interrupt_requested", {
      session_key: key,
      conversation_id: running.status.conversationId,
      workspace: running.status.workspaceName,
      thread_id: running.status.threadId,
      active_turn_id: turnId,
    });
    try {
      await this.request("turn/interrupt", {
        threadId: running.status.threadId,
        turnId,
      });
    } catch (error) {
      if (!isNoActiveTurnToInterruptError(error)) throw error;
      this.logger.warn("codex.stale_active_turn_interrupt_recovered", {
        session_key: key,
        conversation_id: running.status.conversationId,
        workspace: running.status.workspaceName,
        thread_id: running.status.threadId,
        stale_turn_id: turnId,
      });
      this.clearThreadBusyState(running.status.threadId);
      return { interrupted: false, turnId, stale: true };
    }
    this.clearThreadBusyState(running.status.threadId);
    return { interrupted: true, turnId };
  }

  async respond(sessionKey: string, requestId: string | number, result: unknown): Promise<void> {
    const request = this.pendingInteractiveRequests.get(interactiveRequestKey(requestId));
    if (request) {
      if (!request.sessionKeys.has(sessionKey)) throw new Error("This Codex request does not belong to the current Relay scope.");
      if (request.resolved) throw new Error("This Codex request has already been resolved.");
      request.resolved = true;
      try {
        await this.rpc.respond(requestId, result);
      } catch (error) {
        request.resolved = false;
        throw error;
      }
      await this.finishInteractiveRequest(requestId, request);
      return;
    }
    await this.rpc.respond(requestId, result);
    const running = this.sessions.get(sessionKey);
    if (running) this.clearThreadWaitingState(running.status.threadId);
  }

  async runBuiltinCommand(key: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult> {
    const running = this.requireRunningSession(key);
    if (command.type === "review") {
      const result = await this.request("review/start", {
        threadId: running.status.threadId,
        target: reviewTargetPayload(command.target ?? { type: "uncommittedChanges" }),
        delivery: "inline",
      }, this.relayCommandRequestOptions(key, "review"));
      updateActiveTurnFromResult(running, result);
      running.reviewTurnId = getTurnId(result);
      running.status.reviewInProgress = true;
      return {
        message: "Review started.",
        threadId: getString(asRecord(result), "reviewThreadId") ?? running.status.threadId,
        turnId: getTurnId(result),
      };
    }

    const result = await this.request("thread/compact/start", { threadId: running.status.threadId }, this.relayCommandRequestOptions(key, "compact"));
    updateActiveTurnFromResult(running, result);
    return { message: "Compaction started.", threadId: running.status.threadId, turnId: getTurnId(result) };
  }

  async getThreadGoal(key: string): Promise<AgentThreadGoal | null> {
    const running = this.requireRunningSession(key);
    const result = await this.request("thread/goal/get", { threadId: running.status.threadId });
    const goal = toThreadGoal(asRecord(result)?.goal);
    running.status.threadGoal = goal ?? null;
    return goal ?? null;
  }

  async setThreadGoal(key: string, goal: AgentThreadGoalSetOptions): Promise<AgentThreadGoal> {
    const running = this.requireRunningSession(key);
    const threadId = running.status.threadId!;
    this.requestedGoalMutation.set(threadId, { action: "updated", ...(goal.objective ? { objective: goal.objective } : {}), expiresAt: Date.now() + 30_000 });
    let result: unknown;
    try {
      result = await this.request("thread/goal/set", {
        threadId,
        ...(goal.objective !== undefined ? { objective: goal.objective } : {}),
        ...(goal.status !== undefined ? { status: goal.status } : {}),
        ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
      }, this.relayCommandRequestOptions(key, "goal_update"));
    } catch (error) {
      this.requestedGoalMutation.delete(threadId);
      throw error;
    }
    const updated = toThreadGoal(asRecord(result)?.goal);
    if (!updated) throw new Error("Codex app-server did not return a thread goal.");
    running.status.threadGoal = updated;
    return updated;
  }

  async clearThreadGoal(key: string): Promise<boolean> {
    const running = this.requireRunningSession(key);
    const threadId = running.status.threadId!;
    this.requestedGoalMutation.set(threadId, { action: "cleared", expiresAt: Date.now() + 30_000 });
    let result: unknown;
    try {
      result = await this.request("thread/goal/clear", { threadId }, this.relayCommandRequestOptions(key, "goal_clear"));
    } catch (error) {
      this.requestedGoalMutation.delete(threadId);
      throw error;
    }
    const cleared = asRecord(result)?.cleared === true;
    if (cleared) running.status.threadGoal = null;
    else this.requestedGoalMutation.delete(threadId);
    return cleared;
  }

  async forkThread(key: string): Promise<AgentThreadSwitchResult> {
    const running = this.requireRunningSession(key);
    const gateway = this.usesGateway();
    const result = await this.request("thread/fork", {
      threadId: running.status.threadId,
      ...(!gateway ? {
        cwd: running.status.workspacePath,
        approvalPolicy: this.options.approval,
        approvalsReviewer: "user",
        sandbox: this.options.sandbox,
        ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
        ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      } : {}),
      excludeTurns: true,
    });
    const threadId = getThreadId(result);
    if (!threadId) throw new Error("Codex app-server did not return a forked thread id.");
    const previousThreadId = running.status.threadId;
    const shouldUnsubscribePrevious = previousThreadId ? this.unbindSession(previousThreadId, key) : false;
    running.status.threadId = threadId;
    const sharedSession = this.firstSessionForThread(threadId);
    running.backgroundTerminals = sharedSession?.backgroundTerminals ?? new BackgroundTerminalTracker();
    applySessionMetadata(running.status, result);
    this.bindSession(threadId, key);
    if (shouldUnsubscribePrevious && previousThreadId) {
      await this.request("thread/unsubscribe", { threadId: previousThreadId }).catch((error) => {
        this.logger.warn("codex.thread_unsubscribe_failed", {
          session_key: key,
          thread_id: previousThreadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }
    return { threadId, threadName: running.status.threadName };
  }

  async sideConversation(key: string, text: string): Promise<AgentSideConversationResult> {
    const running = this.requireRunningSession(key);
    const gateway = this.usesGateway();
    const forkResult = await this.request("thread/fork", {
      threadId: running.status.threadId,
      ...(!gateway ? {
        cwd: running.status.workspacePath,
        approvalPolicy: this.options.approval,
        approvalsReviewer: "user",
        sandbox: this.options.sandbox,
        developerInstructions: sideDeveloperInstructions(this.options.developerInstructions),
        ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      } : {}),
      ephemeral: true,
      excludeTurns: true,
    }, this.relayCommandRequestOptions(key, "side"));
    const threadId = getThreadId(forkResult);
    if (!threadId) throw new Error("Codex app-server did not return a side conversation thread id.");

    try {
      return await new Promise<AgentSideConversationResult>(async (resolve, reject) => {
        const collector: SideConversationCollector = {
          threadId,
          text: "",
          resolve,
          reject,
        };
        this.sideConversations.set(threadId, collector);
        try {
          // Inject the boundary as a thread item instead of prepending it to the
          // user's text, keeping inherited history and the active question distinct.
          await this.request("thread/inject_items", {
            threadId,
            items: [sideBoundaryPromptItem()],
          });
          const turnResult = await this.request("turn/start", {
            threadId,
            input: userInputPayload(text, undefined),
          });
          collector.turnId = getTurnId(turnResult);
        } catch (error) {
          this.sideConversations.delete(threadId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      try {
        await this.request("thread/unsubscribe", { threadId });
      } catch (error) {
        this.logger.warn("codex.side_conversation_unsubscribe_failed", {
          session_key: key,
          thread_id: threadId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  async renameThread(key: string, name: string): Promise<void> {
    const running = this.requireRunningSession(key);
    await this.request("thread/name/set", { threadId: running.status.threadId, name }, this.relayCommandRequestOptions(key, "rename"));
    running.status.threadName = name;
  }

  async archiveThread(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    const threadId = running.status.threadId!;
    this.requestedLifecycle.set(threadId, "archived");
    try {
      await this.request("thread/archive", { threadId }, this.relayCommandRequestOptions(key, "archive"));
    } catch (error) {
      this.requestedLifecycle.delete(threadId);
      throw error;
    }
  }

  async deleteThread(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    const threadId = running.status.threadId!;
    this.requestedLifecycle.set(threadId, "deleted");
    try {
      await this.request("thread/delete", { threadId }, this.relayCommandRequestOptions(key, "delete"));
    } catch (error) {
      this.requestedLifecycle.delete(threadId);
      throw error;
    }
  }

  async cleanBackgroundTerminals(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    await this.request("thread/backgroundTerminals/clean", { threadId: running.status.threadId }, this.relayCommandRequestOptions(key, "terminals_clean"));
    running.backgroundTerminals.clear();
  }

  async terminateBackgroundTerminal(key: string, processId: string): Promise<boolean> {
    const running = this.requireRunningSession(key);
    const result = await this.request("thread/backgroundTerminals/terminate", { threadId: running.status.threadId, processId }, this.relayCommandRequestOptions(key, "terminal_stop"));
    return asRecord(result)?.terminated === true;
  }

  async listBackgroundTerminals(key: string): Promise<AgentBackgroundTerminalSummary[]> {
    const running = this.requireRunningSession(key);
    const terminals: AgentBackgroundTerminalSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = asRecord(await this.request("thread/backgroundTerminals/list", {
        threadId: running.status.threadId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }));
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const value of data) {
        const terminal = asRecord(value);
        const itemId = getString(terminal, "itemId");
        const processId = getString(terminal, "processId");
        if (!itemId || !processId) continue;
        terminals.push({
          itemId,
          processId,
          commandDisplay: getString(terminal, "command") ?? "(command unavailable)",
          ...(getString(terminal, "cwd") ? { cwd: getString(terminal, "cwd") } : {}),
          osPid: nullableNumber(terminal?.osPid),
          cpuPercent: nullableNumber(terminal?.cpuPercent),
          rssKb: nullableNumber(terminal?.rssKb),
          recentChunks: running.backgroundTerminals.recentLines(itemId, processId),
        });
      }
      const next = getString(result, "nextCursor");
      if (!next || seenCursors.has(next) || terminals.length >= 200) break;
      seenCursors.add(next);
      cursor = next;
    } while (cursor);
    return terminals.slice(0, 200);
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

  async listSkills(workspacePath: string, options: AgentSkillListOptions = {}): Promise<AgentSkillSummary[]> {
    await this.ensureServer();
    const result = asRecord(await this.request("skills/list", {
      cwds: [workspacePath],
      ...(options.forceReload ? { forceReload: true } : {}),
    }));
    const entries = Array.isArray(result?.data) ? result.data : [];
    const skills: AgentSkillSummary[] = [];
    for (const entryValue of entries) {
      const entry = asRecord(entryValue);
      const cwd = getString(entry, "cwd");
      if (cwd && cwd !== workspacePath) continue;
      for (const skillValue of Array.isArray(entry?.skills) ? entry.skills : []) {
        const skill = asRecord(skillValue);
        const name = getString(skill, "name");
        const path = getString(skill, "path");
        if (!name || !path) continue;
        skills.push({
          name,
          path,
          description: getString(skill, "description") ?? getString(skill, "shortDescription") ?? "",
          ...(getString(skill, "scope") ? { scope: getString(skill, "scope") } : {}),
          enabled: skill?.enabled !== false,
        });
      }
    }
    return skills;
  }

  async searchFiles(workspacePath: string, query: string, options: AgentFileSearchOptions = {}): Promise<AgentFileSearchResult[]> {
    await this.ensureServer();
    const result = asRecord(await this.request("fuzzyFileSearch", {
      query,
      roots: [workspacePath],
      cancellationToken: null,
    }));
    const files = Array.isArray(result?.files) ? result.files : [];
    return files.map((value): AgentFileSearchResult | undefined => {
      const file = asRecord(value);
      const root = getString(file, "root") ?? workspacePath;
      const path = getString(file, "path");
      if (!path) return undefined;
      return {
        root,
        path,
        fileName: getString(file, "file_name") ?? path,
        ...(getString(file, "match_type") ? { matchType: getString(file, "match_type") } : {}),
        ...(typeof file?.score === "number" ? { score: file.score } : {}),
      };
    }).filter((file): file is AgentFileSearchResult => Boolean(file)).slice(0, options.limit ?? 100);
  }

  private async ensureServer(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = this.startServer().catch((error) => {
      if (this.ready === ready) this.ready = undefined;
      throw error;
    });
    this.ready = ready;
    return ready;
  }

  private async startServer(): Promise<void> {
    this.stopping = false;
    const env = { ...process.env, ...this.options.env };
    this.appServerVersion = await this.readAndValidateCodexVersion(env);
    this.recentServerStderr.clear();
    let proc: ChildProcessWithoutNullStreams | undefined;
    let socket: WebSocket | undefined;
    const gatewayUrl = this.options.gatewayUrl ?? this.options.gatewayUrlProvider?.();
    this.currentGatewayUrl = gatewayUrl;
    if (gatewayUrl) {
      socket = await this.connectGateway(gatewayUrl);
    } else {
      const command = codexAppServerSpawnCommand(this.options.codexBin, env);
      this.appServerCommand = command;
      try {
        this.proc = spawn(command.command, command.args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          ...(command.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
        });
      } catch (error) {
        this.proc = undefined;
        throw formatCodexSpawnError(error, this.options.codexBin);
      }

      proc = this.proc;
      createInterface({ input: proc.stdout }).on("line", (line) => this.handleLine(line));
      createInterface({ input: proc.stderr }).on("line", (line) => {
        if (line.trim()) {
          this.recordServerStderr(line);
          this.logger.debug("codex.app_server_stderr", { line });
        }
      });
      proc.on("error", (error) => this.handleServerError(error));
      proc.on("exit", (exitCode, signalCode) => this.handleServerExit(exitCode, signalCode));
    }

    try {
      const initializeResult = await this.request("initialize", {
        clientInfo: { name: "agent-relay", title: "Agent Relay", version: packageJson.version },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [
            "command/exec/outputDelta",
            "item/commandExecution/terminalInteraction",
          ],
        },
      }, { ensureWritable: false });
      const reportedVersion = parseCodexVersion(getString(asRecord(initializeResult), "userAgent") ?? "");
      if (reportedVersion && reportedVersion !== this.appServerVersion) {
        this.logger.warn("codex.app_server_version_mismatch", { preflight_version: this.appServerVersion, user_agent_version: reportedVersion });
      }
      await this.rpc.notify("initialized", undefined, { ensureWritable: false });
      if (gatewayUrl) {
        const control = asRecord(await this.request(RELAY_CONTROL_HELLO_METHOD, {
          version: RELAY_CONTROL_PROTOCOL_VERSION,
          instanceId: this.relayInstanceId,
        }, { ensureWritable: false }));
        if (control?.version !== RELAY_CONTROL_PROTOCOL_VERSION || typeof control.gatewayEpoch !== "string") {
          throw new Error("Experimental relay Gateway did not negotiate the Relay control protocol.");
        }
        this.gatewayEpoch = control.gatewayEpoch;
      }
      await this.probeServerCapabilities();
    } catch (error) {
      if (proc && this.proc === proc && !proc.killed) proc.kill();
      if (socket && this.socket === socket) socket.close();
      this.proc = undefined;
      this.socket = undefined;
      throw error;
    }
    this.logger.info("codex.app_server_started", {
      version: this.appServerVersion,
      transport: gatewayUrl ? "experimental_gateway" : "stdio",
      gateway_url: gatewayUrl,
    });
  }

  private connectGateway(url: string): Promise<WebSocket> {
    return new Promise((resolveConnection, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to experimental relay Gateway at ${url}.`));
      }, 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolveConnection(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => {
        const line = typeof event.data === "string" ? event.data : String(event.data);
        for (const message of line.split(/\r?\n/)) if (message.trim()) this.handleLine(message);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        if (this.socket !== socket) {
          reject(new Error(`Failed to connect to experimental relay Gateway at ${url}.`));
          return;
        }
        this.handleServerError(new Error(`Experimental relay Gateway connection failed: ${url}`));
        this.handleServerExit(null, null);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.handleServerExit(null, null);
      });
    });
  }

  private async readAndValidateCodexVersion(env: NodeJS.ProcessEnv): Promise<string> {
    const command = codexVersionSpawnCommand(this.options.codexBin, env);
    const output = await runCommandForOutput(command, env).catch((error) => {
      throw formatCodexSpawnError(error, this.options.codexBin);
    });
    const version = parseCodexVersion(output);
    if (!version) throw new Error(`Unable to parse Codex version from ${JSON.stringify(output.trim())}. Agent Relay requires codex-cli ${MINIMUM_CODEX_VERSION} or newer.`);
    if (!isCodexVersionSupported(version)) throw new Error(`Unsupported codex-cli ${version}. Agent Relay requires ${MINIMUM_CODEX_VERSION} or newer.`);
    return version;
  }

  private async probeServerCapabilities(): Promise<void> {
    const modelResult = asRecord(await this.request("model/list", { includeHidden: false }, { ensureWritable: false }));
    const models = Array.isArray(modelResult?.data)
      ? modelResult.data.map(toModelSummary).filter((model): model is AgentModelSummary => Boolean(model))
      : [];
    if (models.length === 0) throw new Error("Codex capability probe failed: model/list returned no usable models.");
    this.defaultModel = models.find((model) => model.isDefault)?.model ?? models.find((model) => model.isDefault)?.id ?? models[0]?.model ?? models[0]?.id;
    const collaborationResult = asRecord(await this.request("collaborationMode/list", {}, { ensureWritable: false }));
    const modes = Array.isArray(collaborationResult?.data)
      ? collaborationResult.data.map((value) => getString(asRecord(value), "mode")).filter((mode): mode is string => Boolean(mode))
      : [];
    if (!modes.includes("default") || !modes.includes("plan")) {
      throw new Error("Codex capability probe failed: collaborationMode/list did not advertise default and plan modes.");
    }
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

    // JSON-RPC responses resolve local requests; notifications and requests are
    // routed separately because app-server can ask relay to collect input.
    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      this.rpc.handleResponse(message as JsonRpcResponse, (id) => {
        this.logger.debug("codex.unmatched_response", { id });
      });
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

  private async handleNotification(message: JsonRpcNotification): Promise<void> {
    if (message.method === RELAY_CONTROL_COMMAND_METHOD) {
      await this.handleRelayCommandNotification(message.params);
      return;
    }
    if (message.method === RELAY_CONTROL_THREAD_STATE_METHOD) {
      await this.handleRelayThreadStateNotification(message.params);
      return;
    }
    if (message.method === RELAY_CONTROL_SNAPSHOT_METHOD) {
      await this.handleRelayControlSnapshot(message.params);
      return;
    }
    const params = asRecord(message.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const sideConversation = threadId ? this.sideConversations.get(threadId) : undefined;
    // Ephemeral side-conversation notifications are consumed locally and never
    // update the parent relay session or transcript.
    if (sideConversation && await this.handleSideConversationNotification(sideConversation, message, params)) return;
    if (message.method === "serverRequest/resolved") {
      const requestId = params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") await this.resolveInteractiveRequest(requestId);
      return;
    }
    const keys = threadId ? this.sessionKeysForThread(threadId) : [];
    const key = keys[0];

    if (message.method === "thread/started") {
      const startedThreadId = getThreadId({ thread: params?.thread });
      const sessionKeys = startedThreadId ? this.sessionKeysForThread(startedThreadId) : [];
      for (const sessionKey of sessionKeys) {
        const running = this.sessions.get(sessionKey);
        if (running) applyThreadMetadata(running.status, asRecord(params?.thread));
      }
      this.logger.debug("codex.thread_started", { thread_id: startedThreadId, session_keys: sessionKeys.join(",") });
      return;
    }

    const globalNotice = globalNoticeFor(message.method, params);
    if (!key && globalNotice) {
      this.queueGlobalNotice(globalNotice);
      return;
    }
    if (!key) return;
    const running = this.sessions.get(key);
    if (!running) return;
    await this.flushGlobalNotices(key);
    const notificationTurnId = getTurnId(params);
    if (notificationTurnId && message.method !== "turn/completed") {
      await this.noteTurnProgress(threadId!, notificationTurnId);
    }
    try {

    if (message.method === "item/reasoning/summaryTextDelta") {
      const delta = getString(params, "delta");
      if (delta) await this.emitActivity(key, { kind: "reasoning", summary: delta, ...(typeof params?.summaryIndex === "number" ? { sectionIndex: params.summaryIndex } : {}) }, params, getString(params, "itemId"));
      return;
    }

    if (message.method === "item/reasoning/textDelta") {
      this.logger.debug("codex.raw_reasoning_delta", {
        session_key: key,
        turn_id: getTurnId(params),
        item_id: getString(params, "itemId"),
        reasoning_text: getString(params, "delta") ?? "",
      });
      return;
    }

    if (message.method === "item/reasoning/summaryPartAdded") return;

    if (message.method === "turn/plan/updated") {
      const steps = (Array.isArray(params?.plan) ? params.plan : []).map((value) => {
        const step = asRecord(value);
        const text = getString(step, "step");
        const status = planStepStatus(getString(step, "status"));
        return text && status ? { step: text, status } : undefined;
      }).filter((step): step is { step: string; status: "pending" | "inProgress" | "completed" } => Boolean(step));
      await this.emitActivity(key, { kind: "plan", ...(getString(params, "explanation") ? { explanation: getString(params, "explanation") } : {}), steps }, params);
      return;
    }

    if (message.method === "turn/diff/updated") {
      const diff = getString(params, "diff");
      if (diff !== undefined) await this.emitActivity(key, { kind: "diff", diff }, params);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const turnId = getTurnId(params);
      const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
      if (delta) await this.emitOutputForSessions(key, (sessionKeyValue) => ({ type: "message", sessionKey: sessionKeyValue, chunk: delta, turnId, itemId }));
      return;
    }

    if (message.method === "item/plan/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      const turnId = getTurnId(params);
      const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
      if (delta) await this.emitOutputForSessions(key, (sessionKeyValue) => ({ type: "message", sessionKey: sessionKeyValue, chunk: delta, turnId, itemId }));
      return;
    }

    if (message.method === "item/started") {
      running.backgroundTerminals.started(params);
      const item = asRecord(params?.item);
      if (this.usesGateway() && item?.type === "userMessage") {
        await this.emitUserMessage(running.status.threadId, item, params);
        return;
      }
      const activity = itemActivity(item, true);
      if (activity) await this.emitActivity(key, activity, params, getString(item, "id"));
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      running.backgroundTerminals.output(params);
      return;
    }

    if (message.method === "item/fileChange/patchUpdated") {
      const files = (Array.isArray(params?.changes) ? params.changes : []).map((value) => {
        const change = asRecord(value);
        const path = getString(change, "path");
        return path ? { path, ...(getString(change, "kind") ? { kind: getString(change, "kind") } : {}) } : undefined;
      }).filter((file): file is { path: string; kind?: string } => Boolean(file));
      await this.emitActivity(key, { kind: "item", category: "fileChange", label: `File changes (${files.length})`, status: "inProgress", files }, params, getString(params, "itemId"));
      return;
    }

    if (message.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "commandExecution") running.backgroundTerminals.completed(item);
      const activity = itemActivity(item, false);
      if (activity) await this.emitActivity(key, activity, params, getString(item, "id"));
      if (item?.type === "commandExecution" && notificationTurnId && commandExecutionFailed(item)) {
        this.armTurnStallWatch(threadId!, notificationTurnId);
      }
      if (item?.type === "exitedReviewMode" && typeof item.review === "string" && item.review) {
        const review = item.review;
        await this.emitOutputForSessions(key, (sessionKeyValue) => ({ type: "message", sessionKey: sessionKeyValue, chunk: review, turnId: getTurnId(params), itemId: getString(item, "id") }));
      }
      if (item?.type === "imageGeneration") {
        await this.emitOutputForSessions(key, (sessionKeyValue) => imageOutputEvent(sessionKeyValue, item, getTurnId(params)));
      }
      return;
    }

    if (message.method === "rawResponseItem/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "image_generation_call") {
        await this.emitOutputForSessions(key, (sessionKeyValue) => imageOutputEvent(sessionKeyValue, item, getTurnId(params)));
      }
      return;
    }

    if (message.method === "turn/started") {
      const snapshot = turnSnapshot(params?.turn);
      const turnId = snapshot?.id ?? getTurnId({ turn: params?.turn });
      if (turnId) running.status.activeTurnId = turnId;
      if (snapshot) running.status.latestTurn = snapshot;
      else if (turnId) running.status.latestTurn = { id: turnId, status: "inProgress", activities: [] };
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
      clearRecentError(running);
      await this.emitActivity(key, { kind: "item", category: "other", label: "Turn started", status: "started" }, params, turnId ? `turn:${turnId}` : undefined);
      return;
    }

    if (message.method === "item/mcpToolCall/progress") {
      await this.emitActivity(key, {
        kind: "item",
        category: "mcp",
        label: `MCP ${getString(params, "server") ?? "server"}/${getString(params, "tool") ?? "tool"}`,
        status: "inProgress",
        ...(getString(params, "message") ? { detail: getString(params, "message") } : {}),
      }, params, getString(params, "itemId"));
      return;
    }

    if (message.method === "hook/started" || message.method === "hook/completed") {
      const run = asRecord(params?.run);
      const status = message.method.endsWith("started") ? "inProgress" : activityStatus(getString(run, "status"), false);
      await this.emitActivity(key, {
        kind: "item",
        category: "hook",
        label: `Hook ${summarizeUnknown(run?.eventName) ?? getString(run, "id") ?? "run"}`,
        status,
        ...(getString(run, "statusMessage") ? { detail: getString(run, "statusMessage") } : {}),
        ...(typeof run?.durationMs === "number" ? { durationMs: run.durationMs } : {}),
      }, params, getString(run, "id"));
      return;
    }

    if (message.method === "item/autoApprovalReview/started" || message.method === "item/autoApprovalReview/completed") {
      const completed = message.method.endsWith("completed");
      await this.emitActivity(key, {
        kind: "item",
        category: "guardian",
        label: "Guardian approval review",
        status: completed ? "completed" : "inProgress",
        ...(completed && params?.decisionSource !== undefined ? { detail: `Decision: ${summarizeUnknown(params.decisionSource)}` } : {}),
        ...(completed && typeof params?.startedAtMs === "number" && typeof params?.completedAtMs === "number" ? { durationMs: params.completedAtMs - params.startedAtMs } : {}),
      }, params, getString(params, "reviewId"));
      return;
    }

    if (message.method === "turn/completed") {
      const completed = toTurnCompletedEvent(key, params);
      const snapshot = turnSnapshot(params?.turn);
      await this.handleTerminalTurn(key, completed, snapshot, "notification");
      return;
    }

    if (message.method === "thread/settings/updated") {
      const before = settingsSnapshot(running.status);
      applyThreadSettings(running.status, params?.threadSettings);
      const changes = changedSettings(before, settingsSnapshot(running.status));
      if (Object.keys(changes).length) await this.emitActivity(key, { kind: "settings", changes }, params);
      return;
    }

    if (message.method === "thread/goal/updated") {
      const goal = toThreadGoal(params?.goal);
      running.status.threadGoal = goal ?? running.status.threadGoal;
      const requested = this.requestedGoalMutation.get(threadId!);
      const suppress = requested?.action === "updated" && requested.expiresAt >= Date.now() && (!requested.objective || requested.objective === goal?.objective);
      if (suppress) this.requestedGoalMutation.delete(threadId!);
      else if (goal) await this.emitActivity(key, { kind: "goal", goal }, params);
      return;
    }

    if (message.method === "thread/goal/cleared") {
      running.status.threadGoal = null;
      const requested = this.requestedGoalMutation.get(threadId!);
      if (requested?.action === "cleared" && requested.expiresAt >= Date.now()) this.requestedGoalMutation.delete(threadId!);
      else await this.emitActivity(key, { kind: "goal", goal: null }, params);
      return;
    }

    if (message.method === "thread/archived" || message.method === "thread/deleted" || message.method === "thread/closed") {
      const action = message.method.slice("thread/".length) as "archived" | "deleted" | "closed";
      const initiatedByClient = this.requestedLifecycle.get(threadId!) === action;
      this.requestedLifecycle.delete(threadId!);
      this.requestedGoalMutation.delete(threadId!);
      this.clearThreadStallWatches(threadId!);
      this.threadToSessions.delete(threadId!);
      for (const sessionKeyValue of keys) {
        const session = this.sessions.get(sessionKeyValue);
        if (session) session.status.running = false;
        this.sessions.delete(sessionKeyValue);
        this.inputQueues.delete(sessionKeyValue);
        await this.onOutput({ type: "thread_lifecycle", sessionKey: sessionKeyValue, threadId: threadId!, action, ...(initiatedByClient ? { initiatedByClient: true } : {}) });
      }
      return;
    }

    if (message.method === "thread/status/changed") {
      const threadStatus = asRecord(params?.status);
      running.status.threadStatus = typeof threadStatus?.type === "string" ? threadStatus.type : undefined;
      // Active flags are the app-server's canonical waiting state; relay mirrors
      // them so normal prompts can be blocked before reaching Codex.
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
      await this.emitActivity(key, { kind: "item", category: "model", label: "Model rerouted", status: "completed", ...(toModel ? { detail: toModel } : {}) }, params);
      return;
    }

    if (message.method === "model/verification") {
      const count = Array.isArray(params?.verifications) ? params.verifications.length : 0;
      await this.emitActivity(key, { kind: "item", category: "model", label: "Model verification", status: "completed", detail: `${count} check(s)` }, params);
      return;
    }

    if (message.method === "model/safetyBuffering/updated") {
      const enabled = params?.showBufferingUi === true;
      await this.emitActivity(key, {
        kind: "item",
        category: "guardian",
        label: enabled ? "Model safety buffering" : "Model safety buffering cleared",
        status: enabled ? "warning" : "completed",
        ...(Array.isArray(params?.reasons) && params.reasons.length ? { detail: params.reasons.filter((reason): reason is string => typeof reason === "string").join("; ") } : {}),
      }, params);
      return;
    }

    if (message.method === "turn/moderationMetadata") {
      await this.emitActivity(key, { kind: "item", category: "guardian", label: "Moderation metadata updated", status: "completed" }, params);
      return;
    }

    if (message.method === "warning" || message.method === "guardianWarning" || message.method === "configWarning" || message.method === "deprecationNotice") {
      const notice = globalNotice ?? globalNoticeFor(message.method, params);
      const warning = getString(params, "message") ?? getString(params, "summary") ?? notice?.detail ?? notice?.title;
      if (warning) running.status.recentWarning = warning;
      if (notice) await this.emitActivity(key, { kind: "notice", level: notice.level, title: notice.title, ...(notice.detail ? { detail: notice.detail } : {}) }, params);
      return;
    }

    if (message.method === "thread/compacted") {
      await this.emitActivity(key, { kind: "item", category: "compaction", label: "Context compacted", status: "completed" }, params);
      return;
    }

    if (message.method === "error") {
      running.status.recentError = summarizeUnknown(params?.error);
      await this.emitActivity(key, { kind: "notice", level: "error", title: "Codex error", ...(running.status.recentError ? { detail: running.status.recentError } : {}) }, params);
      return;
    }
    } finally {
      this.mirrorThreadStatus(key);
    }
  }

  private async handleSideConversationNotification(
    collector: SideConversationCollector,
    message: JsonRpcNotification,
    params: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    if (message.method === "item/agentMessage/delta" || message.method === "item/plan/delta") {
      const delta = typeof params?.delta === "string" ? params.delta : "";
      if (delta) collector.text += delta;
      return true;
    }
    if (message.method === "item/completed") {
      const item = asRecord(params?.item);
      if (item?.type === "exitedReviewMode" && typeof item.review === "string") collector.text += item.review;
      return true;
    }
    if (message.method === "turn/started") {
      collector.turnId = getTurnId({ turn: params?.turn }) ?? collector.turnId;
      return true;
    }
    if (message.method === "turn/completed") {
      const turnId = getTurnId(params) ?? collector.turnId;
      this.sideConversations.delete(collector.threadId);
      collector.resolve({
        message: collector.text.trim() || "Side conversation completed without a text response.",
        threadId: collector.threadId,
        ...(turnId ? { turnId } : {}),
      });
      return true;
    }
    if (message.method === "error") {
      const error = summarizeUnknown(params?.error) ?? "Side conversation failed.";
      this.sideConversations.delete(collector.threadId);
      collector.reject(new Error(error));
      return true;
    }
    return message.method.startsWith("thread/") || message.method.startsWith("item/");
  }

  private async handleRelayCommandNotification(value: unknown): Promise<void> {
    const params = asRecord(value);
    const state = relayCommandState(params);
    if (!state || !this.acceptRelayControlEnvelope(params, state.threadId)) return;
    const originToken = getString(params, "originToken");
    this.pruneRelayCommandOrigins();
    const originSessionKey = originToken ? this.relayCommandOrigins.get(originToken)?.sessionKey : undefined;
    const content = relayCommandContent(params?.content);
    for (const key of this.sessionKeysForThread(state.threadId)) {
      if (key === originSessionKey) continue;
      await this.onOutput({
        type: "relay_command_state",
        sessionKey: key,
        gatewayEpoch: this.gatewayEpoch!,
        threadRevision: state.revision,
        ...state,
        ...(content ? { content } : {}),
      });
    }
    if (originToken && isRelayCommandTerminal(state.phase)) this.relayCommandOrigins.delete(originToken);
  }

  private async handleRelayThreadStateNotification(value: unknown): Promise<void> {
    const params = asRecord(value);
    const state = relayThreadState(params);
    if (!state || !this.acceptRelayControlEnvelope(params, state.threadId)) return;
    for (const key of this.sessionKeysForThread(state.threadId)) {
      const running = this.sessions.get(key);
      if (running) {
        running.status.collaborationMode = state.collaborationMode;
        running.status.collaborationModeApplied = state.collaborationModeApplied;
        running.status.relayStateConsistency = "live";
      }
      await this.onOutput({
        type: "relay_thread_state",
        sessionKey: key,
        gatewayEpoch: this.gatewayEpoch!,
        threadRevision: state.revision,
        ...state,
      });
    }
  }

  private async handleRelayControlSnapshot(value: unknown): Promise<void> {
    const params = asRecord(value);
    const threadId = getString(params, "threadId");
    const gatewayEpoch = getString(params, "gatewayEpoch");
    const threadState = relayThreadState(params?.threadState);
    if (!threadId || !gatewayEpoch || gatewayEpoch !== this.gatewayEpoch || !threadState || threadState.threadId !== threadId) return;
    const commands = Array.isArray(params?.commands)
      ? params.commands.map((command) => relayCommandState(asRecord(command))).filter((command): command is AgentRelayCommandState => Boolean(command))
      : [];
    const revision = typeof params?.revision === "number" ? params.revision : threadState.revision;
    if (params?.consistency !== "live") return;
    this.relayControlRevisions.set(threadId, { gatewayEpoch, revision });
    this.relayResyncRequested.delete(threadId);
    for (const key of this.sessionKeysForThread(threadId)) {
      const running = this.sessions.get(key);
      if (running) {
        running.status.collaborationMode = threadState.collaborationMode;
        running.status.collaborationModeApplied = threadState.collaborationModeApplied;
        running.status.relayStateConsistency = "live";
      }
      await this.onOutput({
        type: "relay_control_snapshot",
        sessionKey: key,
        threadId,
        gatewayEpoch,
        revision,
        consistency: "live",
        threadState,
        commands,
      });
    }
    this.ackRelayControl(threadId, revision);
  }

  private acceptRelayControlEnvelope(params: Record<string, unknown> | undefined, threadId: string): boolean {
    const gatewayEpoch = getString(params, "gatewayEpoch");
    const revision = params?.threadRevision;
    if (!gatewayEpoch || gatewayEpoch !== this.gatewayEpoch || typeof revision !== "number") return false;
    const current = this.relayControlRevisions.get(threadId);
    if (!current || current.gatewayEpoch !== gatewayEpoch || revision !== current.revision + 1) {
      if (current?.gatewayEpoch === gatewayEpoch && revision <= current.revision) return false;
      this.markRelayResyncing(threadId);
      void this.requestRelayControlResync(threadId).catch((error) => {
        this.logger.warn("codex.relay_control_resync_failed", { thread_id: threadId, error: toError(error) });
      });
      return false;
    }
    this.relayControlRevisions.set(threadId, { gatewayEpoch, revision });
    this.ackRelayControl(threadId, revision);
    return true;
  }

  private markRelayResyncing(threadId: string): void {
    for (const key of this.sessionKeysForThread(threadId)) {
      const running = this.sessions.get(key);
      if (running) running.status.relayStateConsistency = "resyncing";
    }
  }

  private async requestRelayControlResync(threadId: string): Promise<void> {
    if (!this.usesGateway() || this.relayResyncRequested.has(threadId)) return;
    this.relayResyncRequested.add(threadId);
    this.markRelayResyncing(threadId);
    try {
      await this.request(RELAY_CONTROL_RESYNC_METHOD, { threadId }, { ensureWritable: false });
    } catch (error) {
      this.relayResyncRequested.delete(threadId);
      throw error;
    }
  }

  private ackRelayControl(threadId: string, revision: number): void {
    if (!this.usesGateway() || !this.gatewayEpoch) return;
    void this.rpc.notify(RELAY_CONTROL_ACK_METHOD, {
      gatewayEpoch: this.gatewayEpoch,
      threadId,
      revision,
    }, { ensureWritable: false }).catch((error) => {
      this.logger.debug("codex.relay_control_ack_failed", { thread_id: threadId, revision, error: toError(error) });
    });
  }

  private async emitActivity(
    sessionKeyValue: string,
    activity: AgentActivity,
    params?: Record<string, unknown>,
    itemId?: string,
  ): Promise<void> {
    const running = this.sessions.get(sessionKeyValue);
    const turnId = getTurnId(params) ?? running?.status.activeTurnId;
    const threadId = running?.status.threadId;
    await this.emitOutputForSessions(sessionKeyValue, (targetKey) => ({
      type: "activity",
      sessionKey: targetKey,
      activity,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    }));
  }

  private async emitOutputForSessions(
    sessionKeyValue: string,
    createEvent: (targetKey: string) => AgentOutputEvent,
  ): Promise<void> {
    const running = this.sessions.get(sessionKeyValue);
    const keys = running?.status.threadId ? this.sessionKeysForThread(running.status.threadId) : [sessionKeyValue];
    for (const key of keys) await this.onOutput(createEvent(key));
  }

  private async emitUserMessage(
    threadId: string | undefined,
    item: Record<string, unknown>,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!threadId) return;
    const itemId = getString(item, "id");
    const clientId = getString(item, "clientId");
    const originSessionKey = clientId ? this.takeUserMessageOrigin(clientId) : undefined;
    if (!itemId || !this.markUserMessageItem(threadId, itemId)) return;
    const input = userMessageInput(item);
    if (!input) {
      this.logger.debug("codex.shared_user_message_ignored", {
        thread_id: threadId,
        item_id: itemId,
        reason: "empty_or_unsupported_content",
      });
      return;
    }
    const turnId = getTurnId(params);
    const targetKeys = this.sessionKeysForThread(threadId).filter((key) => key !== originSessionKey);
    this.logger.info("codex.shared_user_message_received", {
      thread_id: threadId,
      turn_id: turnId,
      item_id: itemId,
      client_id: clientId,
      origin_session_key: originSessionKey,
      target_count: targetKeys.length,
    });
    for (const key of targetKeys) {
      await this.onOutput({
        type: "user_message",
        sessionKey: key,
        input,
        threadId,
        ...(turnId ? { turnId } : {}),
        itemId,
      });
    }
  }

  private registerUserMessageOrigin(clientId: string, sessionKeyValue: string): void {
    this.pruneUserMessageTracking();
    while (this.pendingUserMessageOrigins.size >= USER_MESSAGE_TRACKING_LIMIT) {
      const oldest = this.pendingUserMessageOrigins.keys().next().value;
      if (typeof oldest !== "string") break;
      this.pendingUserMessageOrigins.delete(oldest);
    }
    this.pendingUserMessageOrigins.set(clientId, { sessionKey: sessionKeyValue, createdAt: Date.now() });
  }

  private takeUserMessageOrigin(clientId: string): string | undefined {
    this.pruneUserMessageTracking();
    const origin = this.pendingUserMessageOrigins.get(clientId);
    this.pendingUserMessageOrigins.delete(clientId);
    return origin?.sessionKey;
  }

  private markUserMessageItem(threadId: string, itemId: string): boolean {
    this.pruneUserMessageTracking();
    const key = `${threadId}\0${itemId}`;
    if (this.mirroredUserMessageItems.has(key)) return false;
    while (this.mirroredUserMessageItems.size >= USER_MESSAGE_TRACKING_LIMIT) {
      const oldest = this.mirroredUserMessageItems.keys().next().value;
      if (typeof oldest !== "string") break;
      this.mirroredUserMessageItems.delete(oldest);
    }
    this.mirroredUserMessageItems.set(key, Date.now());
    return true;
  }

  private pruneUserMessageTracking(now = Date.now()): void {
    const cutoff = now - USER_MESSAGE_TRACKING_TTL_MS;
    for (const [clientId, origin] of this.pendingUserMessageOrigins) {
      if (origin.createdAt >= cutoff) break;
      this.pendingUserMessageOrigins.delete(clientId);
    }
    for (const [itemKey, createdAt] of this.mirroredUserMessageItems) {
      if (createdAt >= cutoff) break;
      this.mirroredUserMessageItems.delete(itemKey);
    }
  }

  private bindSession(threadId: string, key: string): void {
    const keys = this.threadToSessions.get(threadId) ?? new Set<string>();
    keys.add(key);
    this.threadToSessions.set(threadId, keys);
  }

  /** Returns true when the app-server connection no longer has a logical subscriber. */
  private unbindSession(threadId: string, key: string): boolean {
    const keys = this.threadToSessions.get(threadId);
    if (!keys) return false;
    keys.delete(key);
    if (keys.size > 0) return false;
    this.threadToSessions.delete(threadId);
    return true;
  }

  private sessionKeysForThread(threadId: string): string[] {
    return [...(this.threadToSessions.get(threadId) ?? [])].filter((key) => this.sessions.has(key));
  }

  private firstSessionForThread(threadId: string): RunningSession | undefined {
    const key = this.sessionKeysForThread(threadId)[0];
    return key ? this.sessions.get(key) : undefined;
  }

  private turnTrackingKey(threadId: string, turnId: string): string {
    return `${threadId}\0${turnId}`;
  }

  private armTurnStallWatch(threadId: string, turnId: string): void {
    const watchKey = this.turnTrackingKey(threadId, turnId);
    const existing = this.turnStallWatches.get(watchKey);
    if (existing?.timer) clearTimeout(existing.timer);
    const watch = existing ?? { threadId, turnId, stalled: false };
    this.turnStallWatches.set(watchKey, watch);
    this.scheduleTurnStallCheck(watchKey, watch);
  }

  private scheduleTurnStallCheck(watchKey: string, watch: TurnStallWatch): void {
    const timeoutMs = this.options.stallTimeoutMs ?? FAILED_COMMAND_STALL_MS;
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.checkTurnStall(watchKey, watch).catch((error) => {
        this.logger.warn("codex.turn_stall_check_failed", {
          thread_id: watch.threadId,
          turn_id: watch.turnId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        if (this.turnStallWatches.get(watchKey) === watch) this.scheduleTurnStallCheck(watchKey, watch);
      });
    }, Math.max(1, timeoutMs));
    watch.timer.unref();
  }

  private async checkTurnStall(watchKey: string, watch: TurnStallWatch): Promise<void> {
    if (this.turnStallWatches.get(watchKey) !== watch) return;
    const key = this.sessionKeysForThread(watch.threadId)
      .find((sessionKeyValue) => this.sessions.get(sessionKeyValue)?.status.activeTurnId === watch.turnId);
    if (!key) {
      this.clearTurnStallWatch(watch.threadId, watch.turnId);
      return;
    }
    const result = await this.reconcileActiveTurn(key, "failed_command_stall");
    if (result === "terminal" || this.turnStallWatches.get(watchKey) !== watch) return;
    const stillActive = this.sessionKeysForThread(watch.threadId)
      .some((sessionKeyValue) => this.sessions.get(sessionKeyValue)?.status.activeTurnId === watch.turnId);
    if (!stillActive) {
      this.clearTurnStallWatch(watch.threadId, watch.turnId);
      return;
    }
    if (!watch.stalled) {
      watch.stalled = true;
      const detail = "No Codex events for 5 minutes after a failed command. The turn is still active; interrupt it if needed.";
      this.logger.warn("codex.turn_stalled", {
        thread_id: watch.threadId,
        turn_id: watch.turnId,
        reconcile_result: result,
      });
      for (const sessionKeyValue of this.sessionKeysForThread(watch.threadId)) {
        await this.onOutput({
          type: "turn_stalled",
          sessionKey: sessionKeyValue,
          threadId: watch.threadId,
          turnId: watch.turnId,
          detail,
        });
      }
    }
    this.scheduleTurnStallCheck(watchKey, watch);
  }

  private async noteTurnProgress(threadId: string, turnId: string): Promise<void> {
    const watchKey = this.turnTrackingKey(threadId, turnId);
    const watch = this.turnStallWatches.get(watchKey);
    if (!watch) return;
    const wasStalled = watch.stalled;
    this.clearTurnStallWatch(threadId, turnId);
    if (!wasStalled) return;
    this.logger.info("codex.turn_stall_cleared", { thread_id: threadId, turn_id: turnId });
    for (const sessionKeyValue of this.sessionKeysForThread(threadId)) {
      await this.onOutput({ type: "turn_progressed", sessionKey: sessionKeyValue, threadId, turnId });
    }
  }

  private clearTurnStallWatch(threadId: string, turnId: string): void {
    const key = this.turnTrackingKey(threadId, turnId);
    const watch = this.turnStallWatches.get(key);
    if (watch?.timer) clearTimeout(watch.timer);
    this.turnStallWatches.delete(key);
  }

  private clearThreadStallWatches(threadId: string): void {
    const prefix = `${threadId}\0`;
    for (const [key, watch] of this.turnStallWatches) {
      if (!key.startsWith(prefix)) continue;
      if (watch.timer) clearTimeout(watch.timer);
      this.turnStallWatches.delete(key);
    }
  }

  private mirrorThreadStatus(sourceKey: string): void {
    const source = this.sessions.get(sourceKey);
    const threadId = source?.status.threadId;
    if (!source || !threadId) return;
    for (const key of this.sessionKeysForThread(threadId)) {
      if (key === sourceKey) continue;
      const target = this.sessions.get(key);
      if (!target) continue;
      const identity = {
        sessionKey: target.status.sessionKey,
        conversationId: target.status.conversationId,
        scopeKey: target.status.scopeKey,
        workspaceName: target.status.workspaceName,
        workspacePath: target.status.workspacePath,
        startedAt: target.status.startedAt,
      };
      const identityKeys = new Set(Object.keys(identity));
      const sourceRecord = source.status as unknown as Record<string, unknown>;
      const targetRecord = target.status as unknown as Record<string, unknown>;
      for (const property of Object.keys(targetRecord)) {
        if (!identityKeys.has(property) && !(property in sourceRecord)) delete targetRecord[property];
      }
      Object.assign(target.status, source.status, identity);
    }
  }

  private clearThreadBusyState(threadId: string | undefined): void {
    if (!threadId) return;
    this.clearThreadStallWatches(threadId);
    for (const key of this.sessionKeysForThread(threadId)) {
      const running = this.sessions.get(key);
      if (!running) continue;
      running.status.activeTurnId = undefined;
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
    }
  }

  private clearThreadWaitingState(threadId: string | undefined): void {
    if (!threadId) return;
    for (const key of this.sessionKeysForThread(threadId)) {
      const running = this.sessions.get(key);
      if (!running) continue;
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
    }
  }

  private registerInteractiveRequest(requestId: string | number, threadId: string, sessionKeys: string[]): void {
    this.pendingInteractiveRequests.set(interactiveRequestKey(requestId), {
      threadId,
      sessionKeys: new Set(sessionKeys),
      resolved: false,
      resolutionEmitted: false,
    });
  }

  private async resolveInteractiveRequest(requestId: string | number): Promise<void> {
    const request = this.pendingInteractiveRequests.get(interactiveRequestKey(requestId));
    if (!request) return;
    request.resolved = true;
    await this.finishInteractiveRequest(requestId, request);
  }

  private async finishInteractiveRequest(requestId: string | number, request: PendingInteractiveRequest): Promise<void> {
    this.clearThreadWaitingState(request.threadId);
    if (!request.resolutionEmitted) {
      request.resolutionEmitted = true;
      for (const key of request.sessionKeys) {
        if (this.sessions.get(key)?.status.threadId === request.threadId) {
          await this.onOutput({ type: "server_request_resolved", sessionKey: key, requestId });
        }
      }
    }
    const mapKey = interactiveRequestKey(requestId);
    setTimeout(() => {
      if (this.pendingInteractiveRequests.get(mapKey) === request) this.pendingInteractiveRequests.delete(mapKey);
    }, 5 * 60_000).unref();
  }

  private queueGlobalNotice(notice: PendingGlobalNotice): void {
    const key = `${notice.level}\u0000${notice.title}\u0000${notice.detail ?? ""}`;
    if (this.globalNoticeKeys.has(key)) return;
    this.globalNoticeKeys.add(key);
    this.pendingGlobalNotices.push(notice);
  }

  private async flushGlobalNotices(sessionKeyValue: string): Promise<void> {
    if (this.pendingGlobalNotices.length === 0) return;
    const notices = this.pendingGlobalNotices.splice(0);
    for (const notice of notices) {
      await this.emitActivity(sessionKeyValue, {
        kind: "notice",
        level: notice.level,
        title: notice.title,
        ...(notice.detail ? { detail: notice.detail } : {}),
      });
    }
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    await handleCodexServerRequest(message, {
      sessions: this.sessions,
      threadToSessions: this.threadToSessions,
      sideConversations: this.sideConversations,
      rpc: this.rpc,
      logger: this.logger,
      onOutput: this.onOutput,
      emitActivity: (key, activity, params) => this.emitActivity(key, activity, params),
      registerRequest: (requestId, threadId, sessionKeys) => this.registerInteractiveRequest(requestId, threadId, sessionKeys),
    });
  }

  private relayCommandRequestOptions(key: string, kind: AgentRelayCommandKind): { relayControl?: AgentRelayCommandMetadata } {
    if (!this.usesGateway()) return {};
    this.pruneRelayCommandOrigins();
    const originToken = `agent-relay:${randomUUID()}`;
    this.relayCommandOrigins.set(originToken, { sessionKey: key, createdAt: Date.now() });
    return {
      relayControl: {
        version: RELAY_CONTROL_PROTOCOL_VERSION,
        commandId: `agent-relay:${randomUUID()}`,
        kind,
        originToken,
      },
    };
  }

  private pruneRelayCommandOrigins(now = Date.now()): void {
    const cutoff = now - USER_MESSAGE_TRACKING_TTL_MS;
    for (const [token, origin] of this.relayCommandOrigins) {
      if (origin.createdAt >= cutoff) break;
      this.relayCommandOrigins.delete(token);
    }
    while (this.relayCommandOrigins.size > USER_MESSAGE_TRACKING_LIMIT) {
      const oldest = this.relayCommandOrigins.keys().next().value;
      if (typeof oldest !== "string") break;
      this.relayCommandOrigins.delete(oldest);
    }
  }

  private async request(method: string, params?: unknown, options: { ensureWritable?: boolean; relayControl?: AgentRelayCommandMetadata } = {}): Promise<unknown> {
    return await this.rpc.request(method, params, options);
  }

  private requireRunningSession(key: string): RunningSession {
    const running = this.sessions.get(key);
    if (!running?.status.threadId) {
      this.logger.warn("codex.builtin_without_session", { session_key: key });
      throw new Error("Codex session is not running.");
    }
    return running;
  }

  private async writeMessage(message: JsonRpcMessage, options: { ensureWritable?: boolean } = {}): Promise<void> {
    if (options.ensureWritable !== false) await this.ensureWritable();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    if (!this.proc) throw new Error("Codex app-server is not running.");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async ensureWritable(): Promise<void> {
    const socketWritable = this.socket?.readyState === WebSocket.OPEN;
    const processWritable = Boolean(this.proc && !this.proc.killed && this.proc.stdin.writable);
    if (!socketWritable && !processWritable) {
      this.ready = undefined;
      await this.ensureServer();
    }
  }

  private handleServerExit(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    if (this.stopping) return;
    const recentStderr = this.recentServerStderrText();
    this.logger.warn("codex.app_server_exited", { exit_code: exitCode, signal_code: signalCode, recent_stderr: recentStderr || undefined });
    this.rpc.rejectPending(this.appServerExitError(exitCode, signalCode));
    const sessions = [...this.sessions.values()];
    const sideConversations = [...this.sideConversations.values()];
    for (const watch of this.turnStallWatches.values()) {
      if (watch.timer) clearTimeout(watch.timer);
    }
    this.turnStallWatches.clear();
    this.terminalTurns.clear();
    this.sessions.clear();
    this.threadToSessions.clear();
    this.pendingInteractiveRequests.clear();
    this.pendingUserMessageOrigins.clear();
    this.mirroredUserMessageItems.clear();
    this.relayCommandOrigins.clear();
    this.relayControlRevisions.clear();
    this.relayResyncRequested.clear();
    this.sideConversations.clear();
    this.requestedLifecycle.clear();
    this.requestedGoalMutation.clear();
    this.proc = undefined;
    this.socket = undefined;
    this.ready = undefined;
    this.gatewayEpoch = undefined;
    for (const running of sessions) {
      running.status.running = false;
      void this.onExit({ sessionKey: running.status.sessionKey, exitCode, signalCode });
    }
    for (const sideConversation of sideConversations) {
      sideConversation.reject(this.appServerExitError(exitCode, signalCode));
    }
  }

  private handleServerError(error: Error): void {
    if (this.stopping) return;
    const wrapped = this.usesGateway()
      ? new Error(`Experimental relay Gateway unavailable${this.currentGatewayUrl ? ` at ${this.currentGatewayUrl}` : ""}. ${error.message}`)
      : formatCodexSpawnError(error, this.options.codexBin);
    this.logger.error("codex.app_server_spawn_failed", {
      codex_bin: this.options.codexBin,
      error: wrapped,
    });
    this.rpc.rejectPending(wrapped);
    this.proc = undefined;
    this.socket = undefined;
    this.ready = undefined;
    this.gatewayEpoch = undefined;
    this.relayCommandOrigins.clear();
    this.relayControlRevisions.clear();
    this.relayResyncRequested.clear();
  }

  private recordServerStderr(line: string): void {
    this.recentServerStderr.push(line);
  }

  private recentServerStderrText(): string {
    return this.recentServerStderr.text();
  }

  private usesGateway(): boolean {
    return Boolean(this.options.gatewayUrl || this.options.gatewayUrlProvider);
  }

  private appServerExitError(exitCode: number | null, signalCode: NodeJS.Signals | null): Error {
    const status = signalCode
      ? `signal ${signalCode}`
      : exitCode === null
        ? "unknown status"
        : `code ${exitCode}`;
    const command = this.appServerCommand;
    const details = [
      `Codex app-server exited with ${status}.`,
      this.recentServerStderrText() ? `Recent stderr:\n${this.recentServerStderrText()}` : undefined,
      command ? `CODEX_BIN=${JSON.stringify(this.options.codexBin)}, resolved=${JSON.stringify(command.resolvedCodexBin)}, command=${JSON.stringify(command.command)}, args=${JSON.stringify(command.args)}, windowsVerbatimArguments=${JSON.stringify(command.windowsVerbatimArguments)}` : undefined,
    ].filter((part): part is string => Boolean(part));
    return new Error(details.join(" "));
  }

}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
