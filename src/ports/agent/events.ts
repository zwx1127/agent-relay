import type { AgentTaskInput } from "./input.ts";
import type { AgentThreadGoal } from "./thread.ts";
import type { AgentRelayCommandContent, AgentRelayCommandState, AgentRelayThreadState } from "./control.ts";

export type AgentOutputHandler = (event: AgentOutputEvent) => void | Promise<void>;
export type AgentExitHandler = (event: AgentExitEvent) => void | Promise<void>;

export type AgentOutputEvent =
  | AgentMessageOutputEvent
  | AgentImageOutputEvent
  | AgentActivityEvent
  | AgentTurnStalledEvent
  | AgentTurnProgressedEvent
  | AgentTurnCompletedEvent
  | AgentUserInputRequestEvent
  | AgentApprovalRequestEvent
  | AgentMcpElicitationRequestEvent
  | AgentServerRequestResolvedEvent
  | AgentUserMessageEvent
  | AgentRelayCommandStateEvent
  | AgentRelayThreadStateEvent
  | AgentRelayControlSnapshotEvent
  | AgentThreadLifecycleEvent;

export interface AgentRelayCommandStateEvent extends AgentRelayCommandState {
  type: "relay_command_state";
  sessionKey: string;
  gatewayEpoch: string;
  threadRevision: number;
  content?: AgentRelayCommandContent;
}

export interface AgentRelayThreadStateEvent extends AgentRelayThreadState {
  type: "relay_thread_state";
  sessionKey: string;
  gatewayEpoch: string;
  threadRevision: number;
}

export interface AgentRelayControlSnapshotEvent {
  type: "relay_control_snapshot";
  sessionKey: string;
  threadId: string;
  gatewayEpoch: string;
  revision: number;
  consistency: "live";
  threadState: AgentRelayThreadState;
  commands: AgentRelayCommandState[];
}

export interface AgentUserMessageEvent {
  type: "user_message";
  sessionKey: string;
  input: AgentTaskInput;
  threadId: string;
  turnId?: string;
  itemId?: string;
  clientUserMessageId?: string;
}

export interface AgentServerRequestResolvedEvent {
  type: "server_request_resolved";
  sessionKey: string;
  requestId: string | number;
}

/**
 * Streaming text output from an agent turn.
 *
 * `type` is optional for compatibility with older Codex app-server message
 * notifications that only carried a chunk payload.
 */
export interface AgentMessageOutputEvent {
  type?: "message";
  sessionKey: string;
  chunk: string;
  turnId?: string;
  itemId?: string;
}

export interface AgentImageOutputEvent {
  type: "image";
  sessionKey: string;
  path?: string;
  data?: string;
  mimeType?: string;
  caption?: string;
  turnId?: string;
  itemId?: string;
}

export interface AgentTurnCompletedEvent {
  type: "turn_completed";
  sessionKey: string;
  turnId?: string;
  /** Optional only for compatibility with older provider test doubles. */
  status?: AgentTurnStatus;
  error?: AgentTurnError;
  durationMs?: number;
}

export interface AgentTurnStalledEvent {
  type: "turn_stalled";
  sessionKey: string;
  threadId: string;
  turnId: string;
  detail: string;
}

export interface AgentTurnProgressedEvent {
  type: "turn_progressed";
  sessionKey: string;
  threadId: string;
  turnId: string;
}

export interface AgentActivityEvent {
  type: "activity";
  sessionKey: string;
  activity: AgentActivity;
  /** Thread identity captured when the provider emitted the activity. */
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

export type AgentActivity =
  | { kind: "reasoning"; summary: string; sectionIndex?: number }
  | { kind: "plan"; explanation?: string; steps: AgentPlanStep[] }
  | { kind: "diff"; diff: string }
  | {
      kind: "item";
      category: AgentActivityCategory;
      label: string;
      status: AgentActivityStatus;
      detail?: string;
      durationMs?: number;
      files?: AgentActivityFile[];
    }
  | { kind: "notice"; level: "info" | "warning" | "error"; title: string; detail?: string }
  | { kind: "goal"; goal: AgentThreadGoal | null }
  | { kind: "settings"; changes: Record<string, string> };

export type AgentActivityCategory =
  | "command"
  | "fileChange"
  | "mcp"
  | "webSearch"
  | "collaboration"
  | "image"
  | "compaction"
  | "review"
  | "hook"
  | "guardian"
  | "model"
  | "other";

export type AgentActivityStatus = "started" | "inProgress" | "completed" | "failed" | "declined" | "interrupted" | "warning";

export interface AgentActivityFile {
  path: string;
  kind?: string;
}

export interface AgentPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export type AgentTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface AgentTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string;
}

export interface AgentUserInputOption {
  label: string;
  description: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  /** Secret answers should be collected through provider flows that do not echo the value. */
  isSecret?: boolean;
  /** Allows the user to provide free text instead of choosing one of `options`. */
  isOther?: boolean;
  options?: AgentUserInputOption[] | null;
}

export interface AgentUserInputRequestEvent {
  type: "user_input_request";
  sessionKey: string;
  requestId: string | number;
  questions: AgentUserInputQuestion[];
  turnId?: string;
  itemId?: string;
}

export type AgentApprovalKind =
  | "command"
  | "file_change"
  | "permissions"
  | "legacy_command"
  | "legacy_patch";

export interface AgentApprovalRequestEvent {
  type: "approval_request";
  sessionKey: string;
  requestId: string | number;
  /** Raw provider method name, retained so adapters can support new approval methods before a type is added. */
  method: string;
  approvalKind: AgentApprovalKind;
  title: string;
  body: string;
  params: unknown;
  turnId?: string;
  itemId?: string;
}

export interface AgentMcpElicitationRequestEvent {
  type: "mcp_elicitation_request";
  sessionKey: string;
  requestId: string | number;
  serverName: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: AgentMcpElicitationSchema;
  url?: string;
  elicitationId?: string;
  meta?: unknown;
  turnId?: string;
}

export interface AgentMcpElicitationSchema {
  type: "object";
  properties: Record<string, AgentMcpElicitationFieldSchema>;
  required?: string[];
}

export type AgentMcpElicitationFieldSchema = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: "email" | "uri" | "date" | "date-time";
  enum?: unknown[];
  enumNames?: string[];
  items?: { type?: string; enum?: unknown[] };
  minItems?: number;
  maxItems?: number;
};

export interface AgentThreadLifecycleEvent {
  type: "thread_lifecycle";
  sessionKey: string;
  threadId: string;
  action: "archived" | "deleted" | "closed";
  initiatedByClient?: boolean;
}

export interface AgentExitEvent {
  sessionKey: string;
  exitCode: number | null;
  signalCode: string | null;
}
