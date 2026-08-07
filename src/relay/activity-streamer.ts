import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { parseSessionKey } from "../domain/session.ts";
import type {
  AgentActivity,
  AgentActivityEvent,
  AgentCollaborationMode,
  AgentPlanStep,
  AgentSessionStatus,
  AgentThreadGoal,
  AgentTurnStatus,
} from "../ports/agent.ts";
import { MessageDeliveryUnknownError, type EditMessageTextOptions, type SendMessageOptions } from "../ports/im.ts";
import { renderTelegramText, type RenderedTelegramText, type TelegramTextPart } from "../presentation/telegram/text.ts";
import type { RelayStore } from "../storage/store.ts";
import { activityControlActions, type ActivityControlAction, type ActivityControlPayload } from "./activity-controls.ts";
import { shortToken } from "./ui/callback-data.ts";
import {
  ACTIVITY_MAX_CHARS,
  ACTIVITY_MAX_ROWS,
  ACTIVITY_MAX_STALE_MS,
  ACTIVITY_RECENT_RETAIN,
  ACTIVITY_ROUTINE_MIN_MS,
  ACTIVITY_ROW_COLUMNS,
  STREAM_QUIET_MS,
} from "./ui/constants.ts";
import { activityControlKeyboard } from "./ui/keyboards.ts";

export interface ActivitySessionContext {
  threadId?: string;
  threadName?: string;
  collaborationMode: AgentCollaborationMode;
  goal: AgentThreadGoal | null | undefined;
  activeTurnId?: string;
}

export type ActivityPhase = "idle" | "working" | "stalled" | "waitingForInput" | "waitingForApproval" | "done" | "interrupted" | "failed";

interface ActivityItemState {
  key: string;
  label: string;
  status: string;
  detail?: string;
}

interface ReasoningState {
  key: string;
  text: string;
}

interface ActivityState {
  sessionKey: string;
  scopeKey: string;
  conversationId: ConversationId;
  workspaceName: string;
  generation: number;
  controlToken: string;
  invalidated: boolean;
  threadId?: string;
  threadName?: string;
  turnId: string;
  startedAt?: number;
  lastFlushAt: number;
  dirtySince?: number;
  revision: number;
  mode: AgentCollaborationMode;
  goalTurn: boolean;
  goal: AgentThreadGoal | null | undefined;
  reasoning?: ReasoningState;
  plan?: { explanation?: string; steps: AgentPlanStep[] };
  items: ActivityItemState[];
  itemTotal: number;
  filePaths: Set<string>;
  fileCount: number;
  phase: ActivityPhase;
  phaseDetail?: string;
  error?: string;
  durationMs?: number;
  messageId?: MessageId;
  replyToMessageId?: MessageId;
  timer?: Timer;
  flushPromise?: Promise<void>;
  lastRendered?: string;
  lastControls?: string;
  sentOnce?: boolean;
  transcriptAppended?: boolean;
  controlsSuppressed?: boolean;
  presentationFrozen?: boolean;
  deliveryUnknown?: boolean;
}

interface ActivityControlCard {
  scopeKey: string;
  messageId: MessageId;
  rendered: RenderedTelegramText;
}

interface GoalReplyTarget {
  messageId: MessageId;
  excludedTurnId?: string;
  consumed: boolean;
}

export interface ActivityStreamerDeps {
  store: Pick<RelayStore, "deletePagedOutputsForSession" | "appendTranscript" | "setPendingPrompt" | "deletePendingPrompt">;
  logger: Logger;
  canEdit: boolean;
  getReplyToMessageId(sessionKey: string): MessageId | undefined;
  onReplyTargetClaimed?(sessionKey: string, messageId: MessageId): void;
  getSessionContext(sessionKey: string): ActivitySessionContext;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  timing?: { quietMs?: number; maxMs?: number; minEditMs?: number };
}

export class ActivityStreamer {
  private readonly states = new Map<string, ActivityState>();
  private readonly controlCards = new Map<string, ActivityControlCard>();
  private readonly pendingUserReplies = new Map<string, MessageId>();
  private readonly goalReplyTargets = new Map<string, GoalReplyTarget>();
  private readonly quietMs: number;
  private readonly maxMs: number;
  private readonly minEditMs: number;
  private nextGeneration = 1;

