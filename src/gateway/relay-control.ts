import { randomUUID } from "node:crypto";
import type {
  AgentRelayActiveTurnState,
  AgentCollaborationMode,
  AgentRelayCommandKind,
  AgentRelayCommandMetadata,
  AgentRelayCommandPhase,
  AgentRelayCommandState,
  AgentRelayLatestTurnState,
  AgentRelayPlanDecisionPhase,
  AgentRelayPlanDecisionState,
  AgentRelayStateSource,
  AgentRelayThreadState,
  AgentRelayThreadStatus,
  AgentRelayWaitingOn,
} from "../ports/agent.ts";
import {
  RELAY_CONTROL_COMMAND_METHOD,
  RELAY_CONTROL_ACK_METHOD,
  RELAY_CONTROL_HELLO_METHOD,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_CONTROL_RESYNC_METHOD,
  RELAY_CONTROL_SNAPSHOT_METHOD,
  RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
  RELAY_CONTROL_PLAN_DECISION_FAIL_METHOD,
  RELAY_CONTROL_PLAN_DECISION_METHOD,
  RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD,
  RELAY_CONTROL_THREAD_STATE_METHOD,
  RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
} from "../ports/agent/control.ts";
import { messageThreadId } from "./live-events.ts";

export {
  RELAY_CONTROL_COMMAND_METHOD,
  RELAY_CONTROL_ACK_METHOD,
  RELAY_CONTROL_HELLO_METHOD,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_CONTROL_RESYNC_METHOD,
  RELAY_CONTROL_SNAPSHOT_METHOD,
  RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
  RELAY_CONTROL_PLAN_DECISION_FAIL_METHOD,
  RELAY_CONTROL_PLAN_DECISION_METHOD,
  RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD,
  RELAY_CONTROL_THREAD_STATE_METHOD,
  RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
};

const TERMINAL_TTL_MS = 60 * 60_000;
const ACTIVE_TTL_MS = 24 * 60 * 60_000;
const ACTIVE_LIMIT_PER_THREAD = 100;
const TERMINAL_LIMIT_PER_THREAD = 100;
const SNAPSHOT_TERMINAL_LIMIT = 20;
const PLAN_IMPLEMENT_START_TIMEOUT_MS = 30_000;
const MODE_RESERVATION_TTL_MS = 10_000;
const PENDING_TURN_TTL_MS = 30_000;

export interface RelayControlClientData {
  id: string;
  name?: string;
  threads: Set<string>;
  relayControlVersion?: number;
  relayInstanceId?: string;
  relayControlAcks?: Map<string, number>;
}

export interface RelayControlClient {
  data: RelayControlClientData;
  socket: { send(data: string): unknown };
}

interface InternalCommand extends AgentRelayCommandState {
  originClientId: string;
  originToken?: string;
  turnId?: string;
  operationThreadId?: string;
}

interface InternalPlanDecision extends AgentRelayPlanDecisionState {
  claimClientId?: string;
  claimRelayInstanceId?: string;
  implementationRequestKey?: string;
  implementationTimer?: Timer;
}

interface PendingModeUpdate {
  threadId: string;
  mode: "default" | "plan";
  source: AgentRelayStateSource;
  requestedAt: number;
  method: "thread/settings/update" | "turn/start";
}

interface PendingModeReservation {
  threadId: string;
  mode: "default" | "plan";
  clientId: string;
  createdAt: number;
}

interface PendingTurnStart {
  threadId: string;
  mode: "default" | "plan";
  source: AgentRelayStateSource;
  requestedAt: number;
}

interface PendingThreadSnapshot {
  threadId?: string;
}

interface PendingInterrupt {
  threadId: string;
  turnId?: string;
  source: AgentRelayStateSource;
  requestedAt: number;
}

interface RecentNotification {
  clientId: string;
  observedAt: number;
}

export interface RelayControlFrontendResult {
  handled: boolean;
  message?: Record<string, unknown>;
}

export class GatewayRelayControl {
  readonly gatewayEpoch = randomUUID();

  private readonly commands = new Map<string, InternalCommand>();
  private readonly commandIdsByThread = new Map<string, string[]>();
  private readonly pendingByRequest = new Map<string, string>();
  private readonly commandByTurn = new Map<string, string>();
  private readonly pendingModesByRequest = new Map<string, PendingModeUpdate>();
  private readonly pendingModesByThread = new Map<string, PendingModeUpdate>();
  private readonly modeReservationsByThread = new Map<string, PendingModeReservation>();
  private readonly pendingTurnStartsByRequest = new Map<string, PendingTurnStart>();
  private readonly pendingTurnStartsByThread = new Map<string, PendingTurnStart>();
  private readonly pendingSnapshotsByRequest = new Map<string, PendingThreadSnapshot>();
  private readonly pendingInterruptsByRequest = new Map<string, PendingInterrupt>();
  private readonly pendingInterruptsByThread = new Map<string, PendingInterrupt>();
  private readonly turnSources = new Map<string, Pick<AgentRelayActiveTurnState, "source" | "collaborationMode" | "startedAt">>();
  private readonly threadStates = new Map<string, AgentRelayThreadState>();
  private readonly planDecisions = new Map<string, InternalPlanDecision>();
  private readonly planDecisionKeysByThread = new Map<string, string[]>();
  private readonly planImplementationByRequest = new Map<string, string>();
  private readonly threadRevisions = new Map<string, number>();
  private readonly recentNotifications = new Map<string, RecentNotification>();

  constructor(
    private readonly clients: () => Iterable<RelayControlClient>,
  ) {
    setInterval(() => this.pruneAll(), 60_000).unref();
  }

