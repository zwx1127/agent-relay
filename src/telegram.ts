import type { ChatId, EditMessageTextOptions, IMAdapter, InboundMessage, SendMessageOptions } from "./types.ts";
import { splitForTelegram, splitHtmlForTelegram, splitRenderedForTelegram } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => Promise<Response>;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string | undefined,
  ) {
    super(
      description
        ? `Telegram ${method} failed with HTTP ${status}: ${description}`
        : `Telegram ${method} failed with HTTP ${status}`,
    );
    this.name = "TelegramApiError";
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: {
      message_id: number;
      date?: number;
      chat: { id: number };
    };
  };
}

const ALLOWED_UPDATES = ["message", "callback_query"] as const;

export class TelegramAdapter implements IMAdapter {
  private offset = 0;
  private stopped = false;
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger: Logger = noopLogger,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  stop(): void {
    this.stopped = true;
    this.logger.info("telegram.polling_stop_requested");
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.logger.info("telegram.polling_started");
    await this.skipPendingUpdates();
    while (!this.stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.request<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ALLOWED_UPDATES,
        });
      } catch (error) {
        this.logger.error("telegram.polling_failed", { error: error instanceof Error ? error : new Error(String(error)) });
        throw error;
      }
      if (updates.length > 0) {
        this.logger.debug("telegram.updates_received", { count: updates.length, offset: this.offset });
      }
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const inbound = this.toInboundMessage(update);
        if (!inbound) {
          this.logger.debug("telegram.update_ignored", {
            update_id: update.update_id,
            has_message: Boolean(update.message),
            has_text: Boolean(update.message?.text),
            has_from: Boolean(update.message?.from || update.callback_query?.from),
            has_callback_query: Boolean(update.callback_query),
            has_callback_data: Boolean(update.callback_query?.data),
          });
          continue;
        }
        this.logger.debug(inbound.kind === "message" ? "telegram.message_received" : "telegram.callback_query_received", {
          update_id: update.update_id,
          message_id: inbound.kind === "message" ? inbound.id : inbound.messageId,
          chat_id: inbound.chatId,
          user_id: inbound.userId,
          kind: inbound.kind,
          text_len: inbound.kind === "message" ? inbound.text.length : inbound.data.length,
          message_text: inbound.kind === "message" ? inbound.text : inbound.data,
        });
        await onMessage(inbound);
      }
    }
    this.logger.info("telegram.polling_stopped");
  }

  private async skipPendingUpdates(): Promise<void> {
    const updates = await this.request<TelegramUpdate[]>("getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: ALLOWED_UPDATES,
    });
    const lastUpdate = updates.at(-1);
    if (!lastUpdate) return;

    this.offset = lastUpdate.update_id + 1;
    this.logger.info("telegram.pending_updates_skipped", { offset: this.offset });
  }

  async sendMessage(chatId: ChatId, text: string, options: SendMessageOptions = {}): Promise<{ messageId?: number }> {
    const messageText = text.length > 0 ? text : "(empty)";
    const chunks = outboundChunks(messageText, options);
    this.logger.debug("telegram.send_message_started", { chat_id: chatId, text_len: text.length, chunks: chunks.length });
    let lastMessageId: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      try {
        const result = await this.request<{ message_id?: number }>("sendMessage", {
          chat_id: chatId,
          text: chunk.text,
          disable_web_page_preview: options.disableWebPagePreview ?? true,
          ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
          ...(chunk.entities.length > 0 ? { entities: chunk.entities } : {}),
          ...(replyMarkupForOptions(options, index === chunks.length - 1)),
        });
        lastMessageId = result?.message_id ?? lastMessageId;
      } catch (error) {
        this.logger.error("telegram.send_message_failed", {
          chat_id: chatId,
          text_len: text.length,
          chunks: chunks.length,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    }
    this.logger.debug("telegram.send_message_completed", { chat_id: chatId, text_len: text.length, chunks: chunks.length });
    return { messageId: lastMessageId };
  }

  async editMessageText(chatId: ChatId, text: string, options: EditMessageTextOptions): Promise<void> {
    try {
      await this.request("editMessageText", {
        chat_id: chatId,
        message_id: options.messageId,
        text: text.length > 0 ? text : "(empty)",
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.entities && options.entities.length > 0 ? { entities: options.entities } : {}),
        ...(replyMarkupForOptions(options, true)),
      });
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        this.logger.debug("telegram.edit_message_not_modified", { chat_id: chatId, message_id: options.messageId });
        return;
      }
      this.logger.error("telegram.edit_message_failed", {
        chat_id: chatId,
        message_id: options.messageId,
        text_len: text.length,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async sendChatAction(chatId: ChatId, action: "typing" = "typing"): Promise<void> {
    await this.request("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  private toInboundMessage(update: TelegramUpdate): InboundMessage | undefined {
    const message = update.message;
    if (message?.text && message.from) {
      return {
        kind: "message",
        id: String(message.message_id),
        chatId: message.chat.id,
        userId: message.from.id,
        text: message.text,
        ...(message.reply_to_message ? { replyToMessageId: message.reply_to_message.message_id } : {}),
        date: message.date,
      };
    }

    const callback = update.callback_query;
    if (callback?.data && callback.message) {
      return {
        kind: "callback_query",
        id: callback.id,
        callbackQueryId: callback.id,
        chatId: callback.message.chat.id,
        userId: callback.from.id,
        messageId: callback.message.message_id,
        data: callback.data,
        date: callback.message.date,
      };
    }

    return undefined;
  }

  private async request<T>(method: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: TelegramApiResponse<T> | undefined;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const description = payload?.description;
      this.logger.error("telegram.api_http_error", {
        method,
        status: response.status,
        description: description || "unknown HTTP error",
      });
      throw new TelegramApiError(method, response.status, description);
    }
    if (!payload) {
      throw new Error(`Telegram ${method} returned an empty response`);
    }
    if (!payload.ok) {
      this.logger.error("telegram.api_error", { method, description: payload.description || "unknown API error" });
      throw new TelegramApiError(method, response.status, payload.description || "unknown API error");
    }
    return payload.result as T;
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (error instanceof TelegramApiError && error.description?.toLowerCase().includes("message is not modified")) {
    return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

function outboundChunks(text: string, options: SendMessageOptions): Array<{ text: string; entities: NonNullable<SendMessageOptions["entities"]> }> {
  if (options.entities && options.entities.length > 0 && !options.parseMode) {
    return splitRenderedForTelegram({ text, entities: options.entities });
  }
  const chunks = options.parseMode === "HTML" ? splitHtmlForTelegram(text) : splitForTelegram(text);
  return chunks.map((chunk) => ({ text: chunk, entities: [] }));
}

function replyMarkupForOptions(options: SendMessageOptions, include: boolean): { reply_markup?: unknown } {
  if (!include) return {};
  if (options.forceReply) return { reply_markup: { force_reply: true, selective: true } };
  if (options.replyMarkup) return { reply_markup: options.replyMarkup };
  return {};
}