  constructor(private readonly deps: ActivityStreamerDeps) {
    this.quietMs = deps.timing?.quietMs ?? STREAM_QUIET_MS;
    this.maxMs = deps.timing?.maxMs ?? ACTIVITY_MAX_STALE_MS;
    this.minEditMs = deps.timing?.minEditMs ?? (deps.timing?.quietMs === undefined ? ACTIVITY_ROUTINE_MIN_MS : 0);
  }

  registerUserReplyTarget(sessionKey: string, messageId: MessageId, activeTurnId?: string): void {
    if (activeTurnId) return;
    this.pendingUserReplies.set(sessionKey, messageId);
  }

  registerGoalReplyTarget(sessionKey: string, messageId: MessageId, activeTurnId?: string): void {
    this.goalReplyTargets.set(sessionKey, {
      messageId,
      ...(activeTurnId ? { excludedTurnId: activeTurnId } : {}),
      consumed: false,
    });
  }

  clearGoalReplyTarget(sessionKey: string): void {
    this.goalReplyTargets.delete(sessionKey);
  }

  clearReplyTargets(sessionKey: string): void {
    this.pendingUserReplies.delete(sessionKey);
    this.goalReplyTargets.delete(sessionKey);
  }

  isCurrentControlCard(sessionKey: string, messageId: MessageId): boolean {
    const current = this.controlCards.get(sessionKey);
    return Boolean(current && String(current.messageId) === String(messageId));
  }

  async activateControlCard(sessionKey: string, scopeKey: string, messageId: MessageId, rendered: RenderedTelegramText): Promise<void> {
    const current = this.controlCards.get(sessionKey);
    if (current && String(current.messageId) !== String(messageId)) await this.retireControlCard(sessionKey, current.messageId);
    this.controlCards.set(sessionKey, { scopeKey, messageId, rendered });
  }

  async retireControlCard(sessionKey: string, expectedMessageId?: MessageId): Promise<boolean> {
    const card = this.controlCards.get(sessionKey);
    if (!card || (expectedMessageId !== undefined && String(card.messageId) !== String(expectedMessageId))) return false;
    this.controlCards.delete(sessionKey);
    this.deps.store.deletePendingPrompt(card.scopeKey, card.messageId);
    const state = this.states.get(sessionKey);
    if (state?.messageId !== undefined && String(state.messageId) === String(card.messageId)) {
      state.controlsSuppressed = true;
      state.presentationFrozen = true;
      state.lastControls = undefined;
    }
    if (!this.deps.canEdit) return true;
    try {
      await this.deps.editRendered(card.scopeKey, card.rendered, { messageId: card.messageId, replyMarkup: { inline_keyboard: [] } });
    } catch (error) {
      this.deps.logger.warn("router.activity_control_retire_failed", {
        session_key: sessionKey,
        message_id: card.messageId,
        error: asError(error),
      });
    }
    return true;
  }

  releaseControlCard(sessionKey: string, messageId: MessageId): boolean {
    const card = this.controlCards.get(sessionKey);
    if (!card || String(card.messageId) !== String(messageId)) return false;
    this.controlCards.delete(sessionKey);
    this.deps.store.deletePendingPrompt(card.scopeKey, card.messageId);
    const state = this.states.get(sessionKey);
    if (state?.messageId !== undefined && String(state.messageId) === String(messageId)) {
      state.controlsSuppressed = true;
      state.presentationFrozen = true;
      state.lastControls = undefined;
    }
    return true;
  }

  async resumeActivityControls(sessionKey: string, messageId?: MessageId): Promise<boolean> {
    const state = this.states.get(sessionKey);
    if (!state || state.messageId === undefined || (messageId !== undefined && String(state.messageId) !== String(messageId))) return false;
    if (this.controlCards.has(sessionKey)) return false;
    const context = this.deps.getSessionContext(sessionKey);
    if (context.activeTurnId !== state.turnId) return false;
    if (state.phase !== "working" && state.phase !== "stalled" && state.phase !== "waitingForInput" && state.phase !== "waitingForApproval") return false;
    state.controlsSuppressed = false;
    state.presentationFrozen = false;
    state.lastControls = undefined;
    this.markDirty(state);
    await this.schedule(state, true);
    return true;
  }

  async handle(event: AgentActivityEvent): Promise<void> {
    if (isHiddenActivity(event.activity)) return;
    const context = this.deps.getSessionContext(event.sessionKey);
    if (event.threadId && context.threadId && event.threadId !== context.threadId) {
      this.deps.logger.info("router.activity_stale_thread", {
        session_key: event.sessionKey,
        event_thread_id: event.threadId,
        current_thread_id: context.threadId,
      });
      return;
    }
    const state = await this.stateFor(event, context);
    if (!state) return;
    if (state.phase === "stalled") {
      state.phase = "working";
      state.phaseDetail = undefined;
    }
    this.apply(state, event.activity, event.itemId);
    await this.schedule(state, isImmediate(event.activity));
  }