  handleFrontend(client: RelayControlClient, message: Record<string, unknown>): RelayControlFrontendResult {
    if (message.method === RELAY_CONTROL_HELLO_METHOD) {
      this.handleHello(client, message);
      return { handled: true };
    }
    if (message.method === RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD) {
      this.handleThreadStateUpdate(client, message);
      return { handled: true };
    }
    if (message.method === RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD
      || message.method === RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD
      || message.method === RELAY_CONTROL_PLAN_DECISION_FAIL_METHOD) {
      this.handlePlanDecisionRequest(client, message);
      return { handled: true };
    }
    if (message.method === RELAY_CONTROL_ACK_METHOD) {
      this.handleAck(client, message);
      return { handled: true };
    }
    if (message.method === RELAY_CONTROL_RESYNC_METHOD) {
      this.handleResync(client, message);
      return { handled: true };
    }

    const method = typeof message.method === "string" ? message.method : undefined;
    const params = asRecord(message.params);
    if (!method) return { handled: false, message };

    const requestThreadId = getString(params, "threadId");
    if (method === "turn/start" && isRequest(message) && requestThreadId
      && (this.modeReservation(requestThreadId) || this.pendingModesByThread.has(requestThreadId))) {
      this.sendError(client, message.id, -32000, "A collaboration mode update is already in progress.");
      return { handled: true };
    }

    const explicitMode = explicitCollaborationMode(params);
    if (explicitMode && isRequest(message) && (method === "thread/settings/update" || method === "turn/start")) {
      const current = this.threadState(explicitMode.threadId);
      if (current.threadStatus !== "idle" || this.pendingTurnStart(explicitMode.threadId)) {
        this.sendModeBusyError(client, message.id, current.threadStatus === "idle" ? "active" : current.threadStatus);
        return { handled: true };
      }
      const reservation = this.modeReservation(explicitMode.threadId);
      const inFlightMode = this.pendingModesByThread.get(explicitMode.threadId);
      if (method === "thread/settings/update" && inFlightMode) {
        this.sendError(client, message.id, -32000, "Another collaboration mode update is already in progress.");
        return { handled: true };
      }
      if (method === "thread/settings/update" && reservation
        && (reservation.clientId !== client.data.id || reservation.mode !== explicitMode.mode)) {
        this.sendError(client, message.id, -32000, "Another collaboration mode update is already in progress.");
        return { handled: true };
      }
      if (method === "thread/settings/update") this.modeReservationsByThread.delete(explicitMode.threadId);
      const pendingMode: PendingModeUpdate = {
        ...explicitMode,
        source: stateSource(client.data.name),
        requestedAt: Date.now(),
        method,
      };
      const key = requestKey(client.data.id, message.id);
      this.pendingModesByRequest.set(key, pendingMode);
      this.pendingModesByThread.set(explicitMode.threadId, pendingMode);
    }
    if (method === "turn/start" && isRequest(message)) {
      const threadId = getString(params, "threadId");
      if (threadId) {
        const pendingStart: PendingTurnStart = {
          threadId,
          mode: explicitMode?.mode ?? this.threadState(threadId).collaborationMode,
          source: stateSource(client.data.name),
          requestedAt: Date.now(),
        };
        const key = requestKey(client.data.id, message.id);
        this.pendingTurnStartsByRequest.set(key, pendingStart);
        this.pendingTurnStartsByThread.set(threadId, pendingStart);
      }
      this.bindPlanImplementationRequest(client, message, params);
    }
    if (method === "turn/interrupt" && isRequest(message)) {
      const threadId = getString(params, "threadId");
      if (threadId) {
        const pendingInterrupt: PendingInterrupt = {
          threadId,
          ...(getString(params, "turnId") ? { turnId: getString(params, "turnId") } : {}),
          source: stateSource(client.data.name),
          requestedAt: Date.now(),
        };
        const key = requestKey(client.data.id, message.id);
        this.pendingInterruptsByRequest.set(key, pendingInterrupt);
        this.pendingInterruptsByThread.set(threadId, pendingInterrupt);
        this.requestTurnInterrupt(pendingInterrupt);
      }
    }
    if (isRequest(message) && (method === "thread/start" || method === "thread/resume" || method === "thread/fork" || method === "thread/read")) {
      this.pendingSnapshotsByRequest.set(requestKey(client.data.id, message.id), {
        ...(getString(params, "threadId") ? { threadId: getString(params, "threadId") } : {}),
      });
    }

    const kind = commandKind(method, params);
    if (!kind || !isRequest(message)) {
      if (message.relayControl !== undefined && isRequest(message)) {
        this.sendError(client, message.id, -32602, "Relay control metadata is not allowed for this request.");
        return { handled: true };
      }
      return { handled: false, message: stripRelayControl(message) };
    }
    const threadId = getString(params, "threadId");
    if (!threadId) return { handled: false, message: stripRelayControl(message) };

    const metadata = relayControlMetadata(message.relayControl);
    if (message.relayControl !== undefined && !metadata) {
      this.sendError(client, message.id, -32602, "Invalid Relay control metadata.");
      return { handled: true };
    }
    if (metadata && (client.data.relayControlVersion !== RELAY_CONTROL_PROTOCOL_VERSION || metadata.kind !== kind)) {
      this.sendError(client, message.id, -32602, "Relay control metadata does not match the negotiated command.");
      return { handled: true };
    }

    const commandId = metadata?.commandId ?? `codex:${randomUUID()}`;
    const existing = this.commands.get(commandId);
    if (existing && (existing.threadId !== threadId || existing.kind !== kind)) {
      this.sendError(client, message.id, -32602, "Relay command id is already bound to another command.");
      return { handled: true };
    }
    const command = existing ?? this.createCommand({
      commandId,
      threadId,
      kind,
      source: metadata ? "relay" : "codex",
      originClientId: client.data.id,
      originToken: metadata?.originToken,
    });
    this.pendingByRequest.set(requestKey(client.data.id, message.id), command.commandId);
    if (!existing) this.broadcastCommand(command);
    return { handled: false, message: stripRelayControl(message) };
  }

  handleBackend(client: RelayControlClient, message: Record<string, unknown>): void {
    if (isResponse(message)) {
      const key = requestKey(client.data.id, message.id);
      const pendingSnapshot = this.pendingSnapshotsByRequest.get(key);
      if (pendingSnapshot) {
        this.pendingSnapshotsByRequest.delete(key);
        if (message.error === undefined) this.hydrateThreadSnapshot(pendingSnapshot.threadId, message.result);
      }
      const pendingMode = this.pendingModesByRequest.get(key);
      if (pendingMode) {
        this.pendingModesByRequest.delete(key);
        if (this.pendingModesByThread.get(pendingMode.threadId) === pendingMode) this.pendingModesByThread.delete(pendingMode.threadId);
        if (message.error === undefined) {
          this.setThreadMode(pendingMode.threadId, pendingMode.mode, true, pendingMode.source, pendingMode.requestedAt);
        }
      }
      const pendingStart = this.pendingTurnStartsByRequest.get(key);
      if (pendingStart) {
        this.pendingTurnStartsByRequest.delete(key);
        if (message.error !== undefined) {
          if (this.pendingTurnStartsByThread.get(pendingStart.threadId) === pendingStart) {
            this.pendingTurnStartsByThread.delete(pendingStart.threadId);
          }
        } else {
          const turnId = resultTurnId(asRecord(message.result));
          if (turnId) this.startTurn(pendingStart, turnId, asRecord(asRecord(message.result)?.turn));
        }
      }
      const pendingInterrupt = this.pendingInterruptsByRequest.get(key);
      if (pendingInterrupt) {
        this.pendingInterruptsByRequest.delete(key);
        if (message.error !== undefined) {
          if (this.pendingInterruptsByThread.get(pendingInterrupt.threadId) === pendingInterrupt) {
            this.pendingInterruptsByThread.delete(pendingInterrupt.threadId);
          }
          this.clearTurnInterrupt(pendingInterrupt);
        }
      }
      const implementationDecisionKey = this.planImplementationByRequest.get(key);
      if (implementationDecisionKey) {
        const decision = this.planDecisions.get(implementationDecisionKey);
        if (decision?.phase === "implementing") {
          if (message.error !== undefined) this.transitionPlanDecision(decision, "failed");
          else {
            const implementationTurnId = resultTurnId(asRecord(message.result));
            if (implementationTurnId) {
              decision.implementationTurnId = implementationTurnId;
              this.transitionPlanDecision(decision, "implementation_started");
            }
          }
        }
      }
      const commandId = this.pendingByRequest.get(key);
      if (!commandId) return;
      this.pendingByRequest.delete(key);
      const command = this.commands.get(commandId);
      if (!command || isTerminal(command.phase)) return;
      if (message.error !== undefined) {
        this.transition(command, "failed");
        return;
      }
      const result = asRecord(message.result);
      const turnId = resultTurnId(result);
      if ((command.kind === "review" || command.kind === "compact") && turnId) {
        command.turnId = turnId;
        const turnThreadId = (command.kind === "review" ? getString(result, "reviewThreadId") : undefined) ?? command.threadId;
        command.operationThreadId = turnThreadId;
        this.commandByTurn.set(turnKey(turnThreadId, turnId), command.commandId);
        this.transition(command, "running");
        return;
      }
      this.transition(command, "completed");
      return;
    }

    this.handleObservedNotification(client.data.id, message);
  }

