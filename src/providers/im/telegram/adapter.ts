import type { ConversationId, MessageId } from "../../../domain/ids.ts";
import { MessageDeliveryUnknownError, type DownloadedFile, type EditMessageTextOptions, type InboundMessage, type ImAdapter, type MessageReactionOptions, type SendFileOptions, type SendMessageOptions, type SendPhotoOptions } from "../../../ports/im.ts";
import { splitForTelegram, splitHtmlForTelegram, splitRenderedForTelegram } from "../../../presentation/telegram/text.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import { normalizeBotUsername, toTelegramInboundMessage, type TelegramUpdate } from "./inbound.ts";
import { delay as defaultDelay } from "../delay.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => Promise<Response>;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string | undefined,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(
      description
        ? `Telegram ${method} failed with HTTP ${status}: ${description}`
        : `Telegram ${method} failed with HTTP ${status}`,
    );
    this.name = "TelegramApiError";
  }
}

export interface TelegramAdapterOptions {
  botUsername?: string;
  discoverBotUsername?: boolean;
  pollTimeoutSeconds?: number;
  requestRetryMaxAttempts?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
}

const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_REQUEST_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10000;
const RETRYABLE_HTTP_STATUSES = new Set([429]);

interface RequestOptions {
  quietMessageNotModified?: boolean;
  retryForever?: boolean;
  retryAmbiguousErrors?: boolean;
}

export class TelegramAdapter implements ImAdapter {
  readonly providerId = "telegram";
  readonly capabilities = {
    editMessage: true,
    forceReply: true,
    inlineActions: true,
    reactions: true,
    typing: true,
    mediaDownload: true,
    imageUpload: true,
    fileUpload: true,
  };

  private offset = 0;
  private stopped = false;
  private readonly apiBase: string;
  private readonly pollTimeoutSeconds: number;
  private readonly requestRetryMaxAttempts: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly delay: (ms: number) => Promise<void>;
  private botUsername?: string;
  private readonly discoverBotUsername: boolean;

  constructor(
    token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger: Logger = noopLogger,
    options: TelegramAdapterOptions = {},
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    this.requestRetryMaxAttempts = options.requestRetryMaxAttempts ?? DEFAULT_REQUEST_RETRY_MAX_ATTEMPTS;
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.delay = options.delay ?? defaultDelay;
    this.botUsername = normalizeBotUsername(options.botUsername);
    this.discoverBotUsername = options.discoverBotUsername ?? false;
  }

