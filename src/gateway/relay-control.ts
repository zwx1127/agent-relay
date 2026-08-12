import { randomUUID } from "node:crypto";
import type {
  AgentCollaborationMode,
  AgentRelayCommandKind,
  AgentRelayCommandMetadata,
  AgentRelayCommandPhase,
  AgentRelayCommandState,
  AgentRelayPlanDecisionPhase,
  AgentRelayPlanDecisionState,
  AgentRelayThreadState,
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
}

interface PendingModeStart extends PendingModeUpdate {
  createdAt: number;
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
  private readonly pendingModeStartsByThread = new Map<string, PendingModeStart>();
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

    const explicitMode = explicitCollaborationMode(params);
    if (explicitMode && isRequest(message)) {
      this.pendingModesByRequest.set(requestKey(client.data.id, message.id), { threadId: explicitMode.threadId, mode: explicitMode.mode });
      if (method === "turn/start") this.pendingModeStartsByThread.set(explicitMode.threadId, { ...explicitMode, createdAt: Date.now() });
      this.setThreadMode(explicitMode.threadId, explicitMode.mode, false);
    }
    if (method === "turn/start" && isRequest(message)) this.bindPlanImplementationRequest(client, message, params);

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
      const pendingMode = this.pendingModesByRequest.get(key);
      if (pendingMode) {
        this.pendingModesByRequest.delete(key);
        if (message.error === undefined) this.setThreadMode(pendingMode.threadId, pendingMode.mode, true);
        this.pendingModeStartsByThread.delete(pendingMode.threadId);
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
      if (mode === "default" || mode === "plan") this.setThreadMode(threadId, mode, true);
    }
    if (message.method === "turn/started") {
      const pendingMode = this.pendingModeStartsByThread.get(threadId);
      if (pendingMode && pendingMode.createdAt >= Date.now() - 30_000) {
        this.pendingModeStartsByThread.delete(threadId);
        this.setThreadMode(threadId, pendingMode.mode, true);
      }
      const turnId = resultTurnId(params);
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
      const command = turnId ? this.commands.get(this.commandByTurn.get(turnKey(threadId, turnId)) ?? "") : undefined;
      if (!command) return;
      const status = getString(asRecord(params?.turn), "status");
      this.transition(command, status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed");
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
    }
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
      || [...this.pendingModesByRequest.keys()].some((key) => key.startsWith(prefix));
  }

  clientBackendClosed(clientId: string): void {
    const prefix = `${clientId}:`;
    for (const key of this.pendingByRequest.keys()) if (key.startsWith(prefix)) this.pendingByRequest.delete(key);
    for (const key of this.pendingModesByRequest.keys()) if (key.startsWith(prefix)) this.pendingModesByRequest.delete(key);
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
    const state = this.setThreadMode(threadId, mode, false);
    client.socket.send(JSON.stringify({ id: message.id, result: state }));
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

  private setThreadMode(threadId: string, mode: AgentRelayThreadState["collaborationMode"], applied: boolean): AgentRelayThreadState {
    const previous = this.threadState(threadId);
    if (mode === "default") {
      for (const decision of this.planDecisionsForThread(threadId)) {
        if (decision.phase === "ready") this.transitionPlanDecision(decision, "expired");
      }
    }
    if (previous.collaborationMode === mode && previous.collaborationModeApplied === applied) return previous;
    const state: AgentRelayThreadState = {
      threadId,
      collaborationMode: mode,
      collaborationModeApplied: applied,
      revision: this.nextRevision(threadId),
      updatedAt: Date.now(),
    };
    this.threadStates.set(threadId, state);
    this.broadcastThreadState(state);
    return state;
  }

  private threadState(threadId: string): AgentRelayThreadState {
    return this.threadStates.get(threadId) ?? {
      threadId,
      // A fresh Gateway/app-server epoch follows native Codex restart semantics:
      // Plan is not resumed and the next turn starts in Default mode.
      collaborationMode: "default",
      collaborationModeApplied: true,
      revision: this.threadRevisions.get(threadId) ?? 0,
      updatedAt: Date.now(),
    };
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

function explicitCollaborationMode(params: Record<string, unknown> | undefined): PendingModeUpdate | undefined {
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
