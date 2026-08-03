import type { AgentSessionStatus, AgentSideConversationResult } from "../../../ports/agent.ts";
import { BackgroundTerminalTracker } from "./background-terminals.ts";

export interface RunningSession {
  status: AgentSessionStatus;
  backgroundTerminals: BackgroundTerminalTracker;
  reviewTurnId?: string;
}

export interface PendingGlobalNotice {
  level: "warning" | "error";
  title: string;
  detail?: string;
}

export interface SideConversationCollector {
  threadId: string;
  text: string;
  turnId?: string;
  resolve(result: AgentSideConversationResult): void;
  reject(error: Error): void;
}

export function clearRecentError(running: RunningSession): void {
  running.status.recentError = undefined;
}
