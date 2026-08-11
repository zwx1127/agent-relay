import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { AgentActivity, AgentSideConversationResult } from "../ports/agent.ts";
import type { EditMessageTextOptions, ImAdapter, InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import {
  renderCodexMarkdownForTelegram,
  splitRenderedForTelegram,
  type RenderedTelegramText,
} from "../presentation/telegram/text.ts";
import type { RelayStore } from "../storage/store.ts";
import { PAGE_MAX_CHARS, PAGED_OUTPUT_TTL_MS } from "./ui/constants.ts";
import { shortToken } from "./ui/callback-data.ts";
import { pagedOutputKeyboard } from "./ui/keyboards.ts";
import { decoratePagedOutput } from "./ui/pagination.ts";

const SIDE_CARD_FLUSH_MS = 500;

type SideConversationTerminalStatus = AgentSideConversationResult["status"];
type SideConversationPhase = "working" | SideConversationTerminalStatus;

interface SideConversationPresentationState {
  scopeKey: string;
  conversationId: ConversationId;
  sessionKey: string;
  question: string;
  answer: string;
  activity?: AgentActivity;
  phase: SideConversationPhase;
  sourceMessageIds: MessageId[];
  messageId?: MessageId;
  error?: string;
  pageToken?: string;
  startedAt: number;
  presented: boolean;
  editDisabled: boolean;
  terminal: boolean;
  finalFallbackSent: boolean;
  timer?: Timer;
  flushPromise?: Promise<void>;
}

export interface SideConversationPresenterDeps {
  store: Pick<RelayStore, "setPagedOutput" | "deletePagedOutput">;
  adapter: Pick<ImAdapter, "setMessageReaction">;
  logger: Logger;
  canEdit: boolean;
  sendRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options?: Omit<SendMessageOptions, "entities" | "parseMode">,
  ): Promise<{ messageId?: MessageId }>;
  editRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options: Omit<EditMessageTextOptions, "entities" | "parseMode">,
  ): Promise<void>;
}

export interface SideConversationPresentation {
  appendDelta(delta: string): void;
  appendInput(text: string, sourceMessageId?: MessageId): void;
  updateActivity(activity: AgentActivity): void;
  messageId(): MessageId | undefined;
  complete(result: AgentSideConversationResult): Promise<void>;
  fail(error: string): Promise<void>;
}

export class SideConversationPresenter {
  constructor(private readonly deps: SideConversationPresenterDeps) {}

  async begin(input: {
    conversationId: ConversationId;
    sessionKey: string;
    question: string;
    sourceMessageId?: MessageId;
    promptMessageId?: MessageId;
  }): Promise<SideConversationPresentation> {
    const scope = parseChatScopeKey(String(input.conversationId));
    const state: SideConversationPresentationState = {
      scopeKey: scope.scopeKey,
      conversationId: scope.conversationId,
      sessionKey: input.sessionKey,
      question: input.question,
      answer: "",
      phase: "working",
      sourceMessageIds: input.sourceMessageId === undefined ? [] : [input.sourceMessageId],
      messageId: input.promptMessageId,
      startedAt: Date.now(),
      presented: false,
      editDisabled: false,
      terminal: false,
      finalFallbackSent: false,
    };

    await this.setReaction(state, "🫡", "received", { isBig: true });
    await this.flush(state, false);
    await this.setReaction(state, "✍", "running");

    return {
      appendDelta: (delta) => this.appendDelta(state, delta),
      appendInput: (text, sourceMessageId) => {
        const normalized = text.trim();
        if (!normalized) return;
        state.question += `\n\nFollow-up: ${normalized}`;
        if (sourceMessageId !== undefined && !state.sourceMessageIds.some((id) => String(id) === String(sourceMessageId))) {
          state.sourceMessageIds.push(sourceMessageId);
          void this.setReactionForMessage(state, sourceMessageId, "✍", "running");
        }
        void this.flush(state, false);
      },
      updateActivity: (activity) => {
        if (state.terminal) return;
        state.activity = activity;
        void this.flush(state, false);
      },
      messageId: () => state.messageId,
      complete: async (result) => {
        if (state.terminal) return;
        state.terminal = true;
        state.phase = result.status;
        state.answer = result.message;
        state.error = result.error?.message;
        await this.flush(state, true);
        await this.setReaction(state, reactionForTerminal(result.status), result.status);
      },
      fail: async (error) => {
        if (state.terminal) return;
        state.terminal = true;
        state.phase = "failed";
        state.error = error;
        await this.flush(state, true);
        await this.setReaction(state, "😱", "failed");
      },
    };
  }