  async bootstrapResume(status: AgentSessionStatus): Promise<void> {
    const context = this.deps.getSessionContext(status.sessionKey);
    const snapshot = status.latestTurn;
    const turnId = snapshot?.id ?? `resume-idle:${status.threadId ?? status.sessionKey}`;
    const state = await this.stateFor({
      type: "activity",
      sessionKey: status.sessionKey,
      ...(status.threadId ? { threadId: status.threadId } : {}),
      turnId,
      activity: { kind: "notice", level: "info", title: "Resumed thread snapshot" },
    }, context);
    if (!state) return;

    if (snapshot?.startedAt !== undefined) state.startedAt = snapshot.startedAt;
    else if (snapshot && snapshot.durationMs === undefined) state.startedAt = undefined;
    state.durationMs = snapshot?.durationMs;
    state.error = snapshot?.error?.message;
    state.phaseDetail = snapshot ? undefined : "No turns yet";
    for (const entry of snapshot?.activities ?? []) this.apply(state, entry.activity, entry.itemId);

    if (!snapshot) state.phase = "idle";
    else if (snapshot.status === "completed") state.phase = "done";
    else if (snapshot.status === "interrupted") state.phase = "interrupted";
    else if (snapshot.status === "failed") state.phase = "failed";
    else if (status.waitingForApproval) state.phase = "waitingForApproval";
    else if (status.waitingForUserInput) state.phase = "waitingForInput";
    else state.phase = "working";
    this.markDirty(state);

    if (state.phase === "working" || state.phase === "waitingForInput" || state.phase === "waitingForApproval") {
      await this.schedule(state, true);
      return;
    }
    await this.finish(state);
  }

