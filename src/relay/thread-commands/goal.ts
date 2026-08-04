import type { ConversationId, MessageId } from "../../domain/ids.ts";
import { sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentSessionStatus, AgentThreadGoal } from "../../ports/agent.ts";
import type { EditMessageTextOptions, SendMessageOptions } from "../../ports/im.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RelayStore } from "../../storage/store.ts";
import { activityControlActions, type ActivityControlAction, type ActivityControlPayload } from "../activity-controls.ts";
import type { PendingPrompt, WorkspaceRecord } from "../types.ts";
import { CODEX_PROMPT_TTL_MS } from "../ui/constants.ts";
import { shortToken } from "../ui/callback-data.ts";
import { activityControlKeyboard } from "../ui/keyboards.ts";
import { formatGoalClearedMessage, formatGoalMessage } from "../ui/messages.ts";
import { messageWithTitle } from "../ui/text-parts.ts";
import type { CallbackMessage } from "./types.ts";

export interface GoalCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }>;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  setReplyToMessageId(sessionKey: string, messageId: MessageId): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: ReturnType<typeof activityControlKeyboard>): Promise<unknown>;
  refreshActivityContext(sessionKey: string): Promise<void>;
}

export class GoalCommandService {
  constructor(private readonly deps: GoalCommandDeps) {}

  async run(conversationId: ConversationId, args: string, userMessageId?: MessageId): Promise<void> {
    const { status, key } = await this.deps.commandSession(conversationId);
    const normalized = args.trim();
    this.requireGoalSupport();

    if (!normalized) {
      const goal = await this.deps.agent.getThreadGoal!(key);
      const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
      const result = await this.deps.sendRendered(conversationId, formatGoalMessage(goal), {
        replyMarkup: controls.keyboard,
      });
      if (result.messageId !== undefined) this.bindGoalControls(conversationId, result.messageId, key, status, goal, controls.token, controls.actions);
      return;
    }

    if (isRemovedGoalControl(normalized)) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Goal controls moved.", "Use the buttons on the latest activity or Goal card."));
      return;
    }

