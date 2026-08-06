import type { ConversationId } from "../domain/ids.ts";
import type { AgentSessionStatus } from "../ports/agent.ts";
import type { RelayStore } from "../storage/store.ts";

const ACTIVE_TASK_STATUSES = ["waiting", "queued", "running", "blocked"] as const;

export function isAgentSessionBusy(status: AgentSessionStatus | undefined): boolean {
  return Boolean(status?.activeTurnId || status?.waitingForApproval || status?.waitingForUserInput);
}

export function hasBusyWorkspaceWork(
  store: Pick<RelayStore, "countTasks">,
  scopeKey: ConversationId,
  workspaceName: string,
  status: AgentSessionStatus | undefined,
): boolean {
  return isAgentSessionBusy(status)
    || store.countTasks(scopeKey, workspaceName, [...ACTIVE_TASK_STATUSES]) > 0;
}
