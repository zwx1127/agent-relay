import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { Logger } from "../../domain/logger.ts";
import { parseChatScopeKey } from "../../domain/scope.ts";
import { parseSessionKey, sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentSessionStatus, AgentThreadGoal, AgentThreadGoalStatus } from "../../ports/agent.ts";
import type { EditMessageTextOptions, ImAdapter, SendMessageOptions } from "../../ports/im.ts";
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
  adapter: Pick<ImAdapter, "deleteMessage">;
  logger: Logger;
  commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }>;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  registerGoalReplyTarget(sessionKey: string, messageId: MessageId, activeTurnId?: string): void;
  clearGoalReplyTarget(sessionKey: string): void;
  isCurrentControlCard(sessionKey: string, messageId: MessageId): boolean;
  activateControlCard(sessionKey: string, scopeKey: string, messageId: MessageId, rendered: RenderedTelegramText): Promise<void>;
  retireControlCard(sessionKey: string, messageId?: MessageId): Promise<boolean>;
  releaseControlCard(sessionKey: string, messageId: MessageId): boolean;
  resumeActivityControls(sessionKey: string, messageId?: MessageId): Promise<boolean>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  refreshActivityContext(sessionKey: string): Promise<void>;
}

export class GoalCommandService {
  constructor(private readonly deps: GoalCommandDeps) {}

  clearSession(sessionKeyValue: string): void {
    this.deps.clearGoalReplyTarget(sessionKeyValue);
  }