    validateGoalObjective(normalized);
    const current = await this.deps.agent.getThreadGoal!(key);
    if (current) {
      await this.deps.sendRendered(conversationId, messageWithTitle("A goal is already set.", "Open /goal and use Edit or Clear on the Goal card."));
      return;
    }
    if (userMessageId !== undefined) this.deps.setReplyToMessageId(key, userMessageId);
    await this.deps.agent.setThreadGoal!(key, { objective: normalized, status: "active", tokenBudget: null });
    await this.deps.refreshActivityContext(key);
  }

  async handleControl(
    message: CallbackMessage,
    pending: PendingPrompt,
    action: Exclude<ActivityControlAction, "interrupt">,
  ): Promise<string> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || !status.threadId || pending.sessionKey !== key) throw new Error("Goal control expired.");

    if (action === "edit") {
      const goal = await this.deps.agent.getThreadGoal!(key);
      if (!goal) throw new Error("No goal to edit.");
      await this.promptEdit(message.conversationId, key, status.threadId, goal, message.messageId);
      return "Edit goal.";
    }

    if (action === "clear") {
      const cleared = await this.deps.agent.clearThreadGoal!(key);
      const controls = this.keyboardFor(null, Boolean(status.activeTurnId));
      await this.deps.renderStrictCallbackPage(message, formatGoalClearedMessage(cleared), controls.keyboard);
      if (message.messageId !== undefined) {
        this.bindGoalControls(message.conversationId, message.messageId, key, status, null, controls.token, controls.actions);
      }
      await this.deps.refreshActivityContext(key);
      return cleared ? "Goal cleared." : "No goal to clear.";
    }

    const goal = await this.deps.agent.setThreadGoal!(key, { status: action === "resume" ? "active" : "paused" });
    await this.deps.refreshActivityContext(key);
    await this.renderGoalCallback(message, key, status, goal);
    return action === "resume" ? "Goal resumed." : "Goal paused.";
  }

  async answerEdit(conversationId: ConversationId, pending: PendingPrompt, data: Record<string, unknown>, text: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || (typeof data.threadId === "string" && status.threadId !== data.threadId) || pending.sessionKey !== key) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Goal edit expired.", "Open /goal and use Edit on the current Goal card."));
      return;
    }
    const objective = text.trim();
    validateGoalObjective(objective);
    this.requireGoalSupport();
    const goal = await this.deps.agent.setThreadGoal!(key, { objective });
    const sourceMessageId = typeof data.sourceMessageId === "string" || typeof data.sourceMessageId === "number"
      ? data.sourceMessageId
      : undefined;
    if (sourceMessageId !== undefined) await this.editGoalCard(conversationId, sourceMessageId, key, status, goal);
    await this.deps.refreshActivityContext(key);
  }

  private async promptEdit(
    conversationId: ConversationId,
    key: string,
    threadId: string,
    goal: AgentThreadGoal,
    sourceMessageId?: MessageId,
  ): Promise<void> {
    const result = await this.deps.sendRendered(conversationId, messageWithTitle("Edit goal", `Current objective: ${goal.objective}`), {
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
      payloadJson: JSON.stringify({ command: "goal_edit", threadId, ...(sourceMessageId !== undefined ? { sourceMessageId } : {}) }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async renderGoalCallback(message: CallbackMessage, key: string, status: AgentSessionStatus, goal: AgentThreadGoal): Promise<void> {
    const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
    await this.deps.renderStrictCallbackPage(message, formatGoalMessage(goal), controls.keyboard);
    if (message.messageId !== undefined) {
      this.bindGoalControls(message.conversationId, message.messageId, key, status, goal, controls.token, controls.actions);
    }
  }

  private async editGoalCard(
    conversationId: ConversationId,
    messageId: MessageId,
    key: string,
    status: AgentSessionStatus,
    goal: AgentThreadGoal,
  ): Promise<void> {
    const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
    await this.deps.editRendered(conversationId, formatGoalMessage(goal), { messageId, replyMarkup: controls.keyboard });
    this.bindGoalControls(conversationId, messageId, key, status, goal, controls.token, controls.actions);
  }

  private bindGoalControls(
    conversationId: ConversationId,
    messageId: MessageId,
    key: string,
    status: AgentSessionStatus,
    goal: AgentThreadGoal | null,
    token: string,
    actions: ActivityControlAction[],
  ): void {
    if (!actions.length) {
      this.deps.store.deletePendingPrompt(conversationId, messageId);
      return;
    }
    const payload: ActivityControlPayload = {
      command: "activity",
      token,
      actions,
      sessionKey: key,
      ...(status.threadId ? { threadId: status.threadId } : {}),
      ...(status.activeTurnId ? { turnId: status.activeTurnId, phase: "working" } : { phase: "goal" }),
      ...(goal ? {
        goalCreatedAt: goal.createdAt,
        goalUpdatedAt: goal.updatedAt,
        goalStatus: goal.status,
      } : {}),
    };
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify(payload),
    });
  }

  private keyboardFor(goal: AgentThreadGoal | null, cancellableTurn: boolean): {
    token: string;
    actions: ActivityControlAction[];
    keyboard: ReturnType<typeof activityControlKeyboard>;
  } {
    const token = shortToken();
    const actions = activityControlActions(goal, cancellableTurn);
    return { token, actions, keyboard: activityControlKeyboard(token, actions) };
  }

  private requireGoalSupport(): void {
    if (!this.deps.agent.getThreadGoal || !this.deps.agent.setThreadGoal || !this.deps.agent.clearThreadGoal) {
      throw new Error("Agent driver does not support thread goals.");
    }
  }
}

function isRemovedGoalControl(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "edit" || normalized === "pause" || normalized === "resume" || normalized === "clear";
}

export function validateGoalObjective(objective: string): void {
  if (!objective) throw new Error("Goal objective must not be empty.");
  if (objective.length > 4_000) throw new Error("Goal objective must not exceed 4,000 characters.");
}
