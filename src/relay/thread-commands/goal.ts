import type { ConversationId } from "../../domain/ids.ts";
import { sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentSessionStatus } from "../../ports/agent.ts";
import type { SendMessageOptions } from "../../ports/im.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { PendingPrompt, WorkspaceRecord } from "../types.ts";
import { CODEX_PROMPT_TTL_MS } from "../ui/constants.ts";
import { formatGoalClearedMessage, formatGoalMessage, formatGoalUpdatedMessage } from "../ui/messages.ts";
import { messageWithTitle } from "../ui/text-parts.ts";

export interface GoalCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }>;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: string | number }>;
  refreshActivityContext(sessionKey: string): Promise<void>;
}

export class GoalCommandService {
  constructor(private readonly deps: GoalCommandDeps) {}

  async run(conversationId: ConversationId, args: string): Promise<void> {
    const { key } = await this.deps.commandSession(conversationId);
    const normalized = args.trim();
    if (!this.deps.agent.getThreadGoal || !this.deps.agent.setThreadGoal || !this.deps.agent.clearThreadGoal) {
      throw new Error("Agent driver does not support thread goals.");
    }

    if (!normalized) {
      await this.deps.sendRendered(conversationId, formatGoalMessage(await this.deps.agent.getThreadGoal(key)));
      return;
    }

    if (normalized.toLowerCase() === "edit") {
      const current = await this.deps.agent.getThreadGoal(key);
      if (!current) {
        await this.deps.sendRendered(conversationId, messageWithTitle("No goal to edit.", "Set one with /goal <objective>."));
        return;
      }
      const result = await this.deps.sendRendered(conversationId, messageWithTitle("Edit goal", `Current objective: ${current.objective}`), {
        forceReply: true,
        forceReplyInstruction: "Reply with the new goal objective.",
        inputFieldPlaceholder: "New goal objective",
      });
      if (!result.messageId) throw new Error("IM adapter did not return a goal edit prompt message id.");
      this.deps.store.setPendingPrompt({
        conversationId,
        promptMessageId: result.messageId,
        kind: "relay_command",
        createdAt: Date.now(),
        sessionKey: key,
        payloadJson: JSON.stringify({ command: "goal_edit", threadId: this.deps.agent.getStatus(key)?.threadId }),
        expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
      });
      return;
    }

    switch (normalized.toLowerCase()) {
      case "pause": {
        const goal = await this.deps.agent.setThreadGoal(key, { status: "paused" });
        await this.deps.refreshActivityContext(key);
        await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
        return;
      }
      case "resume": {
        const goal = await this.deps.agent.setThreadGoal(key, { status: "active" });
        await this.deps.refreshActivityContext(key);
        await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
        return;
      }
      case "clear": {
        const cleared = await this.deps.agent.clearThreadGoal(key);
        await this.deps.refreshActivityContext(key);
        await this.deps.sendRendered(conversationId, formatGoalClearedMessage(cleared));
        return;
      }
    }

    validateGoalObjective(normalized);
    const current = await this.deps.agent.getThreadGoal(key);
    if (current) {
      await this.deps.sendRendered(conversationId, messageWithTitle("A goal is already set.", "Use /goal edit to revise it, or /goal clear first."));
      return;
    }
    const goal = await this.deps.agent.setThreadGoal(key, { objective: normalized, status: "active", tokenBudget: null });
    await this.deps.refreshActivityContext(key);
    await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
  }

  async answerEdit(conversationId: ConversationId, pending: PendingPrompt, data: Record<string, unknown>, text: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || (typeof data.threadId === "string" && status.threadId !== data.threadId) || pending.sessionKey !== key) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Goal edit expired.", "Open the current goal and try again."));
      return;
    }
    const objective = text.trim();
    validateGoalObjective(objective);
    if (!this.deps.agent.setThreadGoal) throw new Error("Agent driver does not support thread goals.");
    const goal = await this.deps.agent.setThreadGoal(key, { objective });
    await this.deps.refreshActivityContext(key);
    await this.deps.sendRendered(conversationId, formatGoalUpdatedMessage(goal));
  }
}

export function validateGoalObjective(objective: string): void {
  if (!objective) throw new Error("Goal objective must not be empty.");
  if (objective.length > 4_000) throw new Error("Goal objective must not exceed 4,000 characters.");
}
