import type { ConversationId } from "../../domain/ids.ts";
import type { AgentActivity, AgentTurnError, AgentTurnStatus } from "./events.ts";
import type { AgentThreadGoal, AgentTokenUsage } from "./thread.ts";

export interface AgentTurnActivitySnapshot {
  itemId?: string;
  activity: AgentActivity;
}

/** Provider-neutral summary of the latest turn returned while resuming a thread. */
export interface AgentTurnSnapshot {
  id: string;
  status: AgentTurnStatus;
  activities: AgentTurnActivitySnapshot[];
  /** Unix timestamp in milliseconds. */
  startedAt?: number;
  /** Unix timestamp in milliseconds. */
  completedAt?: number;
  durationMs?: number;
  error?: AgentTurnError;
}

export interface AgentSessionStatus {
  sessionKey: string;
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  workspacePath: string;
  running: boolean;
  startedAt: number;
  /** Agent-native thread id used for resume, fork, and side-conversation flows. */
  threadId?: string;
  threadName?: string;
  threadStatus?: string;
  /** Present while the provider believes subsequent input should steer an in-flight turn. */
  activeTurnId?: string;
  /** Latest provider-normalized turn snapshot, used to hydrate resume presentation. */
  latestTurn?: AgentTurnSnapshot;
  /** App-server hint that the thread can accept direct input while it is active. */
  canAcceptDirectInput?: boolean;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: string;
  instructionSources?: string[];
  tokenUsage?: AgentTokenUsage;
  contextWindow?: number;
  /** These flags block normal prompt submission until the user answers or interrupts. */
  waitingForUserInput?: boolean;
  waitingForApproval?: boolean;
  recentWarning?: string;
  recentError?: string;
  appServerVersion?: string;
  reviewInProgress?: boolean;
  threadGoal?: AgentThreadGoal | null;
  /** Gateway-only collaboration state projected from the current Gateway epoch. */
  collaborationMode?: "default" | "plan";
  collaborationModeApplied?: boolean;
  relayStateConsistency?: "live" | "resyncing";
}

export interface StartAgentOptions {
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  workspacePath: string;
  threadId?: string;
}