  async finalize(sessionKey: string, turnId: string | undefined, status: AgentTurnStatus, error?: string, durationMs?: number): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state || (turnId && turnId !== state.turnId)) return;
    state.phase = status === "completed" ? "done" : status === "interrupted" ? "interrupted" : "failed";
    state.error = error;
    state.durationMs = durationMs;
    this.markDirty(state);
    await this.finish(state);
  }

  async terminate(
    sessionKey: string,
    phase: "interrupted" | "failed",
    detail?: string,
    options: { appendTranscript?: boolean } = {},
  ): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.phase = phase;
    state.error = detail;
    if (options.appendTranscript === false) state.transcriptAppended = true;
    this.markDirty(state);
    await this.finish(state);
  }

  async setPhase(sessionKey: string, phase: "working" | "stalled" | "waitingForInput" | "waitingForApproval", detail?: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    const context = this.deps.getSessionContext(sessionKey);
    if (state.threadId && context.threadId && state.threadId !== context.threadId) return;
    if (context.activeTurnId && context.activeTurnId !== state.turnId) return;
    state.phase = phase;
    state.phaseDetail = detail;
    this.markDirty(state);
    await this.schedule(state, true);
  }

  async refreshContext(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    const context = this.deps.getSessionContext(sessionKey);
    if (state.threadId && context.threadId && state.threadId !== context.threadId) return;
    state.mode = context.collaborationMode;
    state.threadName = context.threadName ?? state.threadName;
    if (context.goal !== undefined) state.goal = context.goal;
    this.markDirty(state);
    await this.schedule(state, true);
  }

  async invalidateSession(sessionKey: string, deletePages = true): Promise<void> {
    const state = this.states.get(sessionKey);
    if (state) {
      state.invalidated = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      this.states.delete(sessionKey);
      try {
        await state.flushPromise;
      } catch {
        // The originating flush already logged the transport failure.
      }
    }
    await this.retireControlCard(sessionKey);
    if (deletePages) this.deps.store.deletePagedOutputsForSession(sessionKey);
  }

  private async stateFor(event: AgentActivityEvent, context: ActivitySessionContext): Promise<ActivityState | undefined> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) {
      this.deps.logger.warn("router.activity_invalid_session", { session_key: event.sessionKey });
      return undefined;
    }
    const threadId = event.threadId ?? context.threadId;
    const turnId = event.turnId ?? context.activeTurnId;
    let state = this.states.get(event.sessionKey);
    if (state && ((threadId && state.threadId && threadId !== state.threadId) || (turnId && turnId !== state.turnId))) {
      await this.invalidateSession(event.sessionKey, false);
      state = undefined;
    }
    if (!state) {
      if (!turnId) {
        this.deps.logger.info("router.activity_without_active_turn", {
          session_key: event.sessionKey,
          ...(threadId ? { thread_id: threadId } : {}),
          activity_kind: event.activity.kind,
        });
        return undefined;
      }
      const now = Date.now();
      const replyTarget = this.claimReplyTarget(event.sessionKey, turnId, context);
      state = {
        sessionKey: event.sessionKey,
        scopeKey: parsed.scopeKey,
        conversationId: parsed.conversationId,
        workspaceName: parsed.workspaceName,
        generation: this.nextGeneration++,
        controlToken: shortToken(),
        invalidated: false,
        ...(threadId ? { threadId } : {}),
        ...(context.threadName ? { threadName: context.threadName } : {}),
        turnId,
        startedAt: now,
        lastFlushAt: now,
        revision: 0,
        mode: context.collaborationMode,
        goalTurn: replyTarget.goalTurn,
        goal: context.goal,
        items: [],
        itemTotal: 0,
        filePaths: new Set(),
        fileCount: 0,
        phase: "working",
        controlsSuppressed: false,
        presentationFrozen: false,
        replyToMessageId: replyTarget.messageId,
      };
      this.states.set(event.sessionKey, state);
    }
    return state;
  }

  private claimReplyTarget(sessionKey: string, turnId: string, context: ActivitySessionContext): { messageId?: MessageId; goalTurn: boolean } {
    const userReply = this.pendingUserReplies.get(sessionKey);
    if (userReply !== undefined) {
      this.pendingUserReplies.delete(sessionKey);
      return { messageId: userReply, goalTurn: false };
    }

    const goalTarget = this.goalReplyTargets.get(sessionKey);
    const goalTurn = Boolean(context.goal) && goalTarget?.excludedTurnId !== turnId;
    if (goalTurn) {
      if (goalTarget && !goalTarget.consumed) {
        goalTarget.consumed = true;
        this.deps.onReplyTargetClaimed?.(sessionKey, goalTarget.messageId);
        return { messageId: goalTarget.messageId, goalTurn: true };
      }
      return { goalTurn: true };
    }
    const fallback = this.deps.getReplyToMessageId(sessionKey);
    return fallback === undefined ? { goalTurn: false } : { messageId: fallback, goalTurn: false };
  }

  private apply(state: ActivityState, activity: AgentActivity, itemId?: string): void {
    this.markDirty(state);
    switch (activity.kind) {
      case "reasoning": {
        const key = `${itemId ?? "reasoning"}:${activity.sectionIndex ?? 0}`;
        const summary = activity.summary;
        state.reasoning = state.reasoning?.key === key
          ? { key, text: boundedText(state.reasoning.text + summary, 4096) }
          : { key, text: boundedText(summary, 4096) };
        break;
      }
      case "plan":
        state.plan = { ...(activity.explanation ? { explanation: activity.explanation } : {}), steps: activity.steps };
        break;
      case "item": {
        if (isSyntheticTurnStarted(activity)) break;
        const key = itemId ?? `${activity.category}:${activity.label}`;
        if (activity.category === "fileChange") {
          this.recordFiles(state, key, activity.files?.map((file) => file.path) ?? []);
          break;
        }
        const existing = state.items.find((item) => item.key === key);
        const next: ActivityItemState = {
          key,
          label: activity.label,
          status: activity.status,
          ...(activity.detail ? { detail: activity.detail } : {}),
        };
        if (existing) Object.assign(existing, next);
        else {
          state.itemTotal += 1;
          state.items.push(next);
          if (state.items.length > ACTIVITY_RECENT_RETAIN) state.items.shift();
        }
        if (activity.files?.length) this.recordFiles(state, key, activity.files.map((file) => file.path));
        break;
      }
      case "goal":
        state.goal = activity.goal;
        break;
      case "diff":
      case "notice":
      case "settings":
        break;
    }
  }

  private recordFiles(state: ActivityState, fallbackKey: string, paths: string[]): void {
    const identities = paths.length ? paths : [`event:${fallbackKey}`];
    for (const identity of identities) {
      if (state.filePaths.has(identity)) continue;
      if (state.filePaths.size >= 512) continue;
      state.fileCount += 1;
      state.filePaths.add(identity);
    }
  }

  private markDirty(state: ActivityState): void {
    state.revision += 1;
    state.dirtySince ??= Date.now();
  }

  private async schedule(state: ActivityState, immediate: boolean): Promise<void> {
    if (!this.isCurrent(state)) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (state.presentationFrozen || state.deliveryUnknown) return;
    if (immediate) {
      await this.flush(state, false);
      return;
    }
    const now = Date.now();
    const quietDue = now + this.quietMs;
    const editDue = state.sentOnce ? state.lastFlushAt + this.minEditMs : quietDue;
    const staleDue = (state.dirtySince ?? now) + this.maxMs;
    const due = Math.min(Math.max(quietDue, editDue), staleDue);
    state.timer = setTimeout(() => void this.flush(state, false).catch((error) => {
      this.deps.logger.warn("router.activity_flush_failed", {
        session_key: state.sessionKey,
        generation: state.generation,
        error: asError(error),
      });
    }), Math.max(0, due - now));
  }

  private async finish(state: ActivityState): Promise<void> {
    if (!this.isCurrent(state)) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    if (state.deliveryUnknown) {
      this.completeState(state);
      return;
    }
    if (state.presentationFrozen) {
      state.messageId = undefined;
      state.sentOnce = false;
      state.lastRendered = undefined;
      state.lastControls = undefined;
      state.controlsSuppressed = false;
      state.presentationFrozen = false;
      state.replyToMessageId = undefined;
    }
    await this.flush(state, true);
    if (!this.isCurrent(state)) return;
    if (state.dirtySince !== undefined) await this.flush(state, true);
    if (!this.isCurrent(state)) return;
    this.completeState(state);
  }

  private async flush(state: ActivityState, final: boolean): Promise<void> {
    if (!this.isCurrent(state)) return;
    if (state.flushPromise) {
      await state.flushPromise;
      if (this.isCurrent(state) && state.dirtySince !== undefined) await this.flush(state, final);
      return;
    }
    const promise = this.flushOnce(state, final);
    state.flushPromise = promise;
    try {
      await promise;
    } finally {
      state.flushPromise = undefined;
    }
  }

  private async flushOnce(state: ActivityState, final: boolean): Promise<void> {
    if (!this.isCurrent(state)) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const context = this.deps.getSessionContext(state.sessionKey);
    if (state.threadId && context.threadId && state.threadId !== context.threadId) return;
    state.mode = context.collaborationMode;
    state.threadName = context.threadName ?? state.threadName;
    if (context.goal !== undefined) state.goal = context.goal;
    const renderedRevision = state.revision;
    const rendered = renderActivity(state);
    const actions = this.controlsFor(state, context);
    const controlsKey = actions.join(",");
    if (!final && rendered.text === state.lastRendered && controlsKey === state.lastControls) {
      this.markFlushed(state, renderedRevision);
      return;
    }
    const replyMarkup = activityControlKeyboard(state.controlToken, actions);
    if (state.messageId && this.deps.canEdit) {
      try {
        await this.deps.editRendered(state.scopeKey, rendered, { messageId: state.messageId, replyMarkup });
        if (!this.isCurrent(state)) return;
        state.lastRendered = rendered.text;
        state.lastControls = controlsKey;
        state.lastFlushAt = Date.now();
        await this.bindControls(state, rendered, actions);
        this.markFlushed(state, renderedRevision);
        return;
      } catch (error) {
        if (!this.isCurrent(state)) return;
        this.deps.logger.warn("router.activity_edit_fallback", {
          session_key: state.sessionKey,
          generation: state.generation,
          message_id: state.messageId,
          error: asError(error),
        });
      }
    } else if (state.sentOnce && !final) {
      this.markFlushed(state, renderedRevision);
      return;
    }
    if (!this.isCurrent(state)) return;
    const previousMessageId = state.messageId;
    let result: { messageId?: MessageId };
    try {
      result = await this.deps.sendRendered(state.scopeKey, rendered, {
        replyToMessageId: state.sentOnce ? undefined : state.replyToMessageId,
        replyMarkup,
        disableWebPagePreview: true,
        deliveryMode: "at-most-once",
      });
    } catch (error) {
      if (!(error instanceof MessageDeliveryUnknownError)) throw error;
      if (!this.isCurrent(state)) return;
      state.deliveryUnknown = true;
      state.controlsSuppressed = true;
      state.lastControls = undefined;
      state.lastFlushAt = Date.now();
      this.markFlushed(state, renderedRevision);
      this.deps.logger.warn("router.activity_delivery_unknown", {
        session_key: state.sessionKey,
        generation: state.generation,
        turn_id: state.turnId,
        error,
      });
      return;
    }
    if (!this.isCurrent(state)) return;
    state.messageId = result.messageId;
    if (previousMessageId !== undefined && String(previousMessageId) !== String(result.messageId)) {
      this.deps.store.deletePendingPrompt(state.scopeKey, previousMessageId);
    }
    state.sentOnce = true;
    state.lastRendered = rendered.text;
    state.lastControls = controlsKey;
    state.lastFlushAt = Date.now();
    await this.bindControls(state, rendered, actions);
    this.markFlushed(state, renderedRevision);
  }

  private completeState(state: ActivityState): void {
    if (!state.transcriptAppended) {
      this.deps.store.appendTranscript({
        conversationId: state.conversationId,
        scopeKey: state.scopeKey,
        workspaceName: state.workspaceName,
        role: "system",
        text: finalTranscriptSummary(state),
        createdAt: Date.now(),
      });
      state.transcriptAppended = true;
    }
    state.invalidated = true;
    this.states.delete(state.sessionKey);
  }

  private controlsFor(state: ActivityState, context: ActivitySessionContext): ActivityControlAction[] {
    if (state.controlsSuppressed) return [];
    const activePhase = state.phase === "working" || state.phase === "stalled" || state.phase === "waitingForInput" || state.phase === "waitingForApproval";
    const cancellableTurn = activePhase && context.activeTurnId === state.turnId;
    return activityControlActions(state.goal, cancellableTurn);
  }

  private async bindControls(state: ActivityState, rendered: RenderedTelegramText, actions: ActivityControlAction[]): Promise<void> {
    if (state.messageId === undefined) return;
    if (!actions.length) {
      this.deps.store.deletePendingPrompt(state.scopeKey, state.messageId);
      const current = this.controlCards.get(state.sessionKey);
      if (current && String(current.messageId) === String(state.messageId)) this.controlCards.delete(state.sessionKey);
      return;
    }
    await this.activateControlCard(state.sessionKey, state.scopeKey, state.messageId, rendered);
    if (!this.isCurrent(state) || !this.isCurrentControlCard(state.sessionKey, state.messageId)) return;
    const payload: ActivityControlPayload = {
      command: "activity",
      token: state.controlToken,
      actions,
      sessionKey: state.sessionKey,
      ...(state.threadId ? { threadId: state.threadId } : {}),
      ...(state.turnId ? { turnId: state.turnId } : {}),
      generation: state.generation,
      phase: state.phase,
      ...(state.goal ? {
        goalCreatedAt: state.goal.createdAt,
        goalUpdatedAt: state.goal.updatedAt,
        goalStatus: state.goal.status,
      } : {}),
    };
    this.deps.store.setPendingPrompt({
      conversationId: state.scopeKey,
      scopeKey: state.scopeKey,
      promptMessageId: state.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: state.sessionKey,
      payloadJson: JSON.stringify(payload),
    });
  }

  private markFlushed(state: ActivityState, renderedRevision: number): void {
    if (state.revision === renderedRevision) state.dirtySince = undefined;
  }

  private isCurrent(state: ActivityState): boolean {
    return !state.invalidated && this.states.get(state.sessionKey) === state;
  }
}

