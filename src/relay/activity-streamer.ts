import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import type { Logger } from "../domain/logger.ts";
import type {
  AgentActivity,
  AgentActivityEvent,
  AgentActivityFile,
  AgentCollaborationMode,
  AgentPlanStep,
  AgentThreadGoal,
  AgentTurnStatus,
} from "../ports/agent.ts";
import type { EditMessageTextOptions, SendMessageOptions } from "../ports/im.ts";
import { renderTelegramText, type RenderedTelegramText, type TelegramTextPart } from "../presentation/telegram/text.ts";
import type { RelayStore } from "../storage/store.ts";
import {
  ACTIVITY_ITEM_CHARS,
  ACTIVITY_ITEMS,
  ACTIVITY_MAX_CHARS,
  ACTIVITY_REASONING_CHARS,
  STREAM_MAX_MS,
  STREAM_QUIET_MS,
} from "./ui/constants.ts";

interface ActivityItemState {
  key: string;
  label: string;
  status: string;
  detail?: string;
}

interface ReasoningSection {
  text: string;
  order: number;
}

interface ActivityState {
  sessionKey: string;
  scopeKey: string;
  conversationId: ConversationId;
  workspaceName: string;
  turnId?: string;
  startedAt: number;
  lastFlushAt: number;
  mode: AgentCollaborationMode;
  goal: AgentThreadGoal | null | undefined;
  reasoningSections: Map<string, ReasoningSection>;
  nextReasoningOrder: number;
  plan?: { explanation?: string; steps: AgentPlanStep[] };
  items: ActivityItemState[];
  files: AgentActivityFile[];
  status: "working" | "done" | "interrupted" | "failed";
  error?: string;
  durationMs?: number;
  messageId?: MessageId;
  replyToMessageId?: MessageId;
  timer?: Timer;
  flushPromise?: Promise<void>;
  lastRendered?: string;
  sentOnce?: boolean;
}

export interface ActivityStreamerDeps {
  store: Pick<RelayStore, "deletePagedOutputsForSession" | "appendTranscript">;
  logger: Logger;
  canEdit: boolean;
  getReplyToMessageId(sessionKey: string): MessageId | undefined;
  getCollaborationMode(sessionKey: string): AgentCollaborationMode;
  getThreadGoal(sessionKey: string): AgentThreadGoal | null | undefined;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  timing?: { quietMs?: number; maxMs?: number };
}

export class ActivityStreamer {
  private readonly states = new Map<string, ActivityState>();
  private readonly quietMs: number;
  private readonly maxMs: number;

  constructor(private readonly deps: ActivityStreamerDeps) {
    this.quietMs = deps.timing?.quietMs ?? STREAM_QUIET_MS;
    this.maxMs = deps.timing?.maxMs ?? STREAM_MAX_MS;
  }

  async handle(event: AgentActivityEvent): Promise<void> {
    if (isHiddenActivity(event.activity)) return;
    const state = this.stateFor(event);
    if (!state) return;
    this.apply(state, event.activity, event.itemId);
    await this.schedule(state, isImmediate(event.activity));
  }

