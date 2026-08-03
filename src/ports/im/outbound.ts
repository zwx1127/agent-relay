import type { MessageId } from "../../domain/ids.ts";
import type { ImTopicContext } from "../../domain/scope.ts";

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
  /** Offsets are provider-facing UTF-16 positions, matching Telegram entity semantics. */
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
  /** Entity rendering is preferred over parse mode when the provider supports it. */
  parseMode?: TextParseMode;
  entities?: TextEntity[];
  mentions?: OutboundMention[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  forceReplyInstruction?: string;
  inputFieldPlaceholder?: string;
  disableWebPagePreview?: boolean;
  replyToMessageId?: MessageId;
  topic?: ImTopicContext;
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
  topic?: ImTopicContext;
}

export interface SendFileOptions {
  filename?: string;
  caption?: string;
  replyToMessageId?: MessageId;
  topic?: ImTopicContext;
}

export interface OutboundMention {
  label: string;
  telegramUsername?: string;
  larkOpenId?: string;
  larkUserId?: string;
}