interface ActivityRenderOptions {
  recentLimit: 0 | 1 | 2 | 3;
  reasoningRows: 1 | 2;
  planLimit: 1 | 3 | 5;
  errorRows: 1 | 2;
  sectionGaps: boolean;
}

interface RenderLine {
  text: string;
  bold?: boolean;
}

function isHiddenActivity(activity: AgentActivity): boolean {
  return activity.kind === "diff" || activity.kind === "notice" || activity.kind === "settings";
}

function isImmediate(activity: AgentActivity): boolean {
  return activity.kind === "goal"
    || activity.kind === "plan"
    || (activity.kind === "item" && (activity.category === "guardian" || activity.status === "failed"));
}

function isSyntheticTurnStarted(activity: Extract<AgentActivity, { kind: "item" }>): boolean {
  return activity.category === "other" && activity.label.trim().toLocaleLowerCase() === "turn started";
}

function renderActivity(state: ActivityState): RenderedTelegramText {
  const candidates: ActivityRenderOptions[] = [
    { recentLimit: 3, reasoningRows: 2, planLimit: 5, errorRows: 2, sectionGaps: true },
    { recentLimit: 2, reasoningRows: 2, planLimit: 5, errorRows: 2, sectionGaps: true },
    { recentLimit: 1, reasoningRows: 2, planLimit: 5, errorRows: 2, sectionGaps: true },
    { recentLimit: 0, reasoningRows: 2, planLimit: 5, errorRows: 2, sectionGaps: true },
    { recentLimit: 0, reasoningRows: 1, planLimit: 5, errorRows: 2, sectionGaps: true },
    { recentLimit: 0, reasoningRows: 1, planLimit: 3, errorRows: 2, sectionGaps: true },
    { recentLimit: 0, reasoningRows: 1, planLimit: 3, errorRows: 2, sectionGaps: false },
    { recentLimit: 0, reasoningRows: 1, planLimit: 1, errorRows: 2, sectionGaps: false },
    { recentLimit: 0, reasoningRows: 1, planLimit: 1, errorRows: 1, sectionGaps: false },
  ];
  let last = buildActivity(state, candidates.at(-1)!);
  for (const candidate of candidates) {
    const rendered = buildActivity(state, candidate);
    last = rendered;
    if (rendered.text.length <= ACTIVITY_MAX_CHARS && estimateImRows(rendered.text) <= ACTIVITY_MAX_ROWS) return rendered;
  }
  return last;
}

