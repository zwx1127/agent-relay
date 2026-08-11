import type { AgentOutputEvent, AgentTurnError, AgentTurnStatus } from "./events.ts";
import type { AgentTaskInput } from "./input.ts";

export interface AgentSideConversationSession {
  threadId: string;
}

export interface AgentSideConversationOpenOptions {
  /** Session identity used only for emitted child-thread events. */
  eventSessionKey?: string;
  onEvent?(event: AgentOutputEvent): void | Promise<void>;
}

export interface AgentSideConversationSendResult {
  turnId?: string;
  steered: boolean;
}

export interface AgentSideConversationResult {
  message: string;
  status: Exclude<AgentTurnStatus, "inProgress">;
  threadId?: string;
  turnId?: string;
  error?: AgentTurnError;
}

export interface AgentSideConversationInput extends AgentTaskInput {}
