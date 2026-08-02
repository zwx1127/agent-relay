import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import type { Logger } from "../domain/logger.ts";
import type { AgentActivity, AgentActivityEvent, AgentActivityFile, AgentPlanStep, AgentTurnStatus } from "../ports/agent.ts";
import type { EditMessageTextOptions, SendMessageOptions } from "../ports/im.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RelayStore } from "../storage/store.ts";
import { shortToken } from "./ui/callback-data.ts";
import { activityDetailsKeyboard } from "./ui/keyboards.ts";
import {
  ACTIVITY_FILES,
  ACTIVITY_ITEM_CHARS,
  ACTIVITY_ITEMS,
  ACTIVITY_MAX_CHARS,
  ACTIVITY_PATH_CHARS,
  ACTIVITY_PLAN_STEPS,
  ACTIVITY_REASONING_CHARS,
  PAGED_OUTPUT_TTL_MS,
  STREAM_MAX_MS,
  STREAM_QUIET_MS,
} from "./ui/constants.ts";
import { textMessage } from "./ui/text-parts.ts";

interface ActivityItemState {
  key: string;
  label: string;
  category: string;
  status: string;
  detail?: string;
  durationMs?: number;
}

interface ActivityState {
  sessionKey: string;
  scopeKey: string;
  conversationId: ConversationId;
  workspaceName: string;
  turnId?: string;
  startedAt: number;
  lastFlushAt: number;
  reasoning: string;
  plan?: { explanation?: string; steps: AgentPlanStep[] };
  items: ActivityItemState[];
  files: AgentActivityFile[];
  notices: Array<{ level: string; title: string; detail?: string }>;
  diff?: string;
  goalText?: string;
  settings: string[];
  status: "working" | "done" | "interrupted" | "failed";
  error?: string;
  durationMs?: number;
  messageId?: MessageId;
  replyToMessageId?: MessageId;
  detailsToken?: string;
  diffToken?: string;
  timer?: Timer;
  flushPromise?: Promise<void>;
  lastRendered?: string;
  sentOnce?: boolean;
}

export interface ActivityStreamerDeps {
  store: Pick<RelayStore, "setPagedOutput" | "deletePagedOutputsForSession" | "appendTranscript">;
  logger: Logger;
  canEdit: boolean;
  getReplyToMessageId(sessionKey: string): MessageId | undefined;
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
    const state = this.stateFor(event);
    if (!state) return;
    this.apply(state, event.activity, event.itemId);
    const immediate = isImmediate(event.activity);
    await this.schedule(state, immediate);
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
    const summary = finalTranscriptSummary(state);
    this.deps.store.appendTranscript({
      conversationId: state.conversationId,
      scopeKey: state.scopeKey,
      workspaceName: state.workspaceName,
      role: "system",
      text: summary,
      createdAt: Date.now(),
    });
    this.states.delete(sessionKey);
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
        reasoning: "",
        items: [],
        files: [],
        notices: [],
        settings: [],
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
      case "reasoning":
        state.reasoning += activity.summary;
        break;
      case "plan":
        state.plan = { ...(activity.explanation ? { explanation: activity.explanation } : {}), steps: activity.steps };
        break;
      case "diff":
        state.diff = activity.diff;
        break;
      case "item": {
        const key = itemId ?? `${activity.category}:${activity.label}`;
        const existing = state.items.find((item) => item.key === key);
        const next: ActivityItemState = {
          key,
          label: activity.label,
          category: activity.category,
          status: activity.status,
          ...(activity.detail ? { detail: activity.detail } : {}),
          ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
        };
        if (existing) Object.assign(existing, next);
        else state.items.push(next);
        for (const file of activity.files ?? []) upsertFile(state.files, file);
        break;
      }
      case "notice":
        if (!state.notices.some((notice) => notice.level === activity.level && notice.title === activity.title && notice.detail === activity.detail)) {
          state.notices.push(activity);
        }
        break;
      case "goal":
        state.goalText = activity.goal ? `${activity.goal.status}: ${activity.goal.objective}` : "cleared";
        break;
      case "settings":
        for (const [name, value] of Object.entries(activity.changes)) {
          const setting = `${name}: ${value}`;
          const existing = state.settings.findIndex((candidate) => candidate.startsWith(`${name}: `));
          if (existing >= 0) state.settings[existing] = setting;
          else state.settings.push(setting);
        }
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
    const { text, details, overflow } = renderActivity(state);
    if (!final && text === state.lastRendered) return;
    if (overflow) {
      state.detailsToken ??= shortToken();
      this.savePage(state, state.detailsToken, details);
    }
    if (state.diff) {
      state.diffToken ??= shortToken();
      this.savePage(state, state.diffToken, state.diff);
    }
    const keyboard = activityDetailsKeyboard(overflow ? state.detailsToken : undefined, state.diff ? state.diffToken : undefined);
    const rendered = textMessage(text);
    if (state.messageId && this.deps.canEdit) {
      try {
        await this.deps.editRendered(state.scopeKey, rendered, { messageId: state.messageId, replyMarkup: keyboard });
        state.lastRendered = text;
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
      replyMarkup: keyboard,
      disableWebPagePreview: true,
    });
    state.messageId = result.messageId;
    state.sentOnce = true;
    state.lastRendered = text;
    state.lastFlushAt = Date.now();
  }

  private savePage(state: ActivityState, token: string, text: string): void {
    this.deps.store.setPagedOutput({
      token,
      scopeKey: state.scopeKey,
      conversationId: state.conversationId,
      sessionKey: state.sessionKey,
      text,
      createdAt: state.startedAt,
      expiresAt: Date.now() + PAGED_OUTPUT_TTL_MS,
    });
  }
}

