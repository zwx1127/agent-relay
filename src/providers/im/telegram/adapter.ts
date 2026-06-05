import type { ConversationId, MessageId } from "../../../domain/ids.ts";
import type { DownloadedFile, EditMessageTextOptions, InboundMessage, ImAdapter, SendFileOptions, SendMessageOptions, SendPhotoOptions } from "../../../ports/im.ts";
import { splitForTelegram, splitHtmlForTelegram, splitRenderedForTelegram } from "../../../presentation/telegram/text.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";

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

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    entities?: TelegramMessageEntity[];
    caption_entities?: TelegramMessageEntity[];
    media_group_id?: string;
    photo?: Array<{
      file_id: string;
      file_unique_id?: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    chat: { id: number; type?: "private" | "group" | "supergroup" | "channel" };
    message_thread_id?: number;
    from?: { id: number };
    reply_to_message?: { message_id: number; message_thread_id?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: {
      message_id: number;
      message_thread_id?: number;
      date?: number;
      chat: { id: number };
    };
  };
}

interface TelegramMessageEntity {
  type: "mention" | "text_mention" | "bot_command" | string;
  offset: number;
  length: number;
  user?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
}

type TelegramChatType = NonNullable<NonNullable<TelegramUpdate["message"]>["chat"]["type"]>;

const ALLOWED_UPDATES = ["message", "callback_query"] as const;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_REQUEST_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10000;
const RETRYABLE_HTTP_STATUSES = new Set([429]);

