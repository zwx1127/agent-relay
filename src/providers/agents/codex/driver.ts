import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import packageJson from "../../../../package.json" with { type: "json" };
import { sessionKey } from "../../../domain/session.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import type {
  AgentBackgroundTerminalSummary,
  AgentActivity,
  AgentBuiltinCommand,
  AgentBuiltinResult,
  AgentFileSearchOptions,
  AgentFileSearchResult,
  AgentInterruptResult,
  AgentSendOptions,
  AgentDriver,
  AgentExitHandler,
  AgentModelSummary,
  AgentOutputEvent,
  AgentOutputHandler,
  AgentSessionStatus,
  AgentSideConversationResult,
  AgentSkillListOptions,
  AgentSkillSummary,
  AgentThreadGoal,
  AgentThreadGoalSetOptions,
  AgentThreadSwitchResult,
  AgentThreadListOptions,
  AgentThreadSummary,
  StartAgentOptions,
} from "../../../ports/agent.ts";
import { applySessionMetadata, applyThreadMetadata, applyThreadSettings, asRecord, collaborationModePayload, getString, getThreadId, getTurnId, imageOutputEvent, isNoActiveTurnToInterruptError, isNoActiveTurnToSteerError, reviewTargetPayload, summarizeUnknown, toModelSummary, toThreadGoal, toThreadSummary, toTokenBreakdown, toTurnCompletedEvent, updateActiveTurnFromResult, userInputPayload } from "./protocol.ts";
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
}

function interactiveRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

interface PendingInteractiveRequest {
  threadId: string;
  sessionKeys: Set<string>;
  resolved: boolean;
  resolutionEmitted: boolean;
}

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
  // Sends for the same relay session must be ordered so steering input cannot
  // overtake the turn/start request that created the active turn.
  private readonly inputQueues = new Map<string, Promise<{ turnId?: string }>>();
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
  private appServerVersion?: string;
  private defaultModel?: string;
  private currentGatewayUrl?: string;

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
      ...(options.threadId ? {
        threadId: options.threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" },
      } : {}),
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
    status.appServerVersion = this.appServerVersion;
    applySessionMetadata(status, result);
    if (options.threadId) this.applyResumedTurnState(status, result);
    const sharedSession = this.firstSessionForThread(threadId);
    this.sessions.set(key, { status, backgroundTerminals: sharedSession?.backgroundTerminals ?? new BackgroundTerminalTracker() });
    this.bindSession(threadId, key);
    this.mirrorThreadStatus(key);
    try {
      const terminals = asRecord(await this.request("thread/backgroundTerminals/list", { threadId, limit: 1 }));
      if (!Array.isArray(terminals?.data)) throw new Error("thread/backgroundTerminals/list returned an invalid response.");
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

    const input = userInputPayload(text, options?.attachments, options?.images);
    const method = running.status.activeTurnId ? "turn/steer" : "turn/start";
    const collaborationMode = options?.collaborationMode ? collaborationModePayload(running.status, options.collaborationMode, this.defaultModel) : undefined;
    const params = running.status.activeTurnId
      ? { threadId: running.status.threadId, expectedTurnId: running.status.activeTurnId, input }
      : { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}) };
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
      running.status.activeTurnId = undefined;
      this.mirrorThreadStatus(key);
      result = await this.request("turn/start", { threadId: running.status.threadId, input, ...(collaborationMode ? { collaborationMode } : {}) });
    }
    updateActiveTurnFromResult(running, result);
    this.mirrorThreadStatus(key);
    return { turnId: getTurnId(result) };
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
    if (!threadId || !this.unbindSession(threadId, key)) return;
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
      });
      updateActiveTurnFromResult(running, result);
      running.reviewTurnId = getTurnId(result);
      running.status.reviewInProgress = true;
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
      });
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
      result = await this.request("thread/goal/clear", { threadId });
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
    const forkResult = await this.request("thread/fork", {
      threadId: running.status.threadId,
      cwd: running.status.workspacePath,
      approvalPolicy: this.options.approval,
      approvalsReviewer: "user",
      sandbox: this.options.sandbox,
      developerInstructions: sideDeveloperInstructions(this.options.developerInstructions),
      ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      ephemeral: true,
      excludeTurns: true,
    });
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
    await this.request("thread/name/set", { threadId: running.status.threadId, name });
    running.status.threadName = name;
  }

  async archiveThread(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    const threadId = running.status.threadId!;
    this.requestedLifecycle.set(threadId, "archived");
    try {
      await this.request("thread/archive", { threadId });
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
      await this.request("thread/delete", { threadId });
    } catch (error) {
      this.requestedLifecycle.delete(threadId);
      throw error;
    }
  }

  async cleanBackgroundTerminals(key: string): Promise<void> {
    const running = this.requireRunningSession(key);
    await this.request("thread/backgroundTerminals/clean", { threadId: running.status.threadId });
    running.backgroundTerminals.clear();
  }

  async terminateBackgroundTerminal(key: string, processId: string): Promise<boolean> {
    const running = this.requireRunningSession(key);
    const result = await this.request("thread/backgroundTerminals/terminate", { threadId: running.status.threadId, processId });
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
      if (completed.status === "inProgress") {
        this.logger.warn("codex.turn_completed_in_progress", { session_key: key, turn_id: completed.turnId });
        return;
      }
      running.status.activeTurnId = undefined;
      const snapshot = turnSnapshot(params?.turn);
      if (snapshot) running.status.latestTurn = snapshot;
      else if (completed.turnId) {
        running.status.latestTurn = {
          id: completed.turnId,
          status: completed.status ?? "failed",
          activities: running.status.latestTurn?.id === completed.turnId ? running.status.latestTurn.activities : [],
          ...(completed.durationMs !== undefined ? { durationMs: completed.durationMs } : {}),
          ...(completed.error ? { error: completed.error } : {}),
        };
      }
      running.status.waitingForApproval = false;
      running.status.waitingForUserInput = false;
      if (running.reviewTurnId === completed.turnId) {
        running.reviewTurnId = undefined;
        running.status.reviewInProgress = false;
      }
      if (completed.status === "failed") {
        running.status.recentError = completed.error?.message ?? "Codex turn failed.";
      } else {
        clearRecentError(running);
      }
      await this.emitOutputForSessions(key, (sessionKeyValue) => ({ ...completed, sessionKey: sessionKeyValue }));
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

  private async request(method: string, params?: unknown, options: { ensureWritable?: boolean } = {}): Promise<unknown> {
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
    this.sessions.clear();
    this.threadToSessions.clear();
    this.pendingInteractiveRequests.clear();
    this.sideConversations.clear();
    this.requestedLifecycle.clear();
    this.requestedGoalMutation.clear();
    this.proc = undefined;
    this.socket = undefined;
    this.ready = undefined;
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
