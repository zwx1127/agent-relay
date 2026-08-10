import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import type { InlineKeyboardMarkup, InboundMessage, SendMessageOptions, EditMessageTextOptions } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import { renderCodexMarkdownForTelegram, splitRenderedForTelegram, type RenderedTelegramText } from "../presentation/telegram/text.ts";
import { PAGE_MAX_CHARS, PAGED_OUTPUT_TTL_MS, STREAM_FLUSH_CHARS, STREAM_MAX_MS, STREAM_QUIET_MS } from "./ui/constants.ts";
import { shortToken } from "./ui/callback-data.ts";
import { pagedOutputKeyboard } from "./ui/keyboards.ts";
import { decoratePagedOutput } from "./ui/pagination.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import type { LiveOutputState, RenderCallbackPageResult, StreamTiming } from "./controller-types.ts";
import { parseChatScopeKey } from "../domain/scope.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface OutputStreamerDeps {
  store: Pick<RelayStore, "setPagedOutput" | "getPagedOutput" | "deletePagedOutput">;
  logger: Logger;
  getReplyToMessageId(sessionKey: string): MessageId | undefined;
  onMessageRendered?(sessionKey: string, turnId: string | undefined, messageId: MessageId): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  timing?: Partial<StreamTiming>;
}

export class OutputStreamer {
  private readonly liveOutput = new Map<string, LiveOutputState>();
  private nextOutputSegmentId = 1;
  private readonly timing: StreamTiming;

  constructor(private readonly deps: OutputStreamerDeps) {
    this.timing = {
      quietMs: deps.timing?.quietMs ?? STREAM_QUIET_MS,
      maxMs: deps.timing?.maxMs ?? STREAM_MAX_MS,
      flushChars: deps.timing?.flushChars ?? STREAM_FLUSH_CHARS,
    };
  }

  async buffer(sessionKeyValue: string, conversationId: ConversationId, chunk: string, turnId?: string): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    let state = this.liveOutput.get(sessionKeyValue);
    if (state?.turnId && turnId && state.turnId !== turnId) {
      await this.finalize(sessionKeyValue);
      state = undefined;
    }
    if (!state) {
      state = {
        conversationId: scope.scopeKey,
        text: "",
        startedAt: Date.now(),
        segmentId: this.nextOutputSegmentId++,
        turnId,
        replyToMessageId: this.deps.getReplyToMessageId(sessionKeyValue),
      };
      this.liveOutput.set(sessionKeyValue, state);
    } else if (!state.turnId && turnId) {
      state.turnId = turnId;
    }
    const outputState = state;

