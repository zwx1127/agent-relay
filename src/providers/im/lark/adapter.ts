import * as lark from "@larksuiteoapi/node-sdk";
import type { ConversationId, MessageId } from "../../../domain/ids.ts";
import { noopLogger, type Logger } from "../../../domain/logger.ts";
import { createLarkCard, renderLarkMarkdown } from "../../../presentation/lark/text.ts";
import type {
  CardActionEvent,
  LarkChannel as SdkLarkChannel,
  NormalizedMessage,
  ResourceDescriptor,
  SendInput,
  SendOptions,
} from "@larksuiteoapi/node-sdk";
import type {
  DownloadedFile,
  EditMessageTextOptions,
  InboundMediaFile,
  InboundMessage,
  ImAdapter,
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
}

type LarkEventHandlers = {
  message?: (message: NormalizedMessage) => void | Promise<void>;
  cardAction?: (event: CardActionEvent) => void | Promise<void>;
  error?: (error: Error) => void;
  reconnecting?: () => void;
  reconnected?: () => void;
};

export interface LarkChannelClient {
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
  };

  private readonly channel: LarkChannelClient;
  private readonly logger: Logger;
  private unsubscribe?: () => void;
  private stopped = false;
  private readonly cardMessageIds = new Set<string>();
  private readonly cardUpdateQueues = new Map<string, Promise<void>>();
  private readonly reactionIds = new Map<string, string>();

  static create(options: Omit<LarkAdapterOptions, "channel">): LarkAdapter {
    return new LarkAdapter({
      ...options,
      channel: lark.createLarkChannel({
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
      }) as SdkLarkChannel,
    });
  }

  constructor(options: LarkAdapterOptions) {
    this.channel = options.channel ?? lark.createLarkChannel({
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
    });
    this.logger = options.logger ?? noopLogger;
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.logger.info("lark.websocket_started");
    this.unsubscribe = this.channel.on({
      message: (message) => {
        void this.handleChannelMessage(message, onMessage);
      },
      cardAction: (event) => {
        void this.handleCardAction(event, onMessage);
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
    const messageText = text.length > 0 ? text : "(empty)";
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

  async editMessageText(_conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void> {
    const messageText = text.length > 0 ? text : "(empty)";
    if (shouldSendCard(options) || this.cardMessageIds.has(String(options.messageId))) {
      const messageId = String(options.messageId);
      await this.updateCardMessage(messageId, createLarkCard(messageText, options));
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

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const buffer = await this.channel.downloadResource(fileId, "image");
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(buffer);
    return {
      bytes,
      filePath: `${fileId}.jpg`,
      fileSize: buffer.byteLength,
    };
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
    this.logger.debug(inbound.kind === "media" ? "lark.media_received" : "lark.message_received", {
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
    try {
      await onMessage(inbound);
    } catch (error) {
      this.logger.error("lark.card_action_handler_failed", {
        message_id: event.messageId,
        conversation_id: event.chatId,
        user_id: event.operator.openId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async updateCardMessage(messageId: string, card: object): Promise<void> {
    const previous = this.cardUpdateQueues.get(messageId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.channel.updateCard(messageId, card));
    this.cardUpdateQueues.set(messageId, current);
    try {
      await current;
    } finally {
      if (this.cardUpdateQueues.get(messageId) === current) this.cardUpdateQueues.delete(messageId);
    }
  }

  private toInboundMessage(message: NormalizedMessage): InboundMessage | undefined {
    const imageResources = message.resources.filter((resource) => resource.type === "image");
    if (imageResources.length > 0) {
      return {
        kind: "media",
        id: message.messageId,
        messageId: message.messageId,
        conversationId: message.chatId,
        userId: message.senderId,
        photos: imageResources.map(resourceToPhoto),
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
      text,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      date: Math.floor(message.createTime / 1000),
    };
  }
}

function sendOptionsFor(options: Pick<SendMessageOptions | SendPhotoOptions, "replyToMessageId">): SendOptions {
  return options.replyToMessageId ? { replyTo: String(options.replyToMessageId) } : {};
}

export function larkDomainForSdk(domain: string | undefined): lark.Domain | string {
  if (!domain || domain === "feishu") return lark.Domain.Feishu;
  if (domain === "lark") return lark.Domain.Lark;
  return domain;
}

function shouldSendCard(options: SendMessageOptions): boolean {
  return Boolean(options.replyMarkup || options.forceReply || options.entities?.length || options.disableWebPagePreview);
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
  const caption = message.content.trim();
  return caption.length > 0 ? caption : undefined;
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