function buildActivity(state: ActivityState, options: ActivityRenderOptions): RenderedTelegramText {
  const lines: RenderLine[] = [
    { text: header(state), bold: true },
    { text: contextLine(state) },
    { text: goalLine(state.goal) },
  ];
  if (state.phaseDetail) lines.push({ text: truncateDisplay(normalizeText(state.phaseDetail), ACTIVITY_ROW_COLUMNS) });
  if (state.error) lines.push({ text: `Error · ${truncateDisplay(normalizeText(state.error), ACTIVITY_ROW_COLUMNS * options.errorRows - 8)}` });

  const reasoning = normalizeText(state.reasoning?.text ?? "");
  if (reasoning) appendSection(lines, options.sectionGaps, [
    { text: "Reasoning", bold: true },
    { text: truncateDisplay(reasoning, ACTIVITY_ROW_COLUMNS * options.reasoningRows) },
  ]);

  if (state.plan?.steps.length) appendSection(lines, options.sectionGaps, planLines(state.plan.steps, options.planLimit));

  const recentCount = state.itemTotal + state.fileCount;
  if (recentCount) appendSection(lines, options.sectionGaps, recentLines(state, options.recentLimit, recentCount));

  const parts: TelegramTextPart[] = [];
  lines.forEach((line, index) => {
    if (index) parts.push("\n");
    parts.push(line.bold ? { text: line.text, entity: "bold" } : line.text);
  });
  return renderTelegramText(parts);
}