interface RequestOptions {
  quietMessageNotModified?: boolean;
  retryForever?: boolean;
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
    this.delay = options.delay ?? sleep;
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
            has_from: Boolean(update.message?.from || update.callback_query?.from),
            has_callback_query: Boolean(update.callback_query),
            has_callback_data: Boolean(update.callback_query?.data),
          });
          continue;
        }
        this.logger.debug(inbound.kind === "message" ? "telegram.message_received" : inbound.kind === "media" ? "telegram.media_received" : inbound.kind === "file" ? "telegram.file_received" : "telegram.callback_query_received", {
          update_id: update.update_id,
          message_id: inbound.kind === "message" ? inbound.id : inbound.messageId,
          conversation_id: inbound.conversationId,
          user_id: inbound.userId,
          kind: inbound.kind,
          text_len: inbound.kind === "message" ? inbound.text.length : inbound.kind === "media" || inbound.kind === "file" ? inbound.caption?.length ?? 0 : inbound.data.length,
          message_text: inbound.kind === "message" ? inbound.text : inbound.kind === "media" || inbound.kind === "file" ? inbound.caption ?? "" : inbound.data,
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
      try {
        const result = await this.request<{ message_id?: number }>("sendMessage", {
          chat_id: conversationId,
          text: chunk.text,
          disable_web_page_preview: options.disableWebPagePreview ?? true,
          ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
          ...(chunk.entities.length > 0 ? { entities: chunk.entities } : {}),
          ...(replyParametersForOptions(options, index === 0)),
          ...(telegramThreadForOptions(options)),
          ...(replyMarkupForOptions(options, index === chunks.length - 1)),
        });
        lastMessageId = result?.message_id !== undefined ? String(result.message_id) : lastMessageId;
      } catch (error) {
        this.logger.error("telegram.send_message_failed", {
          conversation_id: conversationId,
          text_len: text.length,
          chunks: chunks.length,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
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

  async setMessageReaction(conversationId: ConversationId, messageId: MessageId, emoji?: string): Promise<void> {
    await this.request("setMessageReaction", {
      chat_id: conversationId,
      message_id: Number(messageId),
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
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
    const message = update.message;
    if (message?.text && message.from) {
      const mention = mentionContextForTelegram(message.text, message.entities, message.chat.type, this.botUsername);
      const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
      return {
        kind: "message",
        id: String(message.message_id),
        messageId: String(message.message_id),
        conversationId: String(message.chat.id),
        userId: String(message.from.id),
        text: mention.text,
        ...mention.context,
        ...(topic ? { topic } : {}),
        ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
        date: message.date,
      };
    }

    if (message?.photo?.length && message.from) {
      const mention = mentionContextForTelegram(message.caption ?? "", message.caption_entities, message.chat.type, this.botUsername);
      const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
      return {
        kind: "media",
        id: String(message.message_id),
        messageId: String(message.message_id),
        conversationId: String(message.chat.id),
        userId: String(message.from.id),
        ...(mention.text ? { caption: mention.text } : {}),
        ...mention.context,
        ...(topic ? { topic } : {}),
        photos: message.photo.map((photo) => ({
          fileId: photo.file_id,
          ...(photo.file_unique_id ? { fileUniqueId: photo.file_unique_id } : {}),
          width: photo.width,
          height: photo.height,
          ...(typeof photo.file_size === "number" ? { fileSize: photo.file_size } : {}),
        })),
        ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
        ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
        date: message.date,
      };
    }

    if (message?.document && message.from) {
      const mention = mentionContextForTelegram(message.caption ?? "", message.caption_entities, message.chat.type, this.botUsername);
      const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
      return {
        kind: "file",
        id: String(message.message_id),
        messageId: String(message.message_id),
        conversationId: String(message.chat.id),
        userId: String(message.from.id),
        ...(mention.text ? { caption: mention.text } : {}),
        ...mention.context,
        ...(topic ? { topic } : {}),
        file: {
          fileId: message.document.file_id,
          ...(message.document.file_unique_id ? { fileUniqueId: message.document.file_unique_id } : {}),
          ...(message.document.file_name ? { fileName: message.document.file_name } : {}),
          ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
          ...(typeof message.document.file_size === "number" ? { fileSize: message.document.file_size } : {}),
        },
        ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
        date: message.date,
      };
    }

    const callback = update.callback_query;
    if (callback?.data && callback.message) {
      const topic = telegramTopic(callback.message.message_thread_id);
      return {
        kind: "callback_query",
        id: callback.id,
        callbackQueryId: callback.id,
        conversationId: String(callback.message.chat.id),
        userId: String(callback.from.id),
        messageId: String(callback.message.message_id),
        data: callback.data,
        ...(topic ? { topic } : {}),
        date: callback.message.date,
      };
    }

    return undefined;
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
        const retryable = isRetryableTelegramError(error);
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

function isRetryableTelegramError(error: unknown): boolean {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBotUsername(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

function telegramMentionPrefix(mentions: SendMessageOptions["mentions"]): string {
  const prefixes = (mentions ?? [])
    .map((mention) => mention.telegramUsername?.trim().replace(/^@+/, ""))
    .filter((username): username is string => Boolean(username));
  return prefixes.length > 0 ? `${prefixes.map((username) => `@${username}`).join(" ")} ` : "";
}

function mentionContextForTelegram(
  text: string,
  entities: TelegramMessageEntity[] | undefined,
  chatType: TelegramChatType | undefined,
  botUsername: string | undefined,
): { text: string; context: { conversationType?: "direct" | "group" | "unknown"; mentionedBot?: boolean; mentionAll?: boolean; mentions?: Array<{ label: string; userId?: string; isBot?: boolean }> } } {
  const conversationType: "direct" | "group" | "unknown" | undefined = chatType === "private" ? "direct" : chatType === "group" || chatType === "supergroup" ? "group" : chatType ? "unknown" : undefined;
  const mentions = (entities ?? [])
    .filter((entity) => entity.type === "mention" || entity.type === "text_mention")
    .map((entity) => {
      const label = text.slice(entity.offset, entity.offset + entity.length);
      return {
        label,
        ...(entity.user?.id !== undefined ? { userId: String(entity.user.id) } : {}),
        ...(entity.user?.is_bot !== undefined ? { isBot: entity.user.is_bot } : {}),
      };
    });
  const bot = normalizeBotUsername(botUsername);
  const botMentionEntities = bot
    ? (entities ?? []).filter((entity) => entityMentionsBot(text, entity, bot))
    : [];
  const stripped = stripBotMentions(text, botMentionEntities);
  const context: { conversationType?: "direct" | "group" | "unknown"; mentionedBot?: boolean; mentions?: Array<{ label: string; userId?: string; isBot?: boolean }> } = {
    ...(conversationType ? { conversationType } : {}),
    ...(conversationType === "group" ? { mentionedBot: botMentionEntities.length > 0 } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
  return { text: stripped, context };
}

function entityMentionsBot(text: string, entity: TelegramMessageEntity, botUsername: string): boolean {
  const value = text.slice(entity.offset, entity.offset + entity.length);
  if (entity.type === "mention") return normalizeBotUsername(value) === botUsername;
  if (entity.type === "text_mention") return normalizeBotUsername(entity.user?.username) === botUsername;
  if (entity.type !== "bot_command") return false;
  const atIndex = value.indexOf("@");
  return atIndex >= 0 && normalizeBotUsername(value.slice(atIndex + 1)) === botUsername;
}

function stripBotMentions(text: string, entities: TelegramMessageEntity[]): string {
  let next = text;
  for (const entity of [...entities].sort((a, b) => b.offset - a.offset)) {
    const value = next.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "bot_command") {
      const atIndex = value.indexOf("@");
      if (atIndex >= 0) {
        next = `${next.slice(0, entity.offset + atIndex)}${next.slice(entity.offset + entity.length)}`;
      }
      continue;
    }
    next = `${next.slice(0, entity.offset)}${next.slice(entity.offset + entity.length)}`;
  }
  return next.trim();
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

function telegramTopic(messageThreadId: number | undefined): { provider: "telegram"; id: string } | undefined {
  return messageThreadId !== undefined ? { provider: "telegram", id: String(messageThreadId) } : undefined;
}