  stop(): void {
    this.stopped = true;
    this.logger.info("telegram.polling_stop_requested");
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.logger.info("telegram.polling_started");
    if (this.discoverBotUsername && !this.botUsername) await this.resolveBotUsername();
    await this.skipPendingUpdates();
    while (!this.stopped) {
      const updates = await this.request<TelegramUpdate[]>("getUpdates", {
        offset: this.offset,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ALLOWED_UPDATES,
      }, { retryForever: true });
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
            has_photo: Boolean(update.message?.photo?.length),
            has_document: Boolean(update.message?.document),
            has_audio: Boolean(update.message?.audio || update.message?.voice),
            has_from: Boolean(update.message?.from || update.callback_query?.from),
            has_callback_query: Boolean(update.callback_query),
            has_callback_data: Boolean(update.callback_query?.data),
          });
          continue;
        }
        this.logger.debug(inbound.kind === "message" ? "telegram.message_received" : inbound.kind === "media" ? "telegram.media_received" : inbound.kind === "audio" ? "telegram.audio_received" : inbound.kind === "file" ? "telegram.file_received" : "telegram.callback_query_received", {
          update_id: update.update_id,
          message_id: inbound.kind === "message" ? inbound.id : inbound.messageId,
          conversation_id: inbound.conversationId,
          user_id: inbound.userId,
          kind: inbound.kind,
          text_len: inbound.kind === "message" ? inbound.text.length : inbound.kind === "media" || inbound.kind === "audio" || inbound.kind === "file" ? inbound.caption?.length ?? 0 : inbound.data.length,
          message_text: inbound.kind === "message" ? inbound.text : inbound.kind === "media" || inbound.kind === "audio" || inbound.kind === "file" ? inbound.caption ?? "" : inbound.data,
        });
        try {
          await onMessage(inbound);
        } catch (error) {
          this.logger.error("telegram.update_handler_failed", {
            update_id: update.update_id,
            message_id: inbound.kind === "message" ? inbound.id : inbound.messageId,
            conversation_id: inbound.conversationId,
            user_id: inbound.userId,
            kind: inbound.kind,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    }
    this.logger.info("telegram.polling_stopped");
  }

  private async skipPendingUpdates(): Promise<void> {
    const updates = await this.request<TelegramUpdate[]>("getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: ALLOWED_UPDATES,
    }, { retryForever: true });
    const lastUpdate = updates.at(-1);
    if (!lastUpdate) return;

    this.offset = lastUpdate.update_id + 1;
    this.logger.info("telegram.pending_updates_skipped", { offset: this.offset });
  }

  private async resolveBotUsername(): Promise<void> {
    try {
      const me = await this.request<{ username?: string }>("getMe", {});
      this.botUsername = normalizeBotUsername(me?.username);
      this.logger.info("telegram.bot_identity_resolved", { bot_username: this.botUsername });
    } catch (error) {
      this.logger.warn("telegram.bot_identity_resolve_failed", {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async sendMessage(conversationId: ConversationId, text: string, options: SendMessageOptions = {}): Promise<{ messageId?: MessageId }> {
    const mentionPrefix = telegramMentionPrefix(options.mentions);
    const messageText = `${mentionPrefix}${text.length > 0 ? text : "(empty)"}`;
    const sendOptions = mentionPrefix && options.entities?.length
      ? { ...options, entities: options.entities.map((entity) => ({ ...entity, offset: entity.offset + mentionPrefix.length })) }
      : options;
    const chunks = outboundChunks(messageText, sendOptions);
    this.logger.debug("telegram.send_message_started", { conversation_id: conversationId, text_len: text.length, chunks: chunks.length });
    let lastMessageId: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const isLastChunk = index === chunks.length - 1;
      const atMostOnce = options.deliveryMode === "at-most-once";
      const deferInlineKeyboard = atMostOnce && isLastChunk && !options.forceReply && options.replyMarkup !== undefined;
      try {
        const result = await this.request<{ message_id?: number }>("sendMessage", {
          chat_id: conversationId,
          text: chunk.text,
          disable_web_page_preview: options.disableWebPagePreview ?? true,
          ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
          ...(chunk.entities.length > 0 ? { entities: chunk.entities } : {}),
          ...(replyParametersForOptions(options, index === 0)),
          ...(telegramThreadForOptions(options)),
          ...(replyMarkupForOptions(options, isLastChunk && !deferInlineKeyboard)),
        }, atMostOnce ? { retryAmbiguousErrors: false } : {});
        if (atMostOnce && result?.message_id === undefined) {
          throw new MessageDeliveryUnknownError(
            this.providerId,
            "sendMessage",
            new Error("Telegram sendMessage did not return a message id"),
          );
        }
        lastMessageId = result?.message_id !== undefined ? String(result.message_id) : lastMessageId;
        if (deferInlineKeyboard && result?.message_id !== undefined) {
          await this.attachInlineKeyboard(conversationId, result.message_id, options.replyMarkup!);
        }
      } catch (error) {
        const surfacedError = error instanceof MessageDeliveryUnknownError
          ? error
          : atMostOnce && isAmbiguousTelegramDelivery(error)
          ? new MessageDeliveryUnknownError(this.providerId, "sendMessage", error)
          : error;
        this.logger.error("telegram.send_message_failed", {
          conversation_id: conversationId,
          text_len: text.length,
          chunks: chunks.length,
          error: surfacedError instanceof Error ? surfacedError : new Error(String(surfacedError)),
        });
        throw surfacedError;
      }
    }
    this.logger.debug("telegram.send_message_completed", { conversation_id: conversationId, text_len: text.length, chunks: chunks.length });
    return { messageId: lastMessageId };
  }

  async sendPhoto(conversationId: ConversationId, photo: Blob, options: SendPhotoOptions = {}): Promise<{ messageId?: MessageId }> {
    const form = new FormData();
    form.append("chat_id", String(conversationId));
    form.append("photo", photo, "image.jpg");
    if (options.caption) form.append("caption", options.caption);
    if (options.replyToMessageId) {
      form.append("reply_parameters", JSON.stringify({
        message_id: Number(options.replyToMessageId),
        allow_sending_without_reply: true,
      }));
    }
    appendTelegramThread(form, options);
    const result = await this.request<{ message_id?: number }>("sendPhoto", form);
    return { messageId: result?.message_id !== undefined ? String(result.message_id) : undefined };
  }

  async sendFile(conversationId: ConversationId, file: Blob, options: SendFileOptions = {}): Promise<{ messageId?: MessageId }> {
    const form = new FormData();
    form.append("chat_id", String(conversationId));
    form.append("document", file, options.filename ?? "file.bin");
    if (options.caption) form.append("caption", options.caption);
    if (options.replyToMessageId) {
      form.append("reply_parameters", JSON.stringify({
        message_id: Number(options.replyToMessageId),
        allow_sending_without_reply: true,
      }));
    }
    appendTelegramThread(form, options);
    const result = await this.request<{ message_id?: number }>("sendDocument", form);
    return { messageId: result?.message_id !== undefined ? String(result.message_id) : undefined };
  }

  async editMessageText(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void> {
    try {
      await this.request("editMessageText", {
        chat_id: conversationId,
        message_id: Number(options.messageId),
        text: text.length > 0 ? text : "(empty)",
        disable_web_page_preview: options.disableWebPagePreview ?? true,
        ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(options.entities && options.entities.length > 0 ? { entities: options.entities } : {}),
        ...(replyMarkupForOptions(options, true)),
      }, { quietMessageNotModified: true });
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        this.logger.debug("telegram.edit_message_not_modified", { conversation_id: conversationId, message_id: options.messageId });
        return;
      }
      this.logger.error("telegram.edit_message_failed", {
        conversation_id: conversationId,
        message_id: options.messageId,
        text_len: text.length,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  async deleteMessage(conversationId: ConversationId, messageId: MessageId): Promise<void> {
    await this.request("deleteMessage", {
      chat_id: conversationId,
      message_id: Number(messageId),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async sendChatAction(conversationId: ConversationId, action: "typing" = "typing", options: { topic?: SendMessageOptions["topic"] } = {}): Promise<void> {
    await this.request("sendChatAction", {
      chat_id: conversationId,
      action,
      ...(telegramThreadForOptions(options)),
    });
  }

  async setMessageReaction(conversationId: ConversationId, messageId: MessageId, emoji?: string, options: MessageReactionOptions = {}): Promise<void> {
    const applied = await this.request<boolean>("setMessageReaction", {
      chat_id: conversationId,
      message_id: Number(messageId),
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
      ...(options.isBig ? { is_big: true } : {}),
    });
    if (applied !== true) throw new Error("Telegram setMessageReaction did not confirm success");
  }

  private async attachInlineKeyboard(
    conversationId: ConversationId,
    messageId: number,
    replyMarkup: NonNullable<SendMessageOptions["replyMarkup"]>,
  ): Promise<void> {
    try {
      await this.request("editMessageReplyMarkup", {
        chat_id: conversationId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }, { quietMessageNotModified: true });
    } catch (error) {
      if (isMessageNotModifiedError(error)) return;
      this.logger.warn("telegram.send_message_reply_markup_attach_failed", {
        conversation_id: conversationId,
        message_id: messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const file = await this.request<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
    if (!file?.file_path) throw new Error("Telegram getFile did not return a file path.");
    const response = await this.fetchImpl(`${this.apiBase.replace("/bot", "/file/bot")}/${file.file_path}`);
    if (!response.ok) {
      throw new TelegramApiError("downloadFile", response.status, response.statusText || "download failed", undefined);
    }
    return {
      bytes: await response.arrayBuffer(),
      filePath: file.file_path,
      fileSize: typeof file.file_size === "number" ? file.file_size : undefined,
    };
  }

  private toInboundMessage(update: TelegramUpdate): InboundMessage | undefined {
    return toTelegramInboundMessage(update, this.botUsername);
  }

  private async request<T>(method: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    const maxAttempts = options.retryForever ? Number.POSITIVE_INFINITY : this.requestRetryMaxAttempts;
    let attempt = 1;
    let lastError: unknown;

    while (!this.stopped || !options.retryForever) {
      try {
        const result = await this.requestOnce<T>(method, body);
        if (attempt > 1) {
          this.logger.info("telegram.api_recovered", { method, attempt });
        }
        return result;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableTelegramError(error, options);
        if (!retryable || attempt >= maxAttempts || (this.stopped && options.retryForever)) {
          this.logFinalRequestError(method, error, options);
          throw error;
        }

        const delayMs = retryDelayMs(error, attempt, this.retryInitialDelayMs, this.retryMaxDelayMs);
        this.logger.warn("telegram.api_retry_scheduled", {
          method,
          attempt,
          next_attempt: attempt + 1,
          delay_ms: delayMs,
          ...retryLogFields(error),
        });
        await this.delay(delayMs);
        attempt += 1;
      }
    }

    const error = lastError instanceof Error ? lastError : new Error("Telegram polling stopped");
    throw error;
  }

  private async requestOnce<T>(method: string, body: unknown): Promise<T> {
    const isForm = body instanceof FormData;
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      ...(isForm ? {} : { headers: { "content-type": "application/json" } }),
      body: isForm ? body : JSON.stringify(body),
    });
    let payload: TelegramApiResponse<T> | undefined;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch (error) {
      if (response.ok) throw error;
    }
    if (!response.ok) {
      const description = payload?.description;
      throw new TelegramApiError(method, response.status, description, payload?.parameters?.retry_after);
    }
    if (!payload) {
      throw new Error(`Telegram ${method} returned an empty response`);
    }
    if (!payload.ok) {
      throw new TelegramApiError(method, response.status, payload.description || "unknown API error", payload.parameters?.retry_after);
    }
    return payload.result as T;
  }

  private logFinalRequestError(method: string, error: unknown, options: RequestOptions): void {
    if (error instanceof TelegramApiError) {
      if (error.status < 200 || error.status >= 300) {
        if (!isQuietMessageNotModified(error.description, options)) {
          this.logger.error("telegram.api_http_error", {
            method,
            status: error.status,
            description: error.description || "unknown HTTP error",
          });
        }
        return;
      }
      if (!isQuietMessageNotModified(error.description, options)) {
        this.logger.error("telegram.api_error", { method, description: error.description || "unknown API error" });
      }
    }
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (error instanceof TelegramApiError && isMessageNotModifiedDescription(error.description)) {
    return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

function isQuietMessageNotModified(description: string | undefined, options: { quietMessageNotModified?: boolean }): boolean {
  return Boolean(options.quietMessageNotModified && isMessageNotModifiedDescription(description));
}

function isMessageNotModifiedDescription(description: string | undefined): boolean {
  return Boolean(description?.toLowerCase().includes("message is not modified"));
}

function isRetryableTelegramError(error: unknown, options: RequestOptions = {}): boolean {
  if (options.retryAmbiguousErrors === false && isAmbiguousTelegramDelivery(error)) return false;
  if (!(error instanceof TelegramApiError)) return error instanceof Error;
  if (error.retryAfterSeconds && error.retryAfterSeconds > 0) return true;
  if (error.status >= 500) return true;
  return RETRYABLE_HTTP_STATUSES.has(error.status);
}

function retryDelayMs(error: unknown, attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  if (error instanceof TelegramApiError && error.retryAfterSeconds && error.retryAfterSeconds > 0) {
    return Math.min(error.retryAfterSeconds * 1000, maxDelayMs);
  }
  return Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

function retryLogFields(error: unknown): { status?: number; description?: string; error?: Error } {
  if (error instanceof TelegramApiError) {
    return {
      status: error.status,
      description: error.description || undefined,
    };
  }
  return { error: error instanceof Error ? error : new Error(String(error)) };
}

function telegramMentionPrefix(mentions: SendMessageOptions["mentions"]): string {
  const prefixes = (mentions ?? [])
    .map((mention) => mention.telegramUsername?.trim().replace(/^@+/, ""))
    .filter((username): username is string => Boolean(username));
  return prefixes.length > 0 ? `${prefixes.map((username) => `@${username}`).join(" ")} ` : "";
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
  if (options.forceReply) {
    return {
      reply_markup: {
        force_reply: true,
        selective: true,
        ...(options.inputFieldPlaceholder ? { input_field_placeholder: options.inputFieldPlaceholder } : {}),
      },
    };
  }
  if (options.replyMarkup) return { reply_markup: options.replyMarkup };
  return {};
}

function replyParametersForOptions(options: SendMessageOptions, include: boolean): { reply_parameters?: unknown } {
  if (!include || !options.replyToMessageId) return {};
  return {
    reply_parameters: {
      message_id: Number(options.replyToMessageId),
      allow_sending_without_reply: true,
    },
  };
}

function telegramThreadForOptions(options: Pick<SendMessageOptions, "topic">): { message_thread_id?: number } {
  if (options.topic?.provider !== "telegram") return {};
  const id = Number(options.topic.id);
  return Number.isFinite(id) ? { message_thread_id: id } : {};
}

function appendTelegramThread(form: FormData, options: Pick<SendPhotoOptions | SendFileOptions, "topic">): void {
  if (options.topic?.provider !== "telegram") return;
  const id = Number(options.topic.id);
  if (Number.isFinite(id)) form.append("message_thread_id", String(id));
}

function isAmbiguousTelegramDelivery(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return error instanceof Error;
  return error.status === 408 || error.status >= 500;
}