function appendSection(lines: RenderLine[], sectionGaps: boolean, section: RenderLine[]): void {
  if (sectionGaps) lines.push({ text: "" });
  lines.push(...section);
}

function planLines(steps: AgentPlanStep[], limit: 1 | 3 | 5): RenderLine[] {
  const currentIndex = currentPlanIndex(steps);
  const start = Math.max(0, Math.min(currentIndex - Math.floor(limit / 2), steps.length - limit));
  const end = Math.min(steps.length, start + limit);
  const range = start === 0 && end === steps.length ? "" : ` · showing ${start + 1}–${end}`;
  const lines: RenderLine[] = [{ text: `Plan ${completedPlanCount(steps)}/${steps.length}${range}`, bold: true }];
  for (let index = start; index < end; index += 1) {
    const step = steps[index]!;
    lines.push({ text: `${planIcon(step.status)} ${truncateDisplay(normalizeText(step.step), ACTIVITY_ROW_COLUMNS - 2)}` });
  }
  return lines;
}

function recentLines(state: ActivityState, limit: 0 | 1 | 2 | 3, total: number): RenderLine[] {
  const lines: RenderLine[] = [{ text: `Recent activity · ${total}`, bold: true }];
  if (!limit) return lines;
  const entries: ActivityItemState[] = state.items.slice(-(state.fileCount ? Math.max(0, limit - 1) : limit));
  for (const item of entries) {
    const value = `${item.label}${item.detail ? ` · ${item.detail}` : ""}`;
    lines.push({ text: `${statusIcon(item.status)} ${truncateDisplay(normalizeText(value), ACTIVITY_ROW_COLUMNS - 2)}` });
  }
  if (state.fileCount) lines.push({ text: `✓ File changes (${state.fileCount})` });
  return lines;
}

