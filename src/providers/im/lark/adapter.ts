import * as lark from "@larksuiteoapi/node-sdk";
import type { Readable } from "node:stream";
import type { ConversationId, MessageId } from "../../../domain/ids.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import { createLarkCard, renderLarkMarkdown } from "../../../presentation/lark/text.ts";
import type {
  CardActionEvent,
  LarkChannel as SdkLarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
  ResourceDescriptor,
  SendInput,
  SendOptions,
} from "@larksuiteoapi/node-sdk";
import type {
  DownloadedFile,
  DownloadFileOptions,
  EditMessageTextOptions,
  InboundMediaFile,
  InboundMessage,
  ImAdapter,
  SendFileOptions,
  SendMessageOptions,
  SendMessageResult,
  SendPhotoOptions,
} from "../../../ports/im.ts";

export interface LarkAdapterOptions {
  appId: string;
  appSecret: string;
  domain?: string;
  logger?: Logger;
  channel?: LarkChannelClient;
  cardUpdateTimeoutMs?: number;
  cardActionDedupTtlMs?: number;
  cardActionDispatchDelayMs?: number;
}

type LarkEventHandlers = {
  message?: (message: NormalizedMessage) => void | Promise<void>;
  cardAction?: (event: CardActionEvent) => void | Promise<void>;
  error?: (error: Error) => void;
  reconnecting?: () => void;
  reconnected?: () => void;
};

interface CardUpdateDiagnostics {
  targetView: string;
  textLength: number;
}

const DEFAULT_CARD_UPDATE_TIMEOUT_MS = 10_000;
const DEFAULT_CARD_ACTION_DEDUP_TTL_MS = 500;
const DEFAULT_CARD_ACTION_DISPATCH_DELAY_MS = 150;
const CARD_UPDATE_MAX_ATTEMPTS = 3;
const CARD_UPDATE_RETRY_DELAY_MS = 250;

export interface LarkChannelClient {
  rawClient?: lark.Client;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(handlers: LarkEventHandlers): () => void;
  send(to: string, input: SendInput, options?: SendOptions): Promise<{ messageId: string; chunkIds?: string[] }>;
  updateCard(messageId: string, card: object): Promise<void>;
  editMessage(messageId: string, text: string): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
  addReaction?(messageId: string, emojiType: string): Promise<string>;
  removeReactionByEmoji?(messageId: string, emojiType: string): Promise<boolean>;
}

export class LarkAdapter implements ImAdapter {
  readonly providerId = "lark";
  readonly capabilities = {
    editMessage: true,
    forceReply: true,
    inlineActions: true,
    reactions: true,
    typing: false,
    mediaDownload: true,
    imageUpload: true,
    fileUpload: true,
  };

  private readonly channel: LarkChannelClient;
  private readonly logger: Logger;
  private unsubscribe?: () => void;
  private stopped = false;
  private readonly cardMessageIds = new Set<string>();
  private readonly cardUpdateQueues = new Map<string, Promise<void>>();
  private readonly reactionIds = new Map<string, string>();
  private readonly cardUpdateTimeoutMs: number;
  private readonly cardActionDispatchDelayMs: number;

  static create(options: Omit<LarkAdapterOptions, "channel">): LarkAdapter {
    return new LarkAdapter({
      ...options,
      channel: lark.createLarkChannel(larkChannelOptions(options)) as SdkLarkChannel,
    });
  }

