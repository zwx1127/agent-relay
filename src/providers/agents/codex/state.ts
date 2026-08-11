import type { AgentOutputEvent, AgentSessionStatus } from "../../../ports/agent.ts";
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
  ownerSessionKey: string;
  sessionKey: string;
  threadId: string;
  activeTurnId?: string;
  terminalTurnIds: Set<string>;
  onEvent?(event: AgentOutputEvent): void | Promise<void>;
}

export function clearRecentError(running: RunningSession): void {
  running.status.recentError = undefined;
}