function header(state: ActivityState): string {
  const phase: Record<ActivityPhase, [string, string]> = {
    idle: ["○", "Idle"],
    working: ["●", "Working"],
    stalled: ["!", "Stalled"],
    waitingForInput: ["●", "Waiting for input"],
    waitingForApproval: ["●", "Waiting for approval"],
    done: ["✓", "Completed"],
    interrupted: ["■", "Interrupted"],
    failed: ["×", "Failed"],
  };
  const [icon, label] = phase[state.phase];
  return `${icon} Codex · ${label}`;
}

function contextLine(state: ActivityState): string {
  const mode = modeLabel(state.mode, state.goalTurn);
  const duration = state.durationMs !== undefined
    ? formatDuration(state.durationMs)
    : state.startedAt !== undefined
      ? formatDuration(Date.now() - state.startedAt)
      : "unknown";
  const suffix = ` · Mode ${mode} · ${duration}`;
  const labelBudget = Math.max(4, ACTIVITY_ROW_COLUMNS - displayWidth("Chat ") - displayWidth(suffix));
  return `Chat ${truncateDisplay(threadLabel(state), labelBudget)}${suffix}`;
}

function threadLabel(state: ActivityState): string {
  const name = normalizeText(state.threadName ?? "");
  if (name) return name;
  if (state.threadId) return state.threadId.length <= 10 ? state.threadId : state.threadId.slice(0, 8);
  return "new";
}

function modeLabel(mode: AgentCollaborationMode, goalTurn: boolean): string {
  if (mode === "plan") return "Plan";
  return goalTurn ? "Goal" : "Default";
}

function goalLine(goal: AgentThreadGoal | null | undefined): string {
  if (goal === undefined) return "Goal Unknown";
  if (goal === null) return "Goal None";
  const prefix = `Goal ${goalStatusLabel(goal.status)}`;
  const budget = Math.max(0, ACTIVITY_ROW_COLUMNS - displayWidth(prefix) - 3);
  const objective = truncateDisplay(normalizeText(goal.objective), budget);
  return `${prefix}${objective ? ` · ${objective}` : ""}`;
}

function goalStatusLabel(status: AgentThreadGoal["status"]): string {
  switch (status) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "blocked": return "Blocked";
    case "usageLimited": return "Usage limited";
    case "budgetLimited": return "Budget limited";
    case "complete": return "Complete";
  }
}

function finalTranscriptSummary(state: ActivityState): string {
  const current = currentPlanStep(state.plan?.steps);
  return `[Activity ${state.phase}: ${state.itemTotal} item(s), ${state.fileCount} file change(s), ${completedPlanCount(state.plan?.steps)}/${state.plan?.steps.length ?? 0} plan steps${current ? `; current: ${truncateDisplay(normalizeText(current.step), 160)}` : ""}${state.error ? `; error: ${truncateDisplay(normalizeText(state.error), 300)}` : ""}]\n`;
}

function currentPlanIndex(steps: AgentPlanStep[]): number {
  const inProgress = steps.findIndex((step) => step.status === "inProgress");
  if (inProgress >= 0) return inProgress;
  const pending = steps.findIndex((step) => step.status === "pending");
  return pending >= 0 ? pending : Math.max(0, steps.length - 1);
}

function currentPlanStep(steps: AgentPlanStep[] | undefined): AgentPlanStep | undefined {
  return steps?.[currentPlanIndex(steps)];
}

function completedPlanCount(steps: AgentPlanStep[] | undefined): number {
  return steps?.filter((step) => step.status === "completed").length ?? 0;
}

function statusIcon(status: string): string {
  if (status === "completed") return "✓";
  if (status === "failed" || status === "declined") return "×";
  if (status === "warning") return "!";
  if (status === "interrupted") return "■";
  if (status === "pending") return "○";
  return "→";
}

function planIcon(status: AgentPlanStep["status"]): string {
  return status === "completed" ? "✓" : status === "inProgress" ? "→" : "○";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function truncateDisplay(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(value) <= maxWidth) return value;
  if (maxWidth === 1) return "…";
  let width = 0;
  let result = "";
  for (const character of value) {
    const next = characterWidth(character);
    if (width + next > maxWidth - 1) break;
    result += character;
    width += next;
  }
  return `${result}…`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function estimateImRows(text: string, columns = ACTIVITY_ROW_COLUMNS): number {
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += characterWidth(character);
  return width;
}

function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x200d || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
