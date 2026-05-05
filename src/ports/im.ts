import type { ConversationId, MessageId, ProviderId, UserId } from "../domain/ids.ts";

export type TextParseMode = "HTML";

export type TextEntityType =
  | "bold"
  | "italic"
  | "code"
  | "pre"
  | "text_link"
  | "blockquote";

export interface TextEntity {
  type: TextEntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  parseMode?: TextParseMode;
  entities?: TextEntity[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  inputFieldPlaceholder?: string;
  disableWebPagePreview?: boolean;
  replyToMessageId?: MessageId;
}

export interface EditMessageTextOptions extends SendMessageOptions {
  messageId: MessageId;
}

export interface SendMessageResult {
  messageId?: MessageId;
}

export interface SendPhotoOptions {
  caption?: string;
  replyToMessageId?: MessageId;
}

export interface InboundMediaFile {
  fileId: string;
  fileUniqueId?: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface DownloadedFile {
  bytes: ArrayBuffer;
  filePath?: string;
  fileSize?: number;
}

export interface TextInboundMessage {
  kind: "message";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  text: string;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface MediaInboundMessage {
  kind: "media";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  caption?: string;
  photos: InboundMediaFile[];
  mediaGroupId?: string;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface CallbackInboundMessage {
  kind: "callback_query";
  id: string;
  conversationId: ConversationId;
  userId: UserId;
  callbackQueryId: string;
  messageId?: MessageId;
  data: string;
  date?: number;
}

export type InboundMessage = TextInboundMessage | MediaInboundMessage | CallbackInboundMessage;

export interface ImAdapterCapabilities {
  editMessage: boolean;
  forceReply: boolean;
  inlineActions: boolean;
  reactions: boolean;
  typing: boolean;
  mediaDownload: boolean;
  imageUpload: boolean;
}

export interface ImAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: ImAdapterCapabilities;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop?(): void;
  sendMessage(conversationId: ConversationId, text: string, options?: SendMessageOptions): Promise<SendMessageResult>;
  sendPhoto?(conversationId: ConversationId, photo: Blob, options?: SendPhotoOptions): Promise<SendMessageResult>;
  editMessageText?(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction?(conversationId: ConversationId, action?: "typing"): Promise<void>;
  setMessageReaction?(conversationId: ConversationId, messageId: MessageId, emoji?: string): Promise<void>;
  downloadFile?(fileId: string): Promise<DownloadedFile>;
}