function isImmediate(activity: AgentActivity): boolean {
  return activity.kind === "notice" && activity.level !== "info"
    || activity.kind === "item" && (activity.category === "guardian" || activity.status === "failed");
}

function upsertFile(files: AgentActivityFile[], file: AgentActivityFile): void {
  const existing = files.find((candidate) => candidate.path === file.path);
  if (existing) existing.kind = file.kind ?? existing.kind;
  else files.push(file);
}

function renderActivity(state: ActivityState): { text: string; details: string; overflow: boolean } {
  const details = detailText(state);
  const normal = cardText(state, { fileLimit: ACTIVITY_FILES, itemLimit: ACTIVITY_ITEMS, planMode: "normal" });
  if (normal.length <= ACTIVITY_MAX_CHARS) return { text: normal, details, overflow: hasDetailOverflow(state) };
  const fewerFiles = cardText(state, { fileLimit: 4, itemLimit: ACTIVITY_ITEMS, planMode: "normal" });
  if (fewerFiles.length <= ACTIVITY_MAX_CHARS) return { text: fewerFiles, details, overflow: true };
  const fewerItems = cardText(state, { fileLimit: 4, itemLimit: 3, planMode: "normal" });
  if (fewerItems.length <= ACTIVITY_MAX_CHARS) return { text: fewerItems, details, overflow: true };
  const currentPlan = cardText(state, { fileLimit: 4, itemLimit: 3, planMode: "current" });
  if (currentPlan.length <= ACTIVITY_MAX_CHARS) return { text: currentPlan, details, overflow: true };
  return { text: minimalCardText(state).slice(0, ACTIVITY_MAX_CHARS), details, overflow: true };
}

function hasDetailOverflow(state: ActivityState): boolean {
  return state.reasoning.trim().length > ACTIVITY_REASONING_CHARS
    || (state.plan?.steps.length ?? 0) > ACTIVITY_PLAN_STEPS
    || state.plan?.steps.some((step) => step.step.length > ACTIVITY_ITEM_CHARS) === true
    || state.items.length > ACTIVITY_ITEMS
    || state.items.some((item) => `${item.label}${item.detail ? ` — ${item.detail}` : ""}`.length > ACTIVITY_ITEM_CHARS)
    || state.files.length > ACTIVITY_FILES
    || state.files.some((file) => file.path.length > ACTIVITY_PATH_CHARS)
    || state.notices.length > 3
    || (state.goalText?.length ?? 0) > ACTIVITY_ITEM_CHARS
    || state.settings.length > 3
    || state.settings.some((setting) => setting.length > ACTIVITY_ITEM_CHARS);
}

function cardText(state: ActivityState, options: { fileLimit: number; itemLimit: number; planMode: "normal" | "current" }): string {
  const lines = [header(state)];
  appendNotices(lines, state);
  appendGoalAndSettings(lines, state);
  if (state.reasoning.trim()) lines.push("", "Reasoning", truncate(state.reasoning.trim(), ACTIVITY_REASONING_CHARS));
  appendPlan(lines, state.plan, options.planMode);
  const items = state.items.slice(-options.itemLimit);
  if (items.length) {
    lines.push("", "Recent activity");
    for (const item of items) lines.push(`• ${statusIcon(item.status)} ${truncate(item.label + (item.detail ? ` — ${item.detail}` : ""), ACTIVITY_ITEM_CHARS)}`);
  }
  const files = state.files.slice(-options.fileLimit);
  if (files.length) {
    lines.push("", "Files");
    for (const file of files) lines.push(`• ${middleTruncate(file.path, ACTIVITY_PATH_CHARS)}${file.kind ? ` (${file.kind})` : ""}`);
  }
  appendMeta(lines, state);
  return lines.join("\n");
}