  private appendDelta(state: SideConversationPresentationState, delta: string): void {
    if (state.terminal || !delta) return;
    state.answer += delta;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flush(state, false);
    }, SIDE_CARD_FLUSH_MS);
  }

  private async flush(state: SideConversationPresentationState, final: boolean): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const previous = state.flushPromise ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      try {
        await this.flushOnce(state, final);
      } catch (error) {
        this.deps.logger.warn("router.side_conversation_card_failed", {
          conversation_id: state.conversationId,
          scope_key: state.scopeKey,
          session_key: state.sessionKey,
          phase: state.phase,
          error: asError(error),
        });
      }
    });
    state.flushPromise = current;
    await current;
    if (state.flushPromise === current) state.flushPromise = undefined;
  }

  private async flushOnce(state: SideConversationPresentationState, final: boolean): Promise<void> {
    const presentation = this.render(state, final);
    if (state.messageId !== undefined && this.deps.canEdit && !state.editDisabled) {
      try {
        await this.deps.editRendered(state.scopeKey, presentation.rendered, {
          messageId: state.messageId,
          ...(presentation.replyMarkup ? { replyMarkup: presentation.replyMarkup } : {}),
          disableWebPagePreview: true,
        });
        state.presented = true;
        return;
      } catch (error) {
        this.deps.logger.warn("router.side_conversation_edit_failed", {
          conversation_id: state.conversationId,
          scope_key: state.scopeKey,
          session_key: state.sessionKey,
          message_id: state.messageId,
          phase: state.phase,
          error: asError(error),
        });
        if (!state.presented) state.messageId = undefined;
        else state.editDisabled = true;
      }
    } else if (state.messageId !== undefined && !state.presented) {
      state.messageId = undefined;
    }

    if (state.presented && !final) return;
    if (final && state.finalFallbackSent) return;
    try {
      const result = await this.deps.sendRendered(state.scopeKey, presentation.rendered, {
        ...(!state.presented && state.sourceMessageIds[0] !== undefined ? { replyToMessageId: state.sourceMessageIds[0] } : {}),
        ...(presentation.replyMarkup ? { replyMarkup: presentation.replyMarkup } : {}),
        disableWebPagePreview: true,
        deliveryMode: "at-most-once",
      });
      state.messageId = result.messageId;
      state.presented = true;
      state.editDisabled = false;
      if (final) state.finalFallbackSent = true;
    } catch (error) {
      state.presented = true;
      if (final) state.finalFallbackSent = true;
      this.deps.logger.warn("router.side_conversation_send_failed", {
        conversation_id: state.conversationId,
        scope_key: state.scopeKey,
        session_key: state.sessionKey,
        phase: state.phase,
        error: asError(error),
      });
    }
  }

  private render(state: SideConversationPresentationState, final: boolean): {
    rendered: RenderedTelegramText;
    replyMarkup?: InlineKeyboardMarkup;
  } {
    const markdown = sideConversationMarkdown(state);
    const rendered = renderCodexMarkdownForTelegram(markdown);
    const pages = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    if (pages.length <= 1) {
      const replyMarkup = state.pageToken ? { inline_keyboard: [] } : undefined;
      if (state.pageToken) {
        this.deps.store.deletePagedOutput(state.pageToken);
        state.pageToken = undefined;
      }
      return { rendered: pages[0] ?? rendered, ...(replyMarkup ? { replyMarkup } : {}) };
    }

    const token = state.pageToken ?? shortToken();
    state.pageToken = token;
    this.deps.store.setPagedOutput({
      token,
      scopeKey: state.scopeKey,
      conversationId: state.conversationId,
      sessionKey: state.sessionKey,
      text: markdown,
      createdAt: state.startedAt,
      expiresAt: Date.now() + PAGED_OUTPUT_TTL_MS,
    });
    const pageIndex = final ? 0 : pages.length - 1;
    return {
      rendered: decoratePagedOutput(pages[pageIndex]!, pageIndex, pages.length),
      replyMarkup: pagedOutputKeyboard(token, pageIndex, pages.length),
    };
  }

  private async setReaction(
    state: SideConversationPresentationState,
    emoji: string,
    phase: "received" | "running" | SideConversationTerminalStatus,
    options?: { isBig?: boolean },
  ): Promise<void> {
    if (!this.deps.adapter.setMessageReaction) return;
    for (const messageId of state.sourceMessageIds) {
      await this.setReactionForMessage(state, messageId, emoji, phase, options);
    }
  }

  private async setReactionForMessage(
    state: SideConversationPresentationState,
    messageId: MessageId,
    emoji: string,
    phase: "received" | "running" | SideConversationTerminalStatus,
    options?: { isBig?: boolean },
  ): Promise<void> {
    if (!this.deps.adapter.setMessageReaction) return;
    try {
      await this.deps.adapter.setMessageReaction(state.conversationId, messageId, emoji, options);
      this.deps.logger.info("router.side_conversation_reaction_applied", {
        conversation_id: state.conversationId,
        scope_key: state.scopeKey,
        session_key: state.sessionKey,
        message_id: messageId,
        emoji,
        phase,
      });
    } catch (error) {
      this.deps.logger.warn("router.side_conversation_reaction_failed", {
        conversation_id: state.conversationId,
        scope_key: state.scopeKey,
        session_key: state.sessionKey,
        message_id: messageId,
        emoji,
        phase,
        error: asError(error),
      });
    }
  }
}

