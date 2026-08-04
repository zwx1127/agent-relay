import type { AgentThreadGoal } from "../ports/agent.ts";

export type ActivityControlAction = "interrupt" | "pause" | "resume" | "edit" | "clear";

export interface ActivityControlPayload {
  command: "activity";
  token: string;
  actions: ActivityControlAction[];
  sessionKey: string;
  threadId?: string;
  turnId?: string;
  generation?: number;
  phase?: string;
  goalCreatedAt?: number;
  goalUpdatedAt?: number;
  goalStatus?: AgentThreadGoal["status"];
}

export function activityControlActions(
  goal: AgentThreadGoal | null | undefined,
  cancellableTurn: boolean,
): ActivityControlAction[] {
  if (!goal) return cancellableTurn ? ["interrupt"] : [];
  const goalActions: ActivityControlAction[] = (() => {
    switch (goal.status) {
      case "active":
        return cancellableTurn ? ["edit", "clear"] : ["pause", "edit", "clear"];
      case "paused":
      case "blocked":
      case "usageLimited":
        return ["resume", "edit", "clear"];
      case "budgetLimited":
      case "complete":
        return ["edit", "clear"];
    }
  })();
  return cancellableTurn ? ["interrupt", ...goalActions] : goalActions;
}

export function isActivityControlAction(value: unknown): value is ActivityControlAction {
  return value === "interrupt" || value === "pause" || value === "resume" || value === "edit" || value === "clear";
}
