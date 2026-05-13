import { createHash } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
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
  contentHash: string;
  textLength: number;
}

interface CardReadbackDiagnostics {
  text: string;
  shape: string;
}

type LarkRawClient = {
  im?: {
    v1?: {
      message?: {
        get(input: { path: { message_id: string } }): Promise<unknown>;
      };
    };
  };
};

const DEFAULT_CARD_UPDATE_TIMEOUT_MS = 10_000;
const DEFAULT_CARD_ACTION_DEDUP_TTL_MS = 500;
const DEFAULT_CARD_ACTION_DISPATCH_DELAY_MS = 150;
const CARD_UPDATE_MAX_ATTEMPTS = 3;
const CARD_UPDATE_RETRY_DELAY_MS = 250;

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
      await this.updateCardMessage(messageId, createLarkCard(messageText, options), cardUpdateDiagnostics(messageText, options));
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
    this.logger.info("lark.card_action_dispatched", {
      message_id: event.messageId,
      conversation_id: event.chatId,
      user_id: event.operator.openId,
      action_tag: event.action.tag,
      callback_data: data,
      callback_nonce: callbackNonceFromActionValue(event.action.value),
      dispatch_delay_ms: this.cardActionDispatchDelayMs,
    });
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
        content_hash: diagnostics.contentHash,
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
        content_hash: diagnostics.contentHash,
        text_len: diagnostics.textLength,
      });
      await this.verifyCardUpdate(messageId, diagnostics);
    });
    this.cardUpdateQueues.set(messageId, current);
    try {
      await current;
    } catch (error) {
      this.logger.warn("lark.card_update_failed", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        content_hash: diagnostics.contentHash,
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

  private async verifyCardUpdate(messageId: string, diagnostics: CardUpdateDiagnostics): Promise<void> {
    const getMessage = channelMessageGetter(this.channel);
    if (!getMessage) {
      this.logger.debug("lark.card_update_verify_skipped", {
        message_id: messageId,
        reason: "message_get_unavailable",
      });
      return;
    }

    let content: string | undefined;
    try {
      content = messageContentFromGetResult(await getMessage(messageId));
    } catch (error) {
      this.logger.warn("lark.card_update_verify_failed", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        content_hash: diagnostics.contentHash,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    if (!content) {
      this.logger.warn("lark.card_update_verify_unavailable", {
        message_id: messageId,
        target_view: diagnostics.targetView,
        content_hash: diagnostics.contentHash,
        reason: "message_content_missing",
      });
      return;
    }

    const readback = readableTextFromMessageContent(content);
    const postUpdateTargetView = cardTargetView(readback.text);
    this.logger.info("lark.card_update_verified", {
      message_id: messageId,
      target_view: diagnostics.targetView,
      content_hash: diagnostics.contentHash,
      post_update_target_view: postUpdateTargetView,
      post_update_content_hash: contentHash({ content }),
      post_update_text_len: readback.text.length,
      post_update_matches_target: postUpdateTargetView === diagnostics.targetView,
      post_update_content_shape: readback.shape,
      post_update_first_line: firstLinePreview(readback.text),
      post_update_contains_target_title: containsViewTitle(readback.text, diagnostics.targetView),
      post_update_contains_home_title: containsViewTitle(readback.text, "home"),
    });
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

function channelMessageGetter(channel: LarkChannelClient): ((messageId: string) => Promise<unknown>) | undefined {
  const rawClient = (channel as LarkChannelClient & { rawClient?: LarkRawClient }).rawClient;
  const messageApi = rawClient?.im?.v1?.message;
  const get = messageApi?.get;
  if (typeof get !== "function") return undefined;
  return (messageId) => get.call(messageApi, { path: { message_id: messageId } });
}

function messageContentFromGetResult(result: unknown): string | undefined {
  const data = recordValue(result, "data");
  const items = arrayValue(data, "items");
  const item = items?.[0] ?? data;
  const body = recordValue(item, "body");
  const content = stringValue(body, "content") ?? stringValue(item, "content");
  return content && content.trim().length > 0 ? content : undefined;
}

function readableTextFromMessageContent(content: string): CardReadbackDiagnostics {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== "object") return { text: content, shape: "plain" };
  const cardText = readableTextFromCard(parsed);
  return cardText.text.length > 0 ? cardText : { text: content, shape: "unknown_json" };
}

function readableTextFromCard(card: object): CardReadbackDiagnostics {
  const topLevelElements = arrayValue(card, "elements");
  if (topLevelElements) {
    const text = readableTextFromElements(topLevelElements);
    if (text.length > 0) return { text, shape: "elements" };
  }

  const bodyElements = arrayValue(recordValue(card, "body"), "elements");
  if (bodyElements) {
    const text = readableTextFromElements(bodyElements);
    if (text.length > 0) return { text, shape: "body.elements" };
  }

  const recursiveLines: string[] = [];
  collectCardTextRecursive(card, recursiveLines);
  return { text: dedupeLines(recursiveLines).join("\n").trim(), shape: recursiveLines.length > 0 ? "recursive" : "unknown_json" };
}

function readableTextFromElements(elements: unknown[]): string {
  const lines: string[] = [];
  collectCardTextRecursive(elements, lines);
  return dedupeLines(lines).join("\n").trim();
}

function collectCardTextRecursive(value: unknown, lines: string[], seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectCardTextRecursive(item, lines, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.tag === "markdown" && typeof record.content === "string") {
    lines.push(stripBasicMarkdown(record.content));
  }
  if (record.tag === "text") {
    const text = stringValue(record, "text");
    if (text) lines.push(text);
  }
  const text = recordValue(record, "text");
  const textContent = stringValue(text, "content");
  if (textContent) lines.push(textContent);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) collectCardTextRecursive(item, lines, seen);
    } else {
      collectCardTextRecursive(child, lines, seen);
    }
  }
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function cardUpdateDiagnostics(text: string, options: SendMessageOptions): CardUpdateDiagnostics {
  return {
    targetView: cardTargetView(text),
    contentHash: contentHash({
      text,
      forceReply: Boolean(options.forceReply),
      inputFieldPlaceholder: options.inputFieldPlaceholder,
      disableWebPagePreview: Boolean(options.disableWebPagePreview),
      replyMarkup: options.replyMarkup,
      entities: options.entities,
    }),
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

function firstLinePreview(text: string): string {
  const firstLine = stripBasicMarkdown(text.split(/\r?\n/, 1)[0] ?? "").trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function containsViewTitle(text: string, targetView: string): boolean {
  const normalizedLines = text.split(/\r?\n/).map((line) => stripBasicMarkdown(line).trim().toLowerCase());
  if (targetView === "home") return normalizedLines.includes("relay home");
  if (targetView === "workspaces") return normalizedLines.includes("workspaces");
  if (targetView === "workspace_intro") return normalizedLines.includes("workspace");
  return normalizedLines.includes(targetView.replace(/_/g, " "));
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function stripBasicMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/`/g, "");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown, key: string): unknown[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : undefined;
}

function stringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : undefined;
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

function callbackDataFromActionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const data = record.callback_data ?? record.callbackData;
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

function callbackNonceFromActionValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nonce = record.callback_nonce ?? record.callbackNonce;
  return typeof nonce === "string" && nonce.length > 0 ? nonce : undefined;
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