  async finalize(sessionKey: string, turnId: string | undefined, status: AgentTurnStatus, error?: string, durationMs?: number): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    if (turnId && state.turnId && turnId !== state.turnId) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.status = status === "completed" ? "done" : status === "interrupted" ? "interrupted" : "failed";
    state.error = error;
    state.durationMs = durationMs;
    await this.flush(state, true);
    this.deps.store.appendTranscript({
      conversationId: state.conversationId,
      scopeKey: state.scopeKey,
      workspaceName: state.workspaceName,
      role: "system",
      text: finalTranscriptSummary(state),
      createdAt: Date.now(),
    });
    this.states.delete(sessionKey);
  }

  async refreshContext(sessionKey: string): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    state.mode = this.deps.getCollaborationMode(sessionKey);
    const goal = this.deps.getThreadGoal(sessionKey);
    if (goal !== undefined) state.goal = goal;
    await this.flush(state, false);
  }

  clearSession(sessionKey: string, deletePages = true): void {
    const state = this.states.get(sessionKey);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(sessionKey);
    if (deletePages) this.deps.store.deletePagedOutputsForSession(sessionKey);
  }

  private stateFor(event: AgentActivityEvent): ActivityState | undefined {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) {
      this.deps.logger.warn("router.activity_invalid_session", { session_key: event.sessionKey });
      return undefined;
    }
    let state = this.states.get(event.sessionKey);
    if (state?.turnId && event.turnId && state.turnId !== event.turnId) {
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(event.sessionKey);
      state = undefined;
    }
    if (!state) {
      const now = Date.now();
      state = {
        sessionKey: event.sessionKey,
        scopeKey: parsed.scopeKey,
        conversationId: parsed.conversationId,
        workspaceName: parsed.workspaceName,
        turnId: event.turnId,
        startedAt: now,
        lastFlushAt: now,
        mode: this.deps.getCollaborationMode(event.sessionKey),
        goal: this.deps.getThreadGoal(event.sessionKey),
        reasoningSections: new Map(),
        nextReasoningOrder: 0,
        items: [],
        files: [],
        status: "working",
        replyToMessageId: this.deps.getReplyToMessageId(event.sessionKey),
      };
      this.states.set(event.sessionKey, state);
    } else if (!state.turnId && event.turnId) {
      state.turnId = event.turnId;
    }
    return state;
  }

  private apply(state: ActivityState, activity: AgentActivity, itemId?: string): void {
    switch (activity.kind) {
      case "reasoning": {
        const key = `${itemId ?? "reasoning"}:${activity.sectionIndex ?? 0}`;
        const existing = state.reasoningSections.get(key);
        if (existing) existing.text += activity.summary;
        else state.reasoningSections.set(key, { text: activity.summary, order: state.nextReasoningOrder++ });
        break;
      }
      case "plan":
        state.plan = { ...(activity.explanation ? { explanation: activity.explanation } : {}), steps: activity.steps };
        break;
      case "item": {
        const key = itemId ?? `${activity.category}:${activity.label}`;
        const existing = state.items.find((item) => item.key === key);
        const next: ActivityItemState = {
          key,
          label: activity.label,
          status: activity.status,
          ...(activity.detail ? { detail: activity.detail } : {}),
        };
        if (existing) Object.assign(existing, next);
        else state.items.push(next);
        for (const file of activity.files ?? []) upsertFile(state.files, file);
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

  private async schedule(state: ActivityState, immediate: boolean): Promise<void> {
    if (state.timer) clearTimeout(state.timer);
    if (immediate) {
      state.timer = undefined;
      await this.flush(state, false);
      return;
    }
    const untilMax = Math.max(0, this.maxMs - (Date.now() - state.lastFlushAt));
    const delay = Math.min(this.quietMs, untilMax);
    state.timer = setTimeout(() => void this.flush(state, false).catch((error) => {
      this.deps.logger.warn("router.activity_flush_failed", { session_key: state.sessionKey, error: error instanceof Error ? error : new Error(String(error)) });
    }), delay);
  }

  private async flush(state: ActivityState, final: boolean): Promise<void> {
    if (state.flushPromise) {
      await state.flushPromise;
      if (this.states.get(state.sessionKey) === state) await this.flush(state, final);
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
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    const currentGoal = this.deps.getThreadGoal(state.sessionKey);
    if (currentGoal !== undefined) state.goal = currentGoal;
    const rendered = renderActivity(state);
    if (!final && rendered.text === state.lastRendered) return;
    const emptyKeyboard = { inline_keyboard: [] };
    if (state.messageId && this.deps.canEdit) {
      try {
        await this.deps.editRendered(state.scopeKey, rendered, { messageId: state.messageId, replyMarkup: emptyKeyboard });
        state.lastRendered = rendered.text;
        state.lastFlushAt = Date.now();
        return;
      } catch (error) {
        this.deps.logger.warn("router.activity_edit_fallback", { session_key: state.sessionKey, message_id: state.messageId, error: error instanceof Error ? error : new Error(String(error)) });
      }
    } else if (state.sentOnce && !final) {
      return;
    }
    const result = await this.deps.sendRendered(state.scopeKey, rendered, {
      replyToMessageId: state.sentOnce ? undefined : state.replyToMessageId,
      replyMarkup: emptyKeyboard,
      disableWebPagePreview: true,
    });
    state.messageId = result.messageId;
    state.sentOnce = true;
    state.lastRendered = rendered.text;
    state.lastFlushAt = Date.now();
  }
}

type RecentMode = "items" | "count";
type PlanMode = "all" | "current" | "none";

interface ActivityRenderOptions {
  recentMode: RecentMode;
  recentLimit: number;
  recentChars: number;
  reasoningChars: number;
  goalChars: number;
  errorChars: number;
  planMode: PlanMode;
  planStepChars: number;
}

function isHiddenActivity(activity: AgentActivity): boolean {
  return activity.kind === "diff" || activity.kind === "notice" || activity.kind === "settings";
}

function isImmediate(activity: AgentActivity): boolean {
  return activity.kind === "item" && (activity.category === "guardian" || activity.status === "failed");
}

function upsertFile(files: AgentActivityFile[], file: AgentActivityFile): void {
  const existing = files.find((candidate) => candidate.path === file.path);
  if (existing) existing.kind = file.kind ?? existing.kind;
  else files.push(file);
}

function renderActivity(state: ActivityState): RenderedTelegramText {
  const options: ActivityRenderOptions = {
    recentMode: "items",
    recentLimit: ACTIVITY_ITEMS,
    recentChars: ACTIVITY_ITEM_CHARS,
    reasoningChars: ACTIVITY_REASONING_CHARS,
    goalChars: ACTIVITY_ITEM_CHARS,
    errorChars: 240,
    planMode: "all",
    planStepChars: ACTIVITY_ITEM_CHARS,
  };
  let rendered = buildActivity(state, options);
  if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;

  for (const recentLimit of [4, 3, 2, 1]) {
    options.recentLimit = recentLimit;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }
  for (const recentChars of [120, 80, 40]) {
    options.recentChars = recentChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }
  options.recentMode = "count";
  rendered = buildActivity(state, options);
  if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;

  for (const reasoningChars of [240, 160, 80, 40]) {
    options.reasoningChars = reasoningChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }
  for (const goalChars of [120, 80, 40, 0]) {
    options.goalChars = goalChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }
  for (const errorChars of [160, 80, 40]) {
    options.errorChars = errorChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }
  for (const planStepChars of [120, 80, 40, 16]) {
    options.planStepChars = planStepChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }

  const dynamicPlanChars = dynamicPlanStepBudget(state, options);
  if (dynamicPlanChars !== undefined) {
    options.planStepChars = dynamicPlanChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }

  options.planMode = "current";
  for (const planStepChars of [160, 80, 40, 16]) {
    options.planStepChars = planStepChars;
    rendered = buildActivity(state, options);
    if (rendered.text.length <= ACTIVITY_MAX_CHARS) return rendered;
  }

  options.reasoningChars = 24;
  options.errorChars = 24;
  options.planStepChars = 12;
  rendered = buildActivity(state, options);
  return rendered.text.length <= ACTIVITY_MAX_CHARS ? rendered : clipRendered(rendered, ACTIVITY_MAX_CHARS);
}

function dynamicPlanStepBudget(state: ActivityState, options: ActivityRenderOptions): number | undefined {
  const steps = state.plan?.steps ?? [];
  if (!steps.length) return undefined;
  const withoutPlan = buildActivity(state, { ...options, planMode: "none" }).text.length;
  const title = `Plan ${completedPlanCount(steps)}/${steps.length}`;
  const fixedPlanChars = 2 + title.length + steps.length * 3;
  const availableStepChars = ACTIVITY_MAX_CHARS - withoutPlan - fixedPlanChars;
  if (availableStepChars < steps.length) return undefined;
  return Math.max(1, Math.floor(availableStepChars / steps.length));
}

function buildActivity(state: ActivityState, options: ActivityRenderOptions): RenderedTelegramText {
  const parts: TelegramTextPart[] = [
    { text: header(state), entity: "bold" },
    "\n",
    `Mode ${modeLabel(state.mode)} · ${formatDuration(state.durationMs ?? Date.now() - state.startedAt)}`,
    "\n",
    goalLine(state.goal, options.goalChars),
  ];
  if (state.error) parts.push("\n", `Error · ${truncate(state.error.trim(), options.errorChars)}`);

  const reasoning = latestReasoning(state);
  if (reasoning) {
    parts.push("\n\n", { text: "Reasoning", entity: "bold" }, "\n", truncate(reasoning, options.reasoningChars));
  }

  appendPlan(parts, state.plan, options.planMode, options.planStepChars);
  appendRecentActivity(parts, state.items, options);
  return renderTelegramText(parts);
}

function appendPlan(parts: TelegramTextPart[], plan: ActivityState["plan"], mode: PlanMode, stepChars: number): void {
  if (!plan?.steps.length || mode === "none") return;
  parts.push("\n\n", { text: `Plan ${completedPlanCount(plan.steps)}/${plan.steps.length}`, entity: "bold" });
  const steps = mode === "current" ? [currentPlanStep(plan.steps)].filter(Boolean) as AgentPlanStep[] : plan.steps;
  for (const step of steps) parts.push("\n", `${planIcon(step.status)} ${truncate(step.step.trim(), stepChars)}`);
}

function appendRecentActivity(parts: TelegramTextPart[], items: ActivityItemState[], options: ActivityRenderOptions): void {
  if (!items.length) return;
  parts.push("\n\n", { text: "Recent activity", entity: "bold" });
  if (options.recentMode === "count") {
    parts.push("\n", `• ${items.length} activities`);
    return;
  }
  for (const item of items.slice(-options.recentLimit)) {
    const text = `${item.label}${item.detail ? ` · ${item.detail}` : ""}`;
    parts.push("\n", `${statusIcon(item.status)} ${truncate(text, options.recentChars)}`);
  }
}

function header(state: ActivityState): string {
  const icon = state.status === "working" ? "●" : state.status === "done" ? "✓" : state.status === "interrupted" ? "■" : "×";
  const label = state.status === "working" ? "Working" : state.status === "done" ? "Completed" : state.status === "interrupted" ? "Interrupted" : "Failed";
  return `${icon} Codex · ${label}`;
}

function modeLabel(mode: AgentCollaborationMode): string {
  return mode === "plan" ? "Plan" : "Default";
}

function goalLine(goal: AgentThreadGoal | null | undefined, objectiveChars: number): string {
  if (goal === undefined) return "Goal Unknown";
  if (goal === null) return "Goal None";
  const objective = truncate(goal.objective.trim(), objectiveChars);
  return `Goal ${goalStatusLabel(goal.status)}${objective ? ` · ${objective}` : ""}`;
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

function latestReasoning(state: ActivityState): string | undefined {
  let latest: ReasoningSection | undefined;
  for (const section of state.reasoningSections.values()) {
    if (!latest || section.order > latest.order) latest = section;
  }
  return latest?.text.trim() || undefined;
}

function finalTranscriptSummary(state: ActivityState): string {
  const current = currentPlanStep(state.plan?.steps);
  return `[Activity ${state.status}: ${state.items.length} item(s), ${state.files.length} file(s), ${completedPlanCount(state.plan?.steps)}/${state.plan?.steps.length ?? 0} plan steps${current ? `; current: ${truncate(current.step, 160)}` : ""}${state.error ? `; error: ${truncate(state.error, 300)}` : ""}]\n`;
}

function currentPlanStep(steps: AgentPlanStep[] | undefined): AgentPlanStep | undefined {
  return steps?.find((step) => step.status === "inProgress") ?? steps?.find((step) => step.status === "pending") ?? steps?.at(-1);
}

function completedPlanCount(steps: AgentPlanStep[] | undefined): number {
  return steps?.filter((step) => step.status === "completed").length ?? 0;
}

function statusIcon(status: string): string {
  return status === "completed" ? "✓" : status === "failed" || status === "declined" ? "×" : status === "warning" ? "!" : status === "interrupted" ? "■" : status === "pending" ? "○" : "→";
}

function planIcon(status: AgentPlanStep["status"]): string {
  return status === "completed" ? "✓" : status === "inProgress" ? "→" : "○";
}

function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function clipRendered(rendered: RenderedTelegramText, max: number): RenderedTelegramText {
  const text = rendered.text.slice(0, max);
  return {
    text,
    entities: rendered.entities.flatMap((entity) => {
      if (entity.offset >= text.length) return [];
      return [{ ...entity, length: Math.min(entity.length, text.length - entity.offset) }];
    }),
  };
}