function detailText(state: ActivityState): string {
  const lines = [header(state)];
  appendNotices(lines, state, false);
  if (state.reasoning.trim()) lines.push("", "Reasoning summary", state.reasoning.trim());
  appendPlan(lines, state.plan, "all");
  if (state.items.length) {
    lines.push("", "Activity");
    for (const item of state.items) lines.push(`• ${statusIcon(item.status)} ${item.label}${item.detail ? ` — ${item.detail}` : ""}${item.durationMs !== undefined ? ` (${formatDuration(item.durationMs)})` : ""}`);
  }
  if (state.files.length) {
    lines.push("", "Files");
    for (const file of state.files) lines.push(`• ${file.path}${file.kind ? ` (${file.kind})` : ""}`);
  }
  if (state.goalText) lines.push("", `Goal: ${state.goalText}`);
  if (state.settings.length) lines.push("", "Settings", ...state.settings.map((setting) => `• ${setting}`));
  appendMeta(lines, state);
  return lines.join("\n");
}

function minimalCardText(state: ActivityState): string {
  const lines = [header(state)];
  appendNotices(lines, state);
  const current = currentPlanStep(state.plan?.steps);
  if (current) lines.push("", `Current: ${truncate(current.step, ACTIVITY_ITEM_CHARS)}`);
  lines.push("", `Activity ${state.items.length} · Files ${state.files.length} · Plan ${completedPlanCount(state.plan?.steps)}/${state.plan?.steps.length ?? 0}`);
  return lines.join("\n");
}

function header(state: ActivityState): string {
  const label = state.status === "working" ? "Working" : state.status === "done" ? "Completed" : state.status === "interrupted" ? "Interrupted" : "Failed";
  return `Codex activity · ${label}`;
}

function appendNotices(lines: string[], state: ActivityState, truncateValues = true): void {
  if (state.error) lines.push("", `Error: ${truncateValues ? truncate(state.error, 500) : state.error}`);
  for (const notice of state.notices.filter((entry) => entry.level !== "info").slice(-3)) {
    const value = `${notice.title}${notice.detail ? ` — ${notice.detail}` : ""}`;
    lines.push("", `${notice.level === "error" ? "Error" : "Warning"}: ${truncateValues ? truncate(value, 500) : value}`);
  }
}

function appendGoalAndSettings(lines: string[], state: ActivityState): void {
  if (state.goalText) lines.push("", `Goal: ${truncate(state.goalText, ACTIVITY_ITEM_CHARS)}`);
  if (state.settings.length) {
    lines.push("", "Settings");
    for (const setting of state.settings.slice(-3)) lines.push(`- ${truncate(setting, ACTIVITY_ITEM_CHARS)}`);
  }
}

function appendPlan(lines: string[], plan: ActivityState["plan"], mode: "normal" | "current" | "all"): void {
  if (!plan?.steps.length) return;
  lines.push("", `Plan · ${completedPlanCount(plan.steps)}/${plan.steps.length}`);
  const steps = mode === "current" ? [currentPlanStep(plan.steps)].filter(Boolean) as AgentPlanStep[] : mode === "all" ? plan.steps : plan.steps.slice(0, ACTIVITY_PLAN_STEPS);
  for (const step of steps) lines.push(`${planIcon(step.status)} ${mode === "all" ? step.step : truncate(step.step, ACTIVITY_ITEM_CHARS)}`);
  if (mode === "normal" && plan.steps.length > steps.length) lines.push(`… ${plan.steps.length - steps.length} more step(s)`);
}

function appendMeta(lines: string[], state: ActivityState): void {
  if (state.status !== "working" || state.durationMs !== undefined) lines.push("", `Duration: ${formatDuration(state.durationMs ?? Date.now() - state.startedAt)}`);
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
  return status === "completed" ? "✓" : status === "failed" || status === "declined" ? "✕" : status === "warning" ? "!" : status === "interrupted" ? "■" : "•";
}

function planIcon(status: AgentPlanStep["status"]): string {
  return status === "completed" ? "✓" : status === "inProgress" ? "→" : "○";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const left = Math.ceil((max - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - (max - 1 - left))}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}