  async syncExternal(sessionKeyValue: string, goal: AgentThreadGoal | null): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (!parsed || !status?.running) return;
    status.threadGoal = goal;
    if (status.activeTurnId) {
      await this.deps.refreshActivityContext(sessionKeyValue);
      return;
    }
    await this.deps.retireControlCard(sessionKeyValue);
    await this.sendGoalCard(parsed.scopeKey, sessionKeyValue, status, goal, formatGoalMessage(goal));
  }

  async run(conversationId: ConversationId, args: string, userMessageId?: MessageId): Promise<void> {
    const { status, key } = await this.deps.commandSession(conversationId);
    const normalized = args.trim();
    this.requireGoalSupport();

    if (!normalized) {
      const goal = await this.deps.agent.getThreadGoal!(key);
      await this.sendGoalCard(conversationId, key, status, goal, formatGoalMessage(goal));
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
    if (userMessageId !== undefined) this.deps.registerGoalReplyTarget(key, userMessageId, status.activeTurnId);
    try {
      await this.deps.agent.setThreadGoal!(key, { objective: normalized, status: "active", tokenBudget: null });
    } catch (error) {
      if (userMessageId !== undefined) this.deps.clearGoalReplyTarget(key);
      throw error;
    }
    await this.deps.refreshActivityContext(key);
  }

  async handleControl(
    message: CallbackMessage,
    pending: PendingPrompt,
    action: Exclude<ActivityControlAction, "interrupt">,
    sourcePhase: unknown,
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
      this.deps.clearGoalReplyTarget(key);
      const editSource = sourcePhase === "goal";
      if (editSource) await this.deps.refreshActivityContext(key);
      await this.renderGoalMutation(message, key, status, null, formatGoalClearedMessage(cleared), editSource);
      if (!editSource) await this.deps.refreshActivityContext(key);
      return cleared ? "Goal cleared." : "No goal to clear.";
    }

    const goal = await this.deps.agent.setThreadGoal!(key, { status: action === "resume" ? "active" : "paused" });
    const editSource = sourcePhase === "goal";
    if (editSource) await this.deps.refreshActivityContext(key);
    await this.renderGoalMutation(message, key, status, goal, formatGoalMessage(goal), editSource);
    if (!editSource) await this.deps.refreshActivityContext(key);
    return action === "resume" ? "Goal resumed." : "Goal paused.";
  }

  async answerEdit(
    conversationId: ConversationId,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    text: string,
    userMessageId?: MessageId,
  ): Promise<void> {
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
    const current = await this.deps.agent.getThreadGoal!(key);
    if (!current || typeof data.goalCreatedAt !== "number" || current.createdAt !== data.goalCreatedAt) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Goal edit expired.", "Open /goal and use Edit on the current Goal card."));
      return;
    }
    const goal = await this.deps.agent.setThreadGoal!(key, {
      objective,
      status: editedGoalStatus(current.status),
      tokenBudget: current.tokenBudget,
    });
    const sourceMessageId = typeof data.sourceMessageId === "string" || typeof data.sourceMessageId === "number"
      ? data.sourceMessageId
      : undefined;

    await this.deps.refreshActivityContext(key);
    if (goal.status === "active") {
      const replyTarget = userMessageId ?? pending.promptMessageId;
      this.deps.registerGoalReplyTarget(key, replyTarget, status.activeTurnId);
      await this.tryDeleteMessage(conversationId, pending.promptMessageId);
      await this.deps.resumeActivityControls(key, sourceMessageId);
      return;
    }

    const rendered = formatGoalMessage(goal);
    const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
    await this.deps.editRendered(conversationId, rendered, { messageId: pending.promptMessageId, replyMarkup: controls.keyboard });
    await this.bindGoalControls(conversationId, pending.promptMessageId, key, status, goal, controls.token, controls.actions, rendered);
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
      payloadJson: JSON.stringify({
        command: "goal_edit",
        threadId,
        goalCreatedAt: goal.createdAt,
        ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
      }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
    if (sourceMessageId !== undefined) await this.deps.retireControlCard(key, sourceMessageId);
  }

  private async renderGoalMutation(
    message: CallbackMessage,
    key: string,
    status: AgentSessionStatus,
    goal: AgentThreadGoal | null,
    rendered: RenderedTelegramText,
    editSource: boolean,
  ): Promise<void> {
    const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
    if (editSource && message.messageId !== undefined && this.deps.isCurrentControlCard(key, message.messageId)) {
      await this.deps.editRendered(message.conversationId, rendered, { messageId: message.messageId, replyMarkup: controls.keyboard });
      await this.bindGoalControls(message.conversationId, message.messageId, key, status, goal, controls.token, controls.actions, rendered);
      return;
    }
    await this.sendGoalCard(message.conversationId, key, status, goal, rendered);
  }

  private async sendGoalCard(
    conversationId: ConversationId,
    key: string,
    status: AgentSessionStatus,
    goal: AgentThreadGoal | null,
    rendered: RenderedTelegramText,
  ): Promise<void> {
    const controls = this.keyboardFor(goal, Boolean(status.activeTurnId));
    const result = await this.deps.sendRendered(conversationId, rendered, { replyMarkup: controls.keyboard });
    if (result.messageId === undefined) {
      await this.deps.retireControlCard(key);
      return;
    }
    await this.bindGoalControls(conversationId, result.messageId, key, status, goal, controls.token, controls.actions, rendered);
  }

  private async bindGoalControls(
    conversationId: ConversationId,
    messageId: MessageId,
    key: string,
    status: AgentSessionStatus,
    goal: AgentThreadGoal | null,
    token: string,
    actions: ActivityControlAction[],
    rendered: RenderedTelegramText,
  ): Promise<void> {
    if (!actions.length) {
      this.deps.store.deletePendingPrompt(conversationId, messageId);
      if (!this.deps.releaseControlCard(key, messageId)) await this.deps.retireControlCard(key);
      return;
    }
    await this.deps.activateControlCard(key, String(conversationId), messageId, rendered);
    if (!this.deps.isCurrentControlCard(key, messageId)) return;
    const payload: ActivityControlPayload = {
      command: "activity",
      token,
      actions,
      sessionKey: key,
      ...(status.threadId ? { threadId: status.threadId } : {}),
      ...(status.activeTurnId ? { turnId: status.activeTurnId } : {}),
      phase: "goal",
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

  private async tryDeleteMessage(conversationId: ConversationId, messageId: MessageId): Promise<void> {
    if (!this.deps.adapter.deleteMessage) return;
    const scope = parseChatScopeKey(String(conversationId));
    try {
      await this.deps.adapter.deleteMessage(scope.conversationId, messageId);
    } catch (error) {
      this.deps.logger.warn("router.goal_edit_prompt_delete_failed", {
        conversation_id: scope.conversationId,
        scope_key: String(conversationId),
        message_id: messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private requireGoalSupport(): void {
    if (!this.deps.agent.getThreadGoal || !this.deps.agent.setThreadGoal || !this.deps.agent.clearThreadGoal) {
      throw new Error("Agent driver does not support thread goals.");
    }
  }
}

function editedGoalStatus(status: AgentThreadGoalStatus): AgentThreadGoalStatus {
  return status === "complete" || status === "budgetLimited" ? "active" : status;
}

function isRemovedGoalControl(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "edit" || normalized === "pause" || normalized === "resume" || normalized === "clear";
}

export function validateGoalObjective(objective: string): void {
  if (!objective) throw new Error("Goal objective must not be empty.");
  if (objective.length > 4_000) throw new Error("Goal objective must not exceed 4,000 characters.");
}