    outputState.text += chunk;
    this.deps.logger.debug("router.agent_output_buffered", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      session_key: sessionKeyValue,
      chunk_len: chunk.length,
      buffered_len: outputState.text.length,
    });

    if (outputState.timer) clearTimeout(outputState.timer);
    const elapsed = Date.now() - outputState.startedAt;
    const delay = outputState.text.length >= this.timing.flushChars || elapsed >= this.timing.maxMs ? 0 : this.timing.quietMs;
    const segmentId = outputState.segmentId;
    outputState.timer = setTimeout(() => {
      void this.flush(sessionKeyValue, segmentId).catch((error) => {
        this.deps.logger.error("router.agent_output_send_failed", {
        conversation_id: scope.conversationId,
        scope_key: scope.scopeKey,
          session_key: sessionKeyValue,
          text_len: state?.text.length ?? 0,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }, delay);
  }

  async finalize(sessionKeyValue: string): Promise<void> {
    const state = this.liveOutput.get(sessionKeyValue);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state && (state.text !== state.lastFlushedText || state.pageToken)) {
      await this.flush(sessionKeyValue, undefined, true);
    }
    const current = this.liveOutput.get(sessionKeyValue);
    if (current?.timer) clearTimeout(current.timer);
    this.liveOutput.delete(sessionKeyValue);
    if (state?.timer) clearTimeout(state.timer);
  }

  private markFlushed(sessionKeyValue: string, text: string): void {
    const state = this.liveOutput.get(sessionKeyValue);
    if (state) state.lastFlushedText = text;
  }

  private async flush(sessionKeyValue: string, expectedSegmentId?: number, final = false): Promise<void> {
    let state = this.liveOutput.get(sessionKeyValue);
    if (!state || state.text.length === 0) return;
    if (expectedSegmentId !== undefined && state.segmentId !== expectedSegmentId) return;

    if (state.flushPromise) {
      await state.flushPromise;
      state = this.liveOutput.get(sessionKeyValue);
      if (!state || state.text.length === 0) return;
      if (expectedSegmentId !== undefined && state.segmentId !== expectedSegmentId) return;
      if (state.text === state.lastFlushedText && !(final && state.pageToken && !state.finalPageRendered)) return;
      await this.flush(sessionKeyValue, expectedSegmentId, final);
      return;
    }

    if (state.text === state.lastFlushedText && !(final && state.pageToken && !state.finalPageRendered)) return;
    const flushPromise = this.flushOnce(sessionKeyValue, state, final);
    state.flushPromise = flushPromise;
    try {
      await flushPromise;
    } finally {
      const current = this.liveOutput.get(sessionKeyValue);
      if (current?.flushPromise === flushPromise) current.flushPromise = undefined;
    }
  }

  private async flushOnce(sessionKeyValue: string, state: LiveOutputState, final: boolean): Promise<void> {
    if (state?.timer) clearTimeout(state.timer);
    state.timer = undefined;

    const snapshotText = state.text;
    const rendered = renderCodexMarkdownForTelegram(snapshotText);
    const chunks = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    this.deps.logger.debug("router.agent_output_flushed", {
      conversation_id: parseChatScopeKey(String(state.conversationId)).conversationId,
      scope_key: state.conversationId,
      session_key: sessionKeyValue,
      text_len: snapshotText.length,
      chunks: chunks.length,
    });

    if (chunks.length === 1 && rendered.text.length < this.timing.flushChars) {
      const chunk = chunks[0]!;
      if (state.messageId) {
        try {
          await this.deps.editRendered(state.conversationId, chunk, {
            messageId: state.messageId,
            disableWebPagePreview: true,
          });
          this.markFlushed(sessionKeyValue, snapshotText);
          this.deps.onMessageRendered?.(sessionKeyValue, state.turnId, state.messageId);
          state.finalPageRendered = false;
          return;
        } catch (error) {
          this.deps.logger.warn("router.agent_output_edit_fallback", {
            conversation_id: state.conversationId,
            message_id: state.messageId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.deps.sendRendered(state.conversationId, chunk, {
        replyToMessageId: state.replyToMessageId,
        disableWebPagePreview: true,
      });
      state.messageId = result.messageId;
      if (result.messageId !== undefined) this.deps.onMessageRendered?.(sessionKeyValue, state.turnId, result.messageId);
      this.markFlushed(sessionKeyValue, snapshotText);
      state.finalPageRendered = false;
      return;
    }

    if (chunks.length > 1) {
      const token = state.pageToken ?? shortToken();
      state.pageToken = token;
      this.deps.store.setPagedOutput({
        token,
        scopeKey: String(state.conversationId),
        conversationId: parseChatScopeKey(String(state.conversationId)).conversationId,
        sessionKey: sessionKeyValue,
        text: snapshotText,
        createdAt: state.startedAt,
        expiresAt: Date.now() + PAGED_OUTPUT_TTL_MS,
      });
      const pageIndex = final ? 0 : chunks.length - 1;
      const page = decoratePagedOutput(chunks[pageIndex]!, pageIndex, chunks.length);
      const replyMarkup = pagedOutputKeyboard(token, pageIndex, chunks.length);
      if (state.messageId) {
        try {
          await this.deps.editRendered(state.conversationId, page, {
            messageId: state.messageId,
            replyMarkup,
            disableWebPagePreview: true,
          });
          this.markFlushed(sessionKeyValue, snapshotText);
          this.deps.onMessageRendered?.(sessionKeyValue, state.turnId, state.messageId);
          state.finalPageRendered = final;
          return;
        } catch (error) {
          this.deps.logger.warn("router.agent_output_edit_fallback", {
            conversation_id: state.conversationId,
            message_id: state.messageId,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
      const result = await this.deps.sendRendered(state.conversationId, page, {
        replyToMessageId: state.replyToMessageId,
        replyMarkup,
        disableWebPagePreview: true,
      });
      state.messageId = result.messageId;
      if (result.messageId !== undefined) this.deps.onMessageRendered?.(sessionKeyValue, state.turnId, result.messageId);
      this.markFlushed(sessionKeyValue, snapshotText);
      state.finalPageRendered = final;
    }
  }

  async renderPagedOutputCallback(message: CallbackMessage, payload: string): Promise<void> {
    const [, token, rawPage] = payload.split(":");
    const pageIndex = Number(rawPage);
    const output = token ? this.deps.store.getPagedOutput(token) : undefined;
    const callbackScope = parseChatScopeKey(String(message.conversationId));
    if (!output || String(output.scopeKey ?? output.conversationId) !== callbackScope.scopeKey || output.expiresAt < Date.now()) {
      if (token) this.deps.store.deletePagedOutput(token);
      await this.deps.renderCallbackPage(message, messageWithTitle("Page expired."), { inline_keyboard: [] });
      return;
    }
    const pageToken = output.token;
    const rendered = renderCodexMarkdownForTelegram(output.text);
    const pages = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) {
      await this.deps.renderCallbackPage(message, messageWithTitle("Page unavailable."), pagedOutputKeyboard(pageToken, pages.length - 1, pages.length));
      return;
    }
    const page = decoratePagedOutput(pages[pageIndex]!, pageIndex, pages.length);
    const replyMarkup = pagedOutputKeyboard(pageToken, pageIndex, pages.length);
    if (!message.messageId) {
      await this.deps.sendRendered(message.conversationId, page, {
        replyMarkup,
        disableWebPagePreview: true,
      });
      return;
    }
    try {
      await this.deps.editRendered(message.conversationId, page, {
        messageId: message.messageId,
        replyMarkup,
        disableWebPagePreview: true,
      });
    } catch (error) {
      this.deps.logger.warn("router.paged_output_edit_fallback", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.deps.sendRendered(message.conversationId, page, {
        replyMarkup,
        disableWebPagePreview: true,
      });
    }
  }
}
