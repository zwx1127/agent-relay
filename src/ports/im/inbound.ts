import type { ConversationId, MessageId, UserId } from "../../domain/ids.ts";
import type { ImTopicContext } from "../../domain/scope.ts";
import type { TextEntity } from "./outbound.ts";

export interface InboundMediaFile {
  fileId: string;
  fileUniqueId?: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface InboundDocumentFile {
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface DownloadedFile {
  bytes: ArrayBuffer;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface DownloadFileOptions {
  kind?: "image" | "file";
  messageId?: MessageId;
}

export type ConversationType = "direct" | "group" | "unknown";

export interface InboundMention {
  label: string;
  userId?: UserId;
  isBot?: boolean;
}

export interface InboundTextPresentation {
  /** Plain text may still carry provider-native entities; Markdown is parsed only when the provider normalized rich text to Markdown. */
  format: "plain" | "markdown";
  entities?: TextEntity[];
}

export interface InboundMessageContext {
  conversationType?: ConversationType;
  /** Group messages without a direct bot mention are ignored before authorization checks. */
  mentionedBot?: boolean;
  mentionAll?: boolean;
  mentions?: InboundMention[];
  topic?: ImTopicContext;
  scopeKey?: string;
  /** Root message for provider reply/reference trees. This is not a topic id. */
  replyRootMessageId?: MessageId;
}

export interface MediaInboundMessage extends InboundMessageContext {
  kind: "media";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  caption?: string;
  captionPresentation?: InboundTextPresentation;
  photos: InboundMediaFile[];
  /** Provider-native album/group id; messages with the same id are buffered briefly and submitted together. */
  mediaGroupId?: string;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface FileInboundMessage extends InboundMessageContext {
  kind: "file";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  file: InboundDocumentFile;
  caption?: string;
  captionPresentation?: InboundTextPresentation;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface AudioInboundMessage extends InboundMessageContext {
  kind: "audio";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  audio: InboundDocumentFile;
  caption?: string;
  captionPresentation?: InboundTextPresentation;
  durationSeconds?: number;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface TextInboundMessage extends InboundMessageContext {
  kind: "message";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  text: string;
  textPresentation?: InboundTextPresentation;
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
  topic?: ImTopicContext;
  scopeKey?: string;
  date?: number;
}

export type InboundMessage = TextInboundMessage | MediaInboundMessage | AudioInboundMessage | FileInboundMessage | CallbackInboundMessage;