function sideConversationMarkdown(state: SideConversationPresentationState): string {
  const status = sideConversationStatusLabel(state.phase);
  return [
    "**Side conversation**",
    `**Question:** ${state.question}`,
    state.activity ? `**Activity:** ${sideActivityLabel(state.activity)}` : undefined,
    state.answer ? `**Answer:**\n${state.answer}` : undefined,
    state.error && state.error !== state.answer ? `**Error:** ${state.error}` : undefined,
    `**Status:** ${status}`,
  ].filter((section): section is string => Boolean(section)).join("\n\n");
}

function sideActivityLabel(activity: AgentActivity): string {
  switch (activity.kind) {
    case "reasoning": return activity.summary;
    case "plan": return activity.explanation ?? `${activity.steps.filter((step) => step.status === "completed").length}/${activity.steps.length} plan steps complete`;
    case "diff": return "Changes updated";
    case "item": return `${activity.label} · ${activity.status}`;
    case "notice": return activity.detail ? `${activity.title}: ${activity.detail}` : activity.title;
    case "goal": return activity.goal?.objective ?? "Goal cleared";
    case "settings": return "Settings updated";
  }
}

function sideConversationStatusLabel(phase: SideConversationPhase): string {
  switch (phase) {
    case "working": return "Working";
    case "completed": return "Completed";
    case "interrupted": return "Interrupted";
    case "failed": return "Failed";
  }
}

function reactionForTerminal(status: SideConversationTerminalStatus): string {
  switch (status) {
    case "completed": return "😎";
    case "interrupted": return "🤨";
    case "failed": return "😱";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