  handleObserver(message: Record<string, unknown>): void {
    this.handleObservedNotification("gateway-observer", message);
  }

  private handleObservedNotification(sourceId: string, message: Record<string, unknown>): void {
    if (typeof message.method !== "string" || !this.shouldObserveNotification(sourceId, message)) return;
    const params = asRecord(message.params);
    const threadId = messageThreadId(message);
    if (!threadId) return;
    if (message.method === "thread/settings/updated") {
      const mode = getString(asRecord(asRecord(params?.threadSettings)?.collaborationMode), "mode");
      if (mode === "default" || mode === "plan") {
        const pendingMode = this.pendingModesByThread.get(threadId);
        this.setThreadMode(
          threadId,
          mode,
          true,
          pendingMode?.mode === mode ? pendingMode.source : stateSourceForId(sourceId, this.clients()),
          pendingMode?.mode === mode ? pendingMode.requestedAt : Date.now(),
        );
      }
    }
    if (message.method === "thread/status/changed") {
      this.setThreadRuntimeStatus(threadId, asRecord(params?.status));
    }
    if (message.method === "turn/started") {
      const pendingStart = this.pendingTurnStartsByThread.get(threadId);
      const turnId = resultTurnId(params);
      if (turnId) {
        const start = pendingStart && pendingStart.requestedAt >= Date.now() - PENDING_TURN_TTL_MS
          ? pendingStart
          : {
              threadId,
              mode: this.threadState(threadId).collaborationMode,
              source: stateSourceForId(sourceId, this.clients()),
              requestedAt: turnTimestamp(asRecord(params?.turn), "startedAt") ?? Date.now(),
            };
        this.startTurn(start, turnId, asRecord(params?.turn));
      }
      const command = this.latestActiveCommand(threadId, "review") ?? this.latestActiveCommand(threadId, "compact");
      if (command && turnId && !command.turnId) {
        command.turnId = turnId;
        command.operationThreadId = threadId;
        this.commandByTurn.set(turnKey(threadId, turnId), command.commandId);
        this.transition(command, "running");
      }
      if (turnId) {
        const decisions = this.planDecisionsForThread(threadId);
        const implementing = [...decisions].reverse().find((decision) => decision.phase === "implementing"
          && decision.implementationRequestKey
          && (sourceId === "gateway-observer" || decision.claimClientId === sourceId));
        if (implementing) {
          implementing.implementationTurnId = turnId;
          this.transitionPlanDecision(implementing, "implementation_started");
        }
        for (const decision of decisions) {
          if (decision.phase === "ready") this.transitionPlanDecision(decision, "expired");
        }
      }
    }
    if (message.method === "turn/completed") {
      const turnId = resultTurnId(params);
      this.completeTurn(threadId, asRecord(params?.turn));
      const command = turnId ? this.commands.get(this.commandByTurn.get(turnKey(threadId, turnId)) ?? "") : undefined;
      if (command) {
        const status = getString(asRecord(params?.turn), "status");
        this.transition(command, status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed");
      }
      return;
    }
    if (message.method === "thread/compacted") {
      const command = this.latestActiveCommand(threadId, "compact");
      if (command) this.transition(command, "completed");
      return;
    }
    const notificationKind = commandKindForNotification(message.method);
    if (notificationKind) {
      const command = this.latestActiveCommand(threadId, notificationKind);
      if (command) this.transition(command, "completed");
    }
    if (message.method === "thread/deleted") {
      this.threadStates.delete(threadId);
      this.deletePlanDecisions(threadId);
      this.pendingModesByThread.delete(threadId);
      this.modeReservationsByThread.delete(threadId);
      this.pendingTurnStartsByThread.delete(threadId);
      this.pendingInterruptsByThread.delete(threadId);
    }
  }

  handleObserverSnapshot(threadId: string, value: unknown): void {
    this.hydrateThreadSnapshot(threadId, value);
  }

  sendSnapshot(client: RelayControlClient, threadId: string): void {
    if (!this.isRelayControlClient(client) || !client.data.threads.has(threadId)) return;
    this.prune(threadId);
    const commands = (this.commandIdsByThread.get(threadId) ?? [])
      .map((id) => this.commands.get(id))
      .filter((command): command is InternalCommand => Boolean(command));
    const active = commands.filter((command) => !isTerminal(command.phase));
    const terminal = commands.filter((command) => isTerminal(command.phase)).slice(-SNAPSHOT_TERMINAL_LIMIT);
    const threadState = this.threadState(threadId);
    client.socket.send(JSON.stringify({
      method: RELAY_CONTROL_SNAPSHOT_METHOD,
      params: {
        gatewayEpoch: this.gatewayEpoch,
        threadId,
        revision: this.threadRevisions.get(threadId) ?? 0,
        consistency: "live",
        threadState,
        commands: [...active, ...terminal].map(publicCommand),
        planDecisions: this.planDecisionsForThread(threadId).map(publicPlanDecision),
      },
    }));
  }

  clientDisconnected(clientId: string): boolean {
    // Commands belong to the shared Codex process, not to a frontend socket.
    // Keep their in-memory state so the observer can finish them after Relay disconnects.
    const prefix = `${clientId}:`;
    return [...this.pendingByRequest.keys()].some((key) => key.startsWith(prefix))
      || [...this.pendingModesByRequest.keys()].some((key) => key.startsWith(prefix))
      || [...this.pendingTurnStartsByRequest.keys()].some((key) => key.startsWith(prefix))
      || [...this.pendingSnapshotsByRequest.keys()].some((key) => key.startsWith(prefix))
      || [...this.pendingInterruptsByRequest.keys()].some((key) => key.startsWith(prefix));
  }

  clientBackendClosed(clientId: string): void {
    const prefix = `${clientId}:`;
    for (const key of this.pendingByRequest.keys()) if (key.startsWith(prefix)) this.pendingByRequest.delete(key);
    for (const [key, pending] of this.pendingModesByRequest) {
      if (!key.startsWith(prefix)) continue;
      this.pendingModesByRequest.delete(key);
      if (this.pendingModesByThread.get(pending.threadId) === pending) this.pendingModesByThread.delete(pending.threadId);
    }
    for (const [key, pending] of this.pendingTurnStartsByRequest) {
      if (!key.startsWith(prefix)) continue;
      this.pendingTurnStartsByRequest.delete(key);
      if (this.pendingTurnStartsByThread.get(pending.threadId) === pending) this.pendingTurnStartsByThread.delete(pending.threadId);
    }
    for (const key of this.pendingSnapshotsByRequest.keys()) if (key.startsWith(prefix)) this.pendingSnapshotsByRequest.delete(key);
    for (const [key, pending] of this.pendingInterruptsByRequest) {
      if (!key.startsWith(prefix)) continue;
      this.pendingInterruptsByRequest.delete(key);
      if (this.pendingInterruptsByThread.get(pending.threadId) === pending) this.pendingInterruptsByThread.delete(pending.threadId);
    }
    for (const [threadId, reservation] of this.modeReservationsByThread) {
      if (reservation.clientId === clientId) this.modeReservationsByThread.delete(threadId);
    }
  }

  private handleHello(client: RelayControlClient, message: Record<string, unknown>): void {
    if (!isRequest(message) || client.data.name !== "agent-relay") {
      if (isRequest(message)) this.sendError(client, message.id, -32600, "Relay control is available only to Agent Relay clients.");
      return;
    }
    const params = asRecord(message.params);
    if (params?.version !== RELAY_CONTROL_PROTOCOL_VERSION || typeof params.instanceId !== "string" || !params.instanceId) {
      this.sendError(client, message.id, -32602, "Unsupported Relay control protocol.");
      return;
    }
    client.data.relayControlVersion = RELAY_CONTROL_PROTOCOL_VERSION;
    client.data.relayInstanceId = params.instanceId;
    client.data.relayControlAcks = new Map();
    client.socket.send(JSON.stringify({
      id: message.id,
      result: { version: RELAY_CONTROL_PROTOCOL_VERSION, gatewayEpoch: this.gatewayEpoch },
    }));
  }

  private handleThreadStateUpdate(client: RelayControlClient, message: Record<string, unknown>): void {
    if (!isRequest(message) || !this.isRelayControlClient(client)) {
      if (isRequest(message)) this.sendError(client, message.id, -32600, "Relay control is not negotiated.");
      return;
    }
    const params = asRecord(message.params);
    const threadId = getString(params, "threadId");
    const operation = getString(params, "operation");
    const requestedMode = getString(params, "mode");
    if (!threadId || !client.data.threads.has(threadId) || (operation !== "set" && operation !== "toggle")) {
      this.sendError(client, message.id, -32602, "Invalid Relay thread-state update.");
      return;
    }
    const current = this.threadState(threadId);
    const mode: AgentCollaborationMode = operation === "toggle"
      ? current.collaborationMode === "plan" ? "default" : "plan"
      : requestedMode === "plan" || requestedMode === "default" ? requestedMode : current.collaborationMode;
    if (operation === "set" && requestedMode !== "plan" && requestedMode !== "default") {
      this.sendError(client, message.id, -32602, "Relay thread-state set requires a supported mode.");
      return;
    }
    if (current.threadStatus !== "idle" || this.pendingTurnStart(threadId)) {
      this.sendModeBusyError(client, message.id, current.threadStatus === "idle" ? "active" : current.threadStatus);
      return;
    }
    const reservation = this.modeReservation(threadId);
    if (this.pendingModesByThread.has(threadId)) {
      this.sendError(client, message.id, -32000, "Another collaboration mode update is already in progress.");
      return;
    }
    if (reservation && (reservation.clientId !== client.data.id || reservation.mode !== mode)) {
      this.sendError(client, message.id, -32000, "Another collaboration mode update is already in progress.");
      return;
    }
    if (mode !== current.collaborationMode || !current.collaborationModeApplied) {
      this.modeReservationsByThread.set(threadId, { threadId, mode, clientId: client.data.id, createdAt: Date.now() });
    }
    client.socket.send(JSON.stringify({ id: message.id, result: { collaborationMode: mode } }));
  }

  private handlePlanDecisionRequest(client: RelayControlClient, message: Record<string, unknown>): void {
    if (!isRequest(message) || !this.isRelayControlClient(client)) {
      if (isRequest(message)) this.sendError(client, message.id, -32600, "Relay control is not negotiated.");
      return;
    }
    const params = asRecord(message.params);
    const threadId = getString(params, "threadId");
    const planTurnId = getString(params, "planTurnId");
    if (!threadId || !planTurnId || !client.data.threads.has(threadId)) {
      this.sendError(client, message.id, -32602, "Invalid Plan decision request.");
      return;
    }
    const key = planDecisionKey(threadId, planTurnId);
    let decision = this.planDecisions.get(key);
    if (message.method === RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD) {
      if (!decision) decision = this.createPlanDecision(threadId, planTurnId);
      client.socket.send(JSON.stringify({ id: message.id, result: publicPlanDecision(decision) }));
      return;
    }
    if (!decision) {
      this.sendError(client, message.id, -32000, "Plan decision is unavailable.");
      return;
    }
    if (message.method === RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD) {
      const action = getString(params, "action");
      if (action !== "implement" && action !== "continue") {
        this.sendError(client, message.id, -32602, "Invalid Plan decision action.");
        return;
      }
      let claimed = false;
      if (decision.phase === "ready") {
        claimed = true;
        decision.action = action;
        decision.claimClientId = client.data.id;
        decision.claimRelayInstanceId = client.data.relayInstanceId;
        this.transitionPlanDecision(decision, action === "implement" ? "implementing" : "continued");
        if (action === "implement") this.armPlanImplementationTimeout(decision);
      }
      client.socket.send(JSON.stringify({ id: message.id, result: { claimed, state: publicPlanDecision(decision) } }));
      return;
    }
    if (decision.phase === "implementing" && isPlanClaimOwner(decision, client)) {
      this.transitionPlanDecision(decision, "failed");
    }
    client.socket.send(JSON.stringify({ id: message.id, result: publicPlanDecision(decision) }));
  }

  private handleAck(client: RelayControlClient, message: Record<string, unknown>): void {
    if (!this.isRelayControlClient(client)) return;
    const params = asRecord(message.params);
    const threadId = getString(params, "threadId");
    const epoch = getString(params, "gatewayEpoch");
    const revision = params?.revision;
    if (!threadId || epoch !== this.gatewayEpoch || typeof revision !== "number" || revision < 0) return;
    const previous = client.data.relayControlAcks?.get(threadId) ?? -1;
    if (revision > previous) client.data.relayControlAcks?.set(threadId, revision);
  }

  private handleResync(client: RelayControlClient, message: Record<string, unknown>): void {
    if (!this.isRelayControlClient(client)) {
      if (isRequest(message)) this.sendError(client, message.id, -32600, "Relay control is not negotiated.");
      return;
    }
    const params = asRecord(message.params);
    const threadId = getString(params, "threadId");
    if (!threadId || !client.data.threads.has(threadId)) {
      if (isRequest(message)) this.sendError(client, message.id, -32602, "Relay thread is not subscribed.");
      return;
    }
    this.sendSnapshot(client, threadId);
    if (isRequest(message)) {
      client.socket.send(JSON.stringify({
        id: message.id,
        result: { gatewayEpoch: this.gatewayEpoch, revision: this.threadRevisions.get(threadId) ?? 0 },
      }));
    }
  }

  private setThreadMode(
    threadId: string,
    mode: AgentRelayThreadState["collaborationMode"],
    applied: boolean,
    source?: AgentRelayStateSource,
    changedAt = Date.now(),
  ): AgentRelayThreadState {
    const previous = this.threadState(threadId);
    if (mode === "default") {
      for (const decision of this.planDecisionsForThread(threadId)) {
        if (decision.phase === "ready") this.transitionPlanDecision(decision, "expired");
      }
    }
    if (previous.collaborationMode === mode && previous.collaborationModeApplied === applied) return previous;
    return this.updateThreadState(threadId, {
      collaborationMode: mode,
      collaborationModeApplied: applied,
      ...(applied && source ? { collaborationModeSource: source, collaborationModeUpdatedAt: changedAt } : {}),
    }, changedAt);
  }

  private threadState(threadId: string): AgentRelayThreadState {
    const existing = this.threadStates.get(threadId);
    if (existing) return existing;
    const state: AgentRelayThreadState = {
      threadId,
      // A fresh Gateway/app-server epoch follows native Codex restart semantics:
      // Plan is not resumed and the next turn starts in Default mode.
      collaborationMode: "default",
      collaborationModeApplied: true,
      threadStatus: "notLoaded",
      waitingOn: null,
      revision: this.threadRevisions.get(threadId) ?? 0,
      updatedAt: Date.now(),
    };
    this.threadStates.set(threadId, state);
    return state;
  }

  private updateThreadState(
    threadId: string,
    update: Partial<Omit<AgentRelayThreadState, "threadId" | "revision" | "updatedAt">>,
    updatedAt = Date.now(),
  ): AgentRelayThreadState {
    const previous = this.threadState(threadId);
    const candidate = { ...previous, ...update };
    if (sameThreadProjection(previous, candidate)) return previous;
    const state: AgentRelayThreadState = {
      ...candidate,
      threadId,
      revision: this.nextRevision(threadId),
      updatedAt,
    };
    this.threadStates.set(threadId, state);
    this.broadcastThreadState(state);
    return state;
  }

  private setThreadRuntimeStatus(threadId: string, value: Record<string, unknown> | undefined): AgentRelayThreadState {
    const status = nativeThreadStatus(value);
    if (!status) return this.threadState(threadId);
    const waitingOn = nativeWaitingOn(value);
    return this.updateThreadState(threadId, {
      threadStatus: status,
      waitingOn,
      ...(status === "active" ? {} : { activeTurn: undefined }),
    });
  }

  private startTurn(start: PendingTurnStart, turnId: string, turn: Record<string, unknown> | undefined): void {
    const pending = this.pendingTurnStartsByThread.get(start.threadId);
    if (pending === start) this.pendingTurnStartsByThread.delete(start.threadId);
    const current = this.threadState(start.threadId);
    const previousActive = current.activeTurn;
    const sameActive = previousActive?.turnId === turnId ? previousActive : undefined;
    const source = preferredSource(sameActive?.source, start.source);
    const startedAt = sameActive?.startedAt ?? turnTimestamp(turn, "startedAt") ?? start.requestedAt;
    this.setThreadMode(start.threadId, start.mode, true, start.source, start.requestedAt);
    const activeTurn: AgentRelayActiveTurnState = {
      turnId,
      collaborationMode: start.mode,
      source,
      startedAt,
      ...(sameActive?.interruptRequest ? { interruptRequest: sameActive.interruptRequest } : {}),
    };
    this.turnSources.set(turnKey(start.threadId, turnId), {
      source,
      collaborationMode: start.mode,
      startedAt,
    });
    this.updateThreadState(start.threadId, {
      threadStatus: "active",
      waitingOn: sameActive ? current.waitingOn : null,
      activeTurn,
    }, startedAt);
  }

  private requestTurnInterrupt(interrupt: PendingInterrupt): void {
    const state = this.threadState(interrupt.threadId);
    if (!state.activeTurn || (interrupt.turnId && state.activeTurn.turnId !== interrupt.turnId)) return;
    this.updateThreadState(interrupt.threadId, {
      activeTurn: {
        ...state.activeTurn,
        interruptRequest: { source: interrupt.source, requestedAt: interrupt.requestedAt },
      },
    }, interrupt.requestedAt);
  }

  private clearTurnInterrupt(interrupt: PendingInterrupt): void {
    const state = this.threadState(interrupt.threadId);
    if (!state.activeTurn?.interruptRequest
      || state.activeTurn.interruptRequest.requestedAt !== interrupt.requestedAt) return;
    const { interruptRequest: _interruptRequest, ...activeTurn } = state.activeTurn;
    this.updateThreadState(interrupt.threadId, { activeTurn });
  }

  private completeTurn(threadId: string, turn: Record<string, unknown> | undefined): void {
    const turnId = getString(turn, "id");
    const status = terminalTurnStatus(getString(turn, "status"));
    if (!turnId || !status) return;
    const state = this.threadState(threadId);
    const sourceState = this.turnSources.get(turnKey(threadId, turnId));
    const matchingActive = state.activeTurn?.turnId === turnId ? state.activeTurn : undefined;
    const previousTerminal = state.latestTurn?.turnId === turnId ? state.latestTurn : undefined;
    const pendingInterrupt = this.pendingInterruptsByThread.get(threadId);
    const matchingInterrupt = pendingInterrupt && (!pendingInterrupt.turnId || pendingInterrupt.turnId === turnId)
      ? pendingInterrupt
      : undefined;
    const finishedAt = turnTimestamp(turn, "completedAt") ?? Date.now();
    const error = turnError(turn) ?? previousTerminal?.error;
    const latestTurn: AgentRelayLatestTurnState = {
      turnId,
      status,
      source: sourceState?.source ?? matchingActive?.source ?? previousTerminal?.source ?? unknownSource(),
      ...(sourceState?.startedAt !== undefined || matchingActive?.startedAt !== undefined
        ? { startedAt: sourceState?.startedAt ?? matchingActive?.startedAt }
        : {}),
      finishedAt,
      ...(status === "interrupted" && (matchingInterrupt?.source || matchingActive?.interruptRequest?.source || previousTerminal?.interruptedBy)
        ? { interruptedBy: matchingInterrupt?.source ?? matchingActive?.interruptRequest?.source ?? previousTerminal!.interruptedBy! }
        : {}),
      ...(error ? { error } : {}),
    };
    const hasDifferentActive = Boolean(state.activeTurn && state.activeTurn.turnId !== turnId);
    const shouldReplaceLatest = !hasDifferentActive
      && (!state.latestTurn || state.latestTurn.turnId === turnId || finishedAt >= state.latestTurn.finishedAt);
    this.updateThreadState(threadId, {
      ...(matchingActive ? { activeTurn: undefined, threadStatus: "idle" as const, waitingOn: null } : {}),
      ...(shouldReplaceLatest ? { latestTurn } : {}),
    }, finishedAt);
    this.turnSources.delete(turnKey(threadId, turnId));
    if (matchingInterrupt && this.pendingInterruptsByThread.get(threadId) === matchingInterrupt) {
      this.pendingInterruptsByThread.delete(threadId);
    }
  }

  private hydrateThreadSnapshot(fallbackThreadId: string | undefined, value: unknown): void {
    const result = asRecord(value);
    const thread = asRecord(result?.thread);
    const threadId = getString(thread, "id") ?? fallbackThreadId;
    if (!threadId) return;
    const previous = this.threadState(threadId);
    const statusRecord = asRecord(thread?.status);
    const threadStatus = nativeThreadStatus(statusRecord) ?? previous.threadStatus;
    const initialTurns = Array.isArray(asRecord(result?.initialTurnsPage)?.data)
      ? asRecord(result?.initialTurnsPage)!.data as unknown[]
      : [];
    const embeddedTurns = Array.isArray(thread?.turns) ? thread.turns : [];
    const latest = asRecord(initialTurns[0] ?? embeddedTurns.at(-1));
    const latestTurnId = getString(latest, "id");
    const latestStatus = getString(latest, "status");
    let activeTurn = threadStatus === "active" ? previous.activeTurn : undefined;
    let latestTurn = latest ? previous.latestTurn : undefined;
    if (latestTurnId && latestStatus === "inProgress") {
      const existingSource = previous.activeTurn?.turnId === latestTurnId
        ? previous.activeTurn.source
        : this.turnSources.get(turnKey(threadId, latestTurnId))?.source ?? unknownSource();
      activeTurn = {
        turnId: latestTurnId,
        collaborationMode: previous.activeTurn?.turnId === latestTurnId
          ? previous.activeTurn.collaborationMode
          : previous.collaborationMode,
        source: existingSource,
        startedAt: turnTimestamp(latest, "startedAt") ?? previous.activeTurn?.startedAt ?? Date.now(),
        ...(previous.activeTurn?.turnId === latestTurnId && previous.activeTurn.interruptRequest
          ? { interruptRequest: previous.activeTurn.interruptRequest }
          : {}),
      };
      this.turnSources.set(turnKey(threadId, latestTurnId), {
        source: activeTurn.source,
        collaborationMode: activeTurn.collaborationMode,
        startedAt: activeTurn.startedAt,
      });
    } else {
      const terminalStatus = terminalTurnStatus(latestStatus);
      if (latestTurnId && terminalStatus) {
        const previousActive = previous.activeTurn?.turnId === latestTurnId ? previous.activeTurn : undefined;
        const rememberedSource = this.turnSources.get(turnKey(threadId, latestTurnId));
        latestTurn = {
          turnId: latestTurnId,
          status: terminalStatus,
          source: previous.latestTurn?.turnId === latestTurnId
            ? previous.latestTurn.source
            : previousActive?.source ?? rememberedSource?.source ?? unknownSource(),
          ...(turnTimestamp(latest, "startedAt") !== undefined || previousActive?.startedAt !== undefined || rememberedSource?.startedAt !== undefined
            ? { startedAt: turnTimestamp(latest, "startedAt") ?? previousActive?.startedAt ?? rememberedSource?.startedAt }
            : {}),
          finishedAt: turnTimestamp(latest, "completedAt") ?? previous.latestTurn?.finishedAt ?? Date.now(),
          ...(previous.latestTurn?.turnId === latestTurnId && previous.latestTurn.interruptedBy
            ? { interruptedBy: previous.latestTurn.interruptedBy }
            : terminalStatus === "interrupted" && previousActive?.interruptRequest
              ? { interruptedBy: previousActive.interruptRequest.source }
            : {}),
          ...(turnError(latest) ? { error: turnError(latest) } : {}),
        };
      }
    }
    this.updateThreadState(threadId, {
      threadStatus,
      waitingOn: nativeWaitingOn(statusRecord),
      activeTurn,
      latestTurn,
    });
  }

  private modeReservation(threadId: string): PendingModeReservation | undefined {
    const reservation = this.modeReservationsByThread.get(threadId);
    if (!reservation) return undefined;
    if (reservation.createdAt >= Date.now() - MODE_RESERVATION_TTL_MS) return reservation;
    this.modeReservationsByThread.delete(threadId);
    return undefined;
  }

  private pendingTurnStart(threadId: string): PendingTurnStart | undefined {
    const pending = this.pendingTurnStartsByThread.get(threadId);
    if (!pending) return undefined;
    if (pending.requestedAt >= Date.now() - PENDING_TURN_TTL_MS) return pending;
    this.pendingTurnStartsByThread.delete(threadId);
    return undefined;
  }

  private sendModeBusyError(client: RelayControlClient, id: string | number, status: AgentRelayThreadStatus): void {
    this.sendError(
      client,
      id,
      -32000,
      status === "active"
        ? "'/plan' is disabled while a task is in progress."
        : "Collaboration mode can only be changed while the thread is idle.",
    );
  }

  private createCommand(input: Pick<InternalCommand, "commandId" | "threadId" | "kind" | "source" | "originClientId" | "originToken">): InternalCommand {
    const now = Date.now();
    const command: InternalCommand = {
      ...input,
      phase: "accepted",
      revision: this.nextRevision(input.threadId),
      createdAt: now,
      updatedAt: now,
    };
    this.commands.set(command.commandId, command);
    const ids = this.commandIdsByThread.get(command.threadId) ?? [];
    ids.push(command.commandId);
    this.commandIdsByThread.set(command.threadId, ids);
    this.prune(command.threadId);
    return command;
  }

  private createPlanDecision(threadId: string, planTurnId: string): InternalPlanDecision {
    const now = Date.now();
    const decision: InternalPlanDecision = {
      threadId,
      planTurnId,
      phase: "ready",
      revision: this.nextRevision(threadId),
      createdAt: now,
      updatedAt: now,
    };
    this.planDecisions.set(planDecisionKey(threadId, planTurnId), decision);
    const keys = this.planDecisionKeysByThread.get(threadId) ?? [];
    keys.push(planDecisionKey(threadId, planTurnId));
    this.planDecisionKeysByThread.set(threadId, keys.slice(-100));
    this.broadcastPlanDecision(decision);
    return decision;
  }

  private bindPlanImplementationRequest(
    client: RelayControlClient,
    message: Record<string, unknown> & { id: string | number },
    params: Record<string, unknown> | undefined,
  ): void {
    const threadId = getString(params, "threadId");
    if (!threadId || client.data.relayControlVersion !== RELAY_CONTROL_PROTOCOL_VERSION) return;
    const decision = [...this.planDecisionsForThread(threadId)].reverse().find((candidate) => candidate.phase === "implementing"
      && isPlanClaimOwner(candidate, client)
      && !candidate.implementationRequestKey);
    if (!decision) return;
    decision.claimClientId = client.data.id;
    const key = requestKey(client.data.id, message.id);
    decision.implementationRequestKey = key;
    this.planImplementationByRequest.set(key, planDecisionKey(decision.threadId, decision.planTurnId));
  }

  private transitionPlanDecision(decision: InternalPlanDecision, phase: AgentRelayPlanDecisionPhase): void {
    if (isPlanDecisionTerminal(decision.phase)) return;
    if (decision.implementationTimer) {
      clearTimeout(decision.implementationTimer);
      decision.implementationTimer = undefined;
    }
    if (isPlanDecisionTerminal(phase) && decision.implementationRequestKey) {
      this.planImplementationByRequest.delete(decision.implementationRequestKey);
      decision.implementationRequestKey = undefined;
    }
    decision.phase = phase;
    decision.revision = this.nextRevision(decision.threadId);
    decision.updatedAt = Date.now();
    this.broadcastPlanDecision(decision);
  }

  private armPlanImplementationTimeout(decision: InternalPlanDecision): void {
    decision.implementationTimer = setTimeout(() => {
      decision.implementationTimer = undefined;
      if (decision.phase === "implementing") this.transitionPlanDecision(decision, "failed");
    }, PLAN_IMPLEMENT_START_TIMEOUT_MS);
    decision.implementationTimer.unref();
  }

  private planDecisionsForThread(threadId: string): InternalPlanDecision[] {
    return (this.planDecisionKeysByThread.get(threadId) ?? [])
      .map((key) => this.planDecisions.get(key))
      .filter((decision): decision is InternalPlanDecision => Boolean(decision));
  }

  private deletePlanDecisions(threadId: string): void {
    for (const key of this.planDecisionKeysByThread.get(threadId) ?? []) {
      const decision = this.planDecisions.get(key);
      if (decision?.implementationTimer) clearTimeout(decision.implementationTimer);
      if (decision?.implementationRequestKey) this.planImplementationByRequest.delete(decision.implementationRequestKey);
      this.planDecisions.delete(key);
    }
    this.planDecisionKeysByThread.delete(threadId);
  }

  private transition(command: InternalCommand, phase: AgentRelayCommandPhase): void {
    if (isTerminal(command.phase)) return;
    command.phase = phase;
    this.touch(command);
    this.broadcastCommand(command);
  }

  private touch(command: InternalCommand): void {
    command.revision = this.nextRevision(command.threadId);
    command.updatedAt = Date.now();
  }

  private broadcastCommand(command: InternalCommand): void {
    const notification = JSON.stringify({
      method: RELAY_CONTROL_COMMAND_METHOD,
      params: {
        gatewayEpoch: this.gatewayEpoch,
        threadRevision: command.revision,
        ...publicCommand(command),
        ...(command.originToken ? { originToken: command.originToken } : {}),
      },
    });
    for (const client of this.clients()) {
      if (this.isRelayControlClient(client) && client.data.threads.has(command.threadId)) client.socket.send(notification);
    }
  }

  private broadcastThreadState(state: AgentRelayThreadState): void {
    const notification = JSON.stringify({
      method: RELAY_CONTROL_THREAD_STATE_METHOD,
      params: { gatewayEpoch: this.gatewayEpoch, threadRevision: state.revision, ...state },
    });
    for (const client of this.clients()) {
      if (this.isRelayControlClient(client) && client.data.threads.has(state.threadId)) client.socket.send(notification);
    }
  }

  private broadcastPlanDecision(decision: InternalPlanDecision): void {
    const notification = JSON.stringify({
      method: RELAY_CONTROL_PLAN_DECISION_METHOD,
      params: {
        gatewayEpoch: this.gatewayEpoch,
        threadRevision: decision.revision,
        ...publicPlanDecision(decision),
      },
    });
    for (const client of this.clients()) {
      if (this.isRelayControlClient(client) && client.data.threads.has(decision.threadId)) client.socket.send(notification);
    }
  }

  private latestActiveCommand(threadId: string, kind: AgentRelayCommandKind): InternalCommand | undefined {
    const ids = this.commandIdsByThread.get(threadId) ?? [];
    for (let index = ids.length - 1; index >= 0; index--) {
      const command = this.commands.get(ids[index]!);
      if (command?.kind === kind && !isTerminal(command.phase)) return command;
    }
    return undefined;
  }

  private nextRevision(threadId: string): number {
    const revision = (this.threadRevisions.get(threadId) ?? 0) + 1;
    this.threadRevisions.set(threadId, revision);
    return revision;
  }

  private prune(threadId: string, now = Date.now()): void {
    const ids = this.commandIdsByThread.get(threadId) ?? [];
    const active: string[] = [];
    const terminal: string[] = [];
    for (const id of ids) {
      const command = this.commands.get(id);
      if (!command) continue;
      if (!isTerminal(command.phase) && command.updatedAt >= now - ACTIVE_TTL_MS) active.push(id);
      else if (command.updatedAt >= now - TERMINAL_TTL_MS) terminal.push(id);
      else this.deleteCommand(command);
    }
    for (const id of active.slice(0, -ACTIVE_LIMIT_PER_THREAD)) {
      const command = this.commands.get(id);
      if (command) this.deleteCommand(command);
    }
    const keptActive = active.slice(-ACTIVE_LIMIT_PER_THREAD);
    const keptTerminal = terminal.slice(-TERMINAL_LIMIT_PER_THREAD);
    for (const id of terminal.slice(0, -TERMINAL_LIMIT_PER_THREAD)) {
      const command = this.commands.get(id);
      if (command) this.deleteCommand(command);
    }
    const kept = [...keptActive, ...keptTerminal];
    const decisionKeys = this.planDecisionKeysByThread.get(threadId) ?? [];
    const keptDecisions: string[] = [];
    for (const key of decisionKeys) {
      const decision = this.planDecisions.get(key);
      if (!decision) continue;
      const ttl = isPlanDecisionTerminal(decision.phase) ? TERMINAL_TTL_MS : ACTIVE_TTL_MS;
      if (decision.updatedAt >= now - ttl) keptDecisions.push(key);
      else {
        if (decision.implementationTimer) clearTimeout(decision.implementationTimer);
        if (decision.implementationRequestKey) this.planImplementationByRequest.delete(decision.implementationRequestKey);
        this.planDecisions.delete(key);
      }
    }
    if (keptDecisions.length > 0) this.planDecisionKeysByThread.set(threadId, keptDecisions.slice(-100));
    else this.planDecisionKeysByThread.delete(threadId);
    if (kept.length > 0 || keptDecisions.length > 0 || this.threadStates.has(threadId)) this.commandIdsByThread.set(threadId, kept);
    else {
      this.commandIdsByThread.delete(threadId);
      this.threadRevisions.delete(threadId);
    }
  }

  private pruneAll(now = Date.now()): void {
    const threadIds = new Set([...this.commandIdsByThread.keys(), ...this.planDecisionKeysByThread.keys()]);
    for (const threadId of threadIds) this.prune(threadId, now);
  }

  private deleteCommand(command: InternalCommand): void {
    this.commands.delete(command.commandId);
    for (const [key, commandId] of this.pendingByRequest) if (commandId === command.commandId) this.pendingByRequest.delete(key);
    if (command.turnId) this.commandByTurn.delete(turnKey(command.operationThreadId ?? command.threadId, command.turnId));
  }

  private shouldObserveNotification(clientId: string, message: Record<string, unknown>, now = Date.now()): boolean {
    const key = JSON.stringify(message);
    const recent = this.recentNotifications.get(key);
    this.recentNotifications.set(key, { clientId, observedAt: now });
    for (const [payload, value] of this.recentNotifications) {
      if (now - value.observedAt > 1_000) this.recentNotifications.delete(payload);
    }
    return !recent || recent.clientId === clientId || now - recent.observedAt > 1_000;
  }

  private isRelayControlClient(client: RelayControlClient): boolean {
    return client.data.name === "agent-relay" && client.data.relayControlVersion === RELAY_CONTROL_PROTOCOL_VERSION;
  }

  private sendError(client: RelayControlClient, id: string | number, code: number, message: string): void {
    client.socket.send(JSON.stringify({ id, error: { code, message } }));
  }
}

function commandKind(method: string, _params: Record<string, unknown> | undefined): AgentRelayCommandKind | undefined {
  switch (method) {
    case "review/start": return "review";
    case "thread/compact/start": return "compact";
    case "thread/name/set": return "rename";
    case "thread/goal/set": return "goal_update";
    case "thread/goal/clear": return "goal_clear";
    case "thread/archive": return "archive";
    case "thread/delete": return "delete";
    case "thread/backgroundTerminals/clean": return "terminals_clean";
    case "thread/backgroundTerminals/terminate": return "terminal_stop";
    case "thread/fork": return undefined;
    default: return undefined;
  }
}

function commandKindForNotification(method: string): AgentRelayCommandKind | undefined {
  switch (method) {
    case "thread/name/updated": return "rename";
    case "thread/goal/updated": return "goal_update";
    case "thread/goal/cleared": return "goal_clear";
    case "thread/archived": return "archive";
    case "thread/deleted": return "delete";
    default: return undefined;
  }
}

function relayControlMetadata(value: unknown): AgentRelayCommandMetadata | undefined {
  const record = asRecord(value);
  const kind = getString(record, "kind");
  if (
    record?.version !== RELAY_CONTROL_PROTOCOL_VERSION
    || typeof record.commandId !== "string" || !record.commandId || record.commandId.length > 200
    || typeof record.originToken !== "string" || !record.originToken || record.originToken.length > 200
    || !isCommandKind(kind)
  ) return undefined;
  return { version: RELAY_CONTROL_PROTOCOL_VERSION, commandId: record.commandId, kind, originToken: record.originToken };
}

function isCommandKind(value: string | undefined): value is AgentRelayCommandKind {
  return value === "review" || value === "compact" || value === "rename"
    || value === "goal_update" || value === "goal_clear" || value === "archive" || value === "delete"
    || value === "terminals_clean" || value === "terminal_stop";
}

function stripRelayControl(message: Record<string, unknown>): Record<string, unknown> {
  if (!("relayControl" in message)) return message;
  const { relayControl: _relayControl, ...stripped } = message;
  return stripped;
}

function publicCommand(command: InternalCommand): AgentRelayCommandState {
  return {
    commandId: command.commandId,
    threadId: command.threadId,
    kind: command.kind,
    phase: command.phase,
    source: command.source,
    revision: command.revision,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    ...(command.turnId ? { turnId: command.turnId } : {}),
    ...(command.operationThreadId ? { operationThreadId: command.operationThreadId } : {}),
  };
}

function publicPlanDecision(decision: InternalPlanDecision): AgentRelayPlanDecisionState {
  return {
    threadId: decision.threadId,
    planTurnId: decision.planTurnId,
    phase: decision.phase,
    ...(decision.action ? { action: decision.action } : {}),
    ...(decision.implementationTurnId ? { implementationTurnId: decision.implementationTurnId } : {}),
    revision: decision.revision,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
  };
}

function sameThreadProjection(left: AgentRelayThreadState, right: AgentRelayThreadState): boolean {
  const { revision: _leftRevision, updatedAt: _leftUpdatedAt, ...leftProjection } = left;
  const { revision: _rightRevision, updatedAt: _rightUpdatedAt, ...rightProjection } = right;
  return JSON.stringify(leftProjection) === JSON.stringify(rightProjection);
}

function stateSource(name: string | undefined): AgentRelayStateSource {
  const normalized = name?.trim().toLocaleLowerCase() ?? "";
  if (normalized === "agent-relay") return { kind: "relay", label: "Agent Relay" };
  if (normalized.includes("observer")) return { kind: "system", label: "Gateway observer" };
  if (normalized.includes("desktop")) return { kind: "codexDesktop", label: "Codex Desktop" };
  if (normalized.includes("codex") || normalized.includes("cli") || normalized.includes("tui")) {
    return { kind: "codexCli", label: "Codex CLI" };
  }
  if (name?.trim()) return { kind: "unknown", label: name.trim().slice(0, 80) };
  return unknownSource();
}

function stateSourceForId(sourceId: string, clients: Iterable<RelayControlClient>): AgentRelayStateSource {
  if (sourceId === "gateway-observer") return { kind: "system", label: "Gateway observer" };
  for (const client of clients) {
    if (client.data.id === sourceId) return stateSource(client.data.name);
  }
  return unknownSource();
}

function unknownSource(): AgentRelayStateSource {
  return { kind: "unknown", label: "Unknown client" };
}

function preferredSource(
  current: AgentRelayStateSource | undefined,
  candidate: AgentRelayStateSource,
): AgentRelayStateSource {
  if (!current) return candidate;
  const rank = (source: AgentRelayStateSource): number => source.kind === "system" ? 0 : source.kind === "unknown" ? 1 : 2;
  return rank(candidate) > rank(current) ? candidate : current;
}

function nativeThreadStatus(value: Record<string, unknown> | undefined): AgentRelayThreadStatus | undefined {
  const status = getString(value, "type");
  return status === "notLoaded" || status === "idle" || status === "active" || status === "systemError"
    ? status
    : undefined;
}

function nativeWaitingOn(value: Record<string, unknown> | undefined): AgentRelayWaitingOn {
  if (nativeThreadStatus(value) !== "active") return null;
  const flags = Array.isArray(value?.activeFlags) ? value.activeFlags : [];
  if (flags.includes("waitingOnApproval")) return "approval";
  if (flags.includes("waitingOnUserInput")) return "userInput";
  return null;
}

function terminalTurnStatus(value: string | undefined): AgentRelayLatestTurnState["status"] | undefined {
  return value === "completed" || value === "failed" || value === "interrupted" ? value : undefined;
}

function turnTimestamp(turn: Record<string, unknown> | undefined, key: "startedAt" | "completedAt"): number | undefined {
  const value = turn?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 1_000_000_000_000 ? value : value * 1_000;
}

function turnError(turn: Record<string, unknown> | undefined): string | undefined {
  const error = asRecord(turn?.error);
  const message = getString(error, "message");
  return message?.trim() ? message.trim().slice(0, 1_000) : undefined;
}

function explicitCollaborationMode(
  params: Record<string, unknown> | undefined,
): Pick<PendingModeUpdate, "threadId" | "mode"> | undefined {
  const threadId = getString(params, "threadId");
  const mode = getString(asRecord(params?.collaborationMode), "mode");
  return threadId && (mode === "default" || mode === "plan") ? { threadId, mode } : undefined;
}

function resultTurnId(record: Record<string, unknown> | undefined): string | undefined {
  return getString(asRecord(record?.turn), "id") ?? getString(record, "turnId");
}

function requestKey(clientId: string, id: string | number): string {
  return `${clientId}:${typeof id}:${String(id)}`;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}

function planDecisionKey(threadId: string, planTurnId: string): string {
  return `${threadId}\0${planTurnId}`;
}

function isRequest(message: Record<string, unknown>): message is Record<string, unknown> & { id: string | number; method: string } {
  return (typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string";
}

function isResponse(message: Record<string, unknown>): message is Record<string, unknown> & { id: string | number } {
  return (typeof message.id === "string" || typeof message.id === "number") && !("method" in message) && ("result" in message || "error" in message);
}

function isTerminal(phase: AgentRelayCommandPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

function isPlanDecisionTerminal(phase: AgentRelayPlanDecisionPhase): boolean {
  return phase === "implementation_started" || phase === "continued" || phase === "failed" || phase === "expired";
}

function isPlanClaimOwner(decision: InternalPlanDecision, client: RelayControlClient): boolean {
  if (decision.claimRelayInstanceId && client.data.relayInstanceId) {
    return decision.claimRelayInstanceId === client.data.relayInstanceId;
  }
  return decision.claimClientId === client.data.id;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