  constructor(options: LarkAdapterOptions) {
    this.channel = options.channel ?? lark.createLarkChannel(larkChannelOptions(options));
    this.logger = options.logger ?? noopLogger;
    this.cardUpdateTimeoutMs = options.cardUpdateTimeoutMs ?? DEFAULT_CARD_UPDATE_TIMEOUT_MS;
    this.cardActionDispatchDelayMs = options.cardActionDispatchDelayMs ?? DEFAULT_CARD_ACTION_DISPATCH_DELAY_MS;
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.logger.info("lark.websocket_started");
    this.unsubscribe = this.channel.on({
      message: (message) => {
        return this.handleChannelMessage(message, onMessage);
      },
      cardAction: (event) => {
        return this.handleCardAction(event, onMessage);
      },
      error: (error) => {
        this.logger.error("lark.channel_error", { error });
      },
      reconnecting: () => {
        this.logger.warn("lark.websocket_reconnecting");
      },
      reconnected: () => {
        this.logger.info("lark.websocket_reconnected");
      },
    });
    await this.channel.connect();
    if (this.stopped) await this.channel.disconnect();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    void this.channel.disconnect().catch((error) => {
      this.logger.warn("lark.websocket_disconnect_failed", {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  async sendMessage(conversationId: ConversationId, text: string, options: SendMessageOptions = {}): Promise<SendMessageResult> {
    const prefix = options.mentions?.length ? `${options.mentions.map((mention) => `@${mention.label}`).join(" ")} ` : "";
    const messageText = `${prefix}${text.length > 0 ? text : "(empty)"}`.trim();
    const sendOptions = sendOptionsFor(options);
    if (shouldSendCard(options)) {
      const card = createLarkCard(messageText, options);
      const result = await this.channel.send(String(conversationId), { card }, sendOptions);
      this.cardMessageIds.add(result.messageId);
      return { messageId: result.messageId };
    }

    const result = await this.channel.send(String(conversationId), { markdown: renderLarkMarkdown(messageText, options.entities) }, sendOptions);
    return { messageId: result.messageId };
  }

  async sendPhoto(conversationId: ConversationId, photo: Blob, options: SendPhotoOptions = {}): Promise<SendMessageResult> {
    const buffer = Buffer.from(await photo.arrayBuffer());
    const result = await this.channel.send(String(conversationId), { image: { source: buffer } }, sendOptionsFor(options));
    if (options.caption) {
      await this.channel.send(String(conversationId), { text: options.caption }, { replyTo: result.messageId });
    }
    return { messageId: result.messageId };
  }

  async sendFile(conversationId: ConversationId, file: Blob, options: SendFileOptions = {}): Promise<SendMessageResult> {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await this.channel.send(String(conversationId), {
      file: { source: buffer, fileName: options.filename ?? "file.bin" },
    }, sendOptionsFor(options));
    if (options.caption) {
      await this.channel.send(String(conversationId), { text: options.caption }, { replyTo: result.messageId });
    }
    return { messageId: result.messageId };
  }

  async editMessageText(_conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void> {
    const messageText = text.length > 0 ? text : "(empty)";
    if (shouldSendCard(options) || this.cardMessageIds.has(String(options.messageId))) {
      const messageId = String(options.messageId);
      await this.updateCardMessage(messageId, createLarkCard(messageText, options), cardUpdateDiagnostics(messageText));
      this.cardMessageIds.add(messageId);
      return;
    }
    await this.channel.editMessage(String(options.messageId), messageText);
  }

  async deleteMessage(_conversationId: ConversationId, messageId: MessageId): Promise<void> {
    await this.channel.recallMessage(String(messageId));
  }

  async answerCallbackQuery(_callbackQueryId: string, _text?: string): Promise<void> {
    return;
  }

  async setMessageReaction(_conversationId: ConversationId, messageId: MessageId, emoji?: string): Promise<void> {
    const key = String(messageId);
    const previous = this.reactionIds.get(key);
    if (previous && this.channel.removeReactionByEmoji) {
      await this.channel.removeReactionByEmoji(key, previous);
      this.reactionIds.delete(key);
    }
    if (emoji && this.channel.addReaction) {
      const larkEmoji = reactionForEmoji(emoji);
      await this.channel.addReaction(key, larkEmoji);
      this.reactionIds.set(key, larkEmoji);
    }
  }

  async downloadFile(fileId: string, options: DownloadFileOptions = {}): Promise<DownloadedFile> {
    const kind = options.kind ?? "image";
    const buffer = kind === "image"
      ? await this.downloadImageResource(fileId, options)
      : await this.downloadNonImageResource(fileId, kind, options);
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(buffer);
    return {
      bytes,
      filePath: kind === "image" ? `${fileId}.jpg` : fileId,
      fileSize: buffer.byteLength,
    };
  }

  private async downloadImageResource(fileId: string, options: DownloadFileOptions): Promise<Buffer> {
    try {
      return await this.channel.downloadResource(fileId, "image");
    } catch (error) {
      if (!options.messageId || !this.channel.rawClient) throw error;
      this.logger.warn("lark.image_download_fallback", {
        message_id: String(options.messageId),
        file_key: fileId,
        error: errorSummary(error),
      });
      return await downloadMessageResource(this.channel.rawClient, String(options.messageId), fileId, "image");
    }
  }

  private async downloadNonImageResource(fileId: string, kind: "file", options: DownloadFileOptions): Promise<Buffer> {
    return options.messageId && this.channel.rawClient
      ? await downloadMessageResource(this.channel.rawClient, String(options.messageId), fileId, kind)
      : await this.channel.downloadResource(fileId, kind);
  }

  private async handleChannelMessage(message: NormalizedMessage, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const inbound = this.toInboundMessage(message);
    if (!inbound) {
      this.logger.debug("lark.message_ignored", {
        message_id: message.messageId,
        chat_id: message.chatId,
        sender_id: message.senderId,
        raw_content_type: message.rawContentType,
      });
      return;
    }
    this.logger.debug(inbound.kind === "media" ? "lark.media_received" : inbound.kind === "file" ? "lark.file_received" : "lark.message_received", {
      message_id: inbound.messageId,
      conversation_id: inbound.conversationId,
      user_id: inbound.userId,
      kind: inbound.kind,
    });
    try {
      await onMessage(inbound);
    } catch (error) {
      this.logger.error("lark.message_handler_failed", {
        message_id: inbound.messageId,
        conversation_id: inbound.conversationId,
        user_id: inbound.userId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async handleCardAction(event: CardActionEvent, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const data = callbackDataFromActionValue(event.action.value);
    if (!data) {
      this.logger.debug("lark.card_action_ignored", {
        message_id: event.messageId,
        chat_id: event.chatId,
        operator_id: event.operator.openId,
      });
      return;
    }
    const inbound: InboundMessage = {
      kind: "callback_query",
      id: `${event.messageId}:${event.operator.openId}:${data}`,
      callbackQueryId: `${event.messageId}:${event.operator.openId}:${data}`,
      conversationId: event.chatId,
      userId: event.operator.openId,
      messageId: event.messageId,
      data,
    };
    setTimeout(() => {
      void onMessage(inbound).catch((error) => {
        this.logger.error("lark.card_action_handler_failed", {
          message_id: event.messageId,
          conversation_id: event.chatId,
          user_id: event.operator.openId,
          callback_data: data,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }, this.cardActionDispatchDelayMs);
  }

  private async updateCardMessage(messageId: string, card: object, diagnostics: CardUpdateDiagnostics): Promise<void> {
    const previous = this.cardUpdateQueues.get(messageId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      this.logger.info("lark.card_update_started", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        text_len: diagnostics.textLength,
      });
      await withTimeout(
        this.updateCardWithRetry(messageId, card),
        this.cardUpdateTimeoutMs,
        `Lark card update timed out after ${this.cardUpdateTimeoutMs}ms`,
      );
      this.logger.info("lark.card_update_succeeded", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        text_len: diagnostics.textLength,
      });
    });
    this.cardUpdateQueues.set(messageId, current);
    try {
      await current;
    } catch (error) {
      this.logger.warn("lark.card_update_failed", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        text_len: diagnostics.textLength,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    } finally {
      if (this.cardUpdateQueues.get(messageId) === current) this.cardUpdateQueues.delete(messageId);
    }
  }

  private async updateCardWithRetry(messageId: string, card: object): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CARD_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.channel.updateCard(messageId, card);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === CARD_UPDATE_MAX_ATTEMPTS) break;
        this.logger.debug("lark.card_update_retrying", {
          message_id: messageId,
          attempt,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        await sleep(CARD_UPDATE_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private toInboundMessage(message: NormalizedMessage): InboundMessage | undefined {
    if (message.rawContentType === "interactive") return undefined;

    const imageResources = message.resources.filter((resource) => resource.type === "image");
    if (imageResources.length > 0) {
      return {
        kind: "media",
        id: message.messageId,
        messageId: message.messageId,
        conversationId: message.chatId,
        userId: message.senderId,
        ...larkMessageContext(message),
        ...larkTopicContext(message),
        photos: imageResources.map(resourceToPhoto),
        ...(captionFromMessage(message) ? { caption: captionFromMessage(message) } : {}),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        date: Math.floor(message.createTime / 1000),
      };
    }

    const fileResource = message.resources.find((resource) => resource.type === "file");
    if (fileResource) {
      return {
        kind: "file",
        id: message.messageId,
        messageId: message.messageId,
        conversationId: message.chatId,
        userId: message.senderId,
        ...larkMessageContext(message),
        ...larkTopicContext(message),
        file: {
          fileId: fileResource.fileKey,
          ...(fileResource.fileName ? { fileName: fileResource.fileName } : {}),
        },
        ...(captionFromMessage(message) ? { caption: captionFromMessage(message) } : {}),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
        date: Math.floor(message.createTime / 1000),
      };
    }

    const text = message.content.trim();
    if (!text) return undefined;
    return {
      kind: "message",
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.chatId,
      userId: message.senderId,
      ...larkMessageContext(message),
      ...larkTopicContext(message),
      text: stripLarkBotMentions(text, message),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      date: Math.floor(message.createTime / 1000),
    };
  }
}

async function downloadMessageResource(client: lark.Client, messageId: string, fileKey: string, kind: "image" | "file"): Promise<Buffer> {
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: kind,
    },
    path: {
      message_id: messageId,
      file_key: fileKey,
    },
  });
  return await bufferFromReadable(resource.getReadableStream());
}

async function bufferFromReadable(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendOptionsFor(options: Pick<SendMessageOptions | SendPhotoOptions | SendFileOptions, "replyToMessageId" | "topic"> & Partial<Pick<SendMessageOptions, "mentions">>): SendOptions {
  const topic = options.topic?.provider === "lark" ? options.topic : undefined;
  return {
    ...(options.replyToMessageId ? { replyTo: String(options.replyToMessageId) } : topic ? { replyTo: String(topic.rootMessageId ?? topic.id) } : {}),
    ...(topic ? { replyInThread: true } : {}),
    ...("mentions" in options && options.mentions?.length ? {
      mentions: options.mentions
        .filter((mention) => mention.larkOpenId || mention.larkUserId)
        .map((mention) => ({
          key: mention.label,
          ...(mention.larkOpenId ? { openId: mention.larkOpenId } : {}),
          ...(mention.larkUserId ? { userId: mention.larkUserId } : {}),
          name: mention.label,
          isBot: true,
        })),
    } : {}),
  };
}

function larkTopicContext(message: NormalizedMessage): { topic?: { provider: "lark"; id: string; rootMessageId?: string } } {
  const id = message.threadId ?? message.rootId;
  if (!id) return {};
  return {
    topic: {
      provider: "lark",
      id,
      ...(message.rootId ? { rootMessageId: message.rootId } : {}),
    },
  };
}

export function larkDomainForSdk(domain: string | undefined): lark.Domain | string {
  if (!domain || domain === "feishu") return lark.Domain.Feishu;
  if (domain === "lark") return lark.Domain.Lark;
  return domain;
}

export function larkChannelOptions(options: Pick<LarkAdapterOptions, "appId" | "appSecret" | "domain" | "cardActionDedupTtlMs">): LarkChannelOptions {
  return {
    appId: options.appId,
    appSecret: options.appSecret,
    domain: larkDomainForSdk(options.domain),
    transport: "websocket",
    source: "agent-relay",
    policy: {
      requireMention: false,
      dmMode: "open",
    },
    outbound: {
      textChunkLimit: 3500,
    },
    safety: {
      dedup: {
        ttl: options.cardActionDedupTtlMs ?? DEFAULT_CARD_ACTION_DEDUP_TTL_MS,
      },
    },
  };
}

function shouldSendCard(options: SendMessageOptions): boolean {
  return Boolean(options.replyMarkup || options.forceReply || options.entities?.length || options.disableWebPagePreview);
}

function cardUpdateDiagnostics(text: string): CardUpdateDiagnostics {
  return {
    targetView: cardTargetView(text),
    textLength: text.length,
  };
}

function cardTargetView(text: string): string {
  const firstLine = stripBasicMarkdown(text.split(/\r?\n/, 1)[0] ?? "").trim().toLowerCase();
  if (firstLine === "relay home") return "home";
  if (firstLine === "workspaces") return "workspaces";
  if (firstLine === "workspace") return "workspace_intro";
  if (firstLine === "selecting workspace.") return "workspace_selecting";
  if (firstLine === "deleting workspace.") return "workspace_deleting";
  if (firstLine === "delete workspace?") return "workspace_delete_confirm";
  if (firstLine === "stopping session.") return "session_stopping";
  if (firstLine === "stale relay home.") return "stale_home";
  return "other";
}

function stripBasicMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/`/g, "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callbackDataFromActionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const data = record.callback_data ?? record.callbackData;
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

function resourceToPhoto(resource: ResourceDescriptor): InboundMediaFile {
  return {
    fileId: resource.fileKey,
    width: 0,
    height: 0,
  };
}

function captionFromMessage(message: NormalizedMessage): string | undefined {
  if (message.rawContentType === "image") return undefined;
  const caption = stripLarkBotMentions(message.content, message).trim();
  return caption.length > 0 ? caption : undefined;
}

function larkMessageContext(message: NormalizedMessage): {
  conversationType: "direct" | "group" | "unknown";
  mentionedBot: boolean;
  mentionAll: boolean;
  mentions?: Array<{ label: string; userId?: string; isBot?: boolean }>;
} {
  const mentions = message.mentions.map((mention) => ({
    label: mention.name ?? mention.key,
    ...(mention.openId ? { userId: mention.openId } : mention.userId ? { userId: mention.userId } : {}),
    ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
  }));
  return {
    conversationType: message.chatType === "p2p" ? "direct" : message.chatType === "group" ? "group" : "unknown",
    mentionedBot: message.mentionedBot,
    mentionAll: message.mentionAll,
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

function stripLarkBotMentions(text: string, message: NormalizedMessage): string {
  let next = text;
  for (const mention of message.mentions.filter((item) => item.isBot)) {
    const candidates = [mention.key, mention.name ? `@${mention.name}` : undefined, mention.name].filter((item): item is string => Boolean(item));
    for (const candidate of candidates) {
      next = stripStandaloneLarkBotMentionCandidate(next, candidate);
    }
  }
  return next.trim();
}

function stripStandaloneLarkBotMentionCandidate(text: string, candidate: string): string {
  let next = text;
  let searchFrom = 0;
  while (searchFrom < next.length) {
    const index = next.indexOf(candidate, searchFrom);
    if (index < 0) break;
    if (isStandaloneTextToken(next, index, candidate.length)) {
      next = `${next.slice(0, index)}${next.slice(index + candidate.length)}`;
      searchFrom = Math.max(0, index - 1);
    } else {
      searchFrom = index + candidate.length;
    }
  }
  return next;
}

function isStandaloneTextToken(text: string, offset: number, length: number): boolean {
  const before = offset > 0 ? text[offset - 1] : undefined;
  const afterIndex = offset + length;
  const after = afterIndex < text.length ? text[afterIndex] : undefined;
  return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
}

function reactionForEmoji(emoji: string): string {
  switch (emoji) {
    case "🫡":
      return "SALUTE";
    case "✍":
      return "Typing";
    case "🤔":
      return "THINKING";
    case "😎":
      return "DONE";
    case "🤨":
      return "GLANCE";
    case "😱":
      return "ERROR";
    default:
      return "OK";
  }
}
