import type { AgentCollaborationMode } from "./input.ts";

export const RELAY_CONTROL_PROTOCOL_VERSION = 5;
export const RELAY_CONTROL_HELLO_METHOD = "agent-relay/control/hello";
export const RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD = "agent-relay/control/threadState/update";
export const RELAY_CONTROL_COMMAND_METHOD = "agent-relay/control/command";
export const RELAY_CONTROL_THREAD_STATE_METHOD = "agent-relay/control/threadState";
export const RELAY_CONTROL_SNAPSHOT_METHOD = "agent-relay/control/snapshot";
export const RELAY_CONTROL_ACK_METHOD = "agent-relay/control/ack";
export const RELAY_CONTROL_RESYNC_METHOD = "agent-relay/control/resync";
export const RELAY_CONTROL_PLAN_DECISION_METHOD = "agent-relay/control/planDecision";
export const RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD = "agent-relay/control/planDecision/register";
export const RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD = "agent-relay/control/planDecision/claim";
export const RELAY_CONTROL_PLAN_DECISION_FAIL_METHOD = "agent-relay/control/planDecision/fail";

export type AgentRelayCommandKind =
  | "review"
  | "compact"
  | "rename"
  | "goal_update"
  | "goal_clear"
  | "archive"
  | "delete"
  | "terminals_clean"
  | "terminal_stop";

export type AgentRelayCommandPhase = "accepted" | "running" | "completed" | "failed" | "interrupted";

export interface AgentRelayCommandState {
  commandId: string;
  threadId: string;
  kind: AgentRelayCommandKind;
  phase: AgentRelayCommandPhase;
  source: "relay" | "codex";
  revision: number;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  operationThreadId?: string;
}

export type AgentRelayPlanDecisionPhase =
  | "ready"
  | "implementing"
  | "implementation_started"
  | "continued"
  | "failed"
  | "expired";

export interface AgentRelayPlanDecisionState {
  threadId: string;
  planTurnId: string;
  phase: AgentRelayPlanDecisionPhase;
  action?: "implement" | "continue";
  implementationTurnId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRelayPlanDecisionClaimResult {
  claimed: boolean;
  state: AgentRelayPlanDecisionState;
}

export type AgentRelayStateSourceKind = "relay" | "codexCli" | "codexDesktop" | "system" | "unknown";

export interface AgentRelayStateSource {
  kind: AgentRelayStateSourceKind;
  label: string;
}

export type AgentRelayThreadStatus = "notLoaded" | "idle" | "active" | "systemError";
export type AgentRelayWaitingOn = "approval" | "userInput" | null;

export interface AgentRelayInterruptRequest {
  source: AgentRelayStateSource;
  requestedAt: number;
}

export interface AgentRelayActiveTurnState {
  turnId: string;
  collaborationMode: AgentCollaborationMode;
  source: AgentRelayStateSource;
  startedAt: number;
  interruptRequest?: AgentRelayInterruptRequest;
}

export interface AgentRelayLatestTurnState {
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  source: AgentRelayStateSource;
  startedAt?: number;
  finishedAt: number;
  interruptedBy?: AgentRelayStateSource;
  error?: string;
}

export interface AgentRelayThreadState {
  threadId: string;
  collaborationMode: AgentCollaborationMode;
  collaborationModeApplied: boolean;
  collaborationModeSource?: AgentRelayStateSource;
  collaborationModeUpdatedAt?: number;
  threadStatus: AgentRelayThreadStatus;
  waitingOn: AgentRelayWaitingOn;
  activeTurn?: AgentRelayActiveTurnState;
  latestTurn?: AgentRelayLatestTurnState;
  revision: number;
  updatedAt: number;
}

export interface AgentRelayCommandMetadata {
  version: 5;
  commandId: string;
  kind: AgentRelayCommandKind;
  originToken: string;
}

export interface AgentRelayControlEnvelope {
  gatewayEpoch: string;
  threadRevision: number;
}

export interface AgentRelayThreadStateUpdate {
  operation: "set" | "toggle";
  mode?: AgentCollaborationMode;
}
