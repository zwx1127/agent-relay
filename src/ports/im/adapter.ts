import type { ConversationId, MessageId, ProviderId } from "../../domain/ids.ts";
import type { ImTopicContext } from "../../domain/scope.ts";
import type { DownloadedFile, DownloadFileOptions, InboundMessage } from "./inbound.ts";
import type {
  EditMessageTextOptions,
  SendFileOptions,
  SendMessageOptions,
  SendMessageResult,
  SendPhotoOptions,
} from "./outbound.ts";

export interface ImAdapterCapabilities {
  editMessage: boolean;
  forceReply: boolean;
  inlineActions: boolean;
  reactions: boolean;
  typing: boolean;
  mediaDownload: boolean;
  imageUpload: boolean;
  fileUpload: boolean;
}

export interface MessageReactionOptions {
  /** Ask providers that support it to emphasize the reaction animation. */
  isBig?: boolean;
}

export interface ImAdapter {
  readonly providerId: ProviderId;
  /** Capabilities describe provider support; optional methods are still checked at call sites. */
  readonly capabilities: ImAdapterCapabilities;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop?(): void;
  sendMessage(conversationId: ConversationId, text: string, options?: SendMessageOptions): Promise<SendMessageResult>;
  sendPhoto?(conversationId: ConversationId, photo: Blob, options?: SendPhotoOptions): Promise<SendMessageResult>;
  sendFile?(conversationId: ConversationId, file: Blob, options?: SendFileOptions): Promise<SendMessageResult>;
  editMessageText?(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void>;
  deleteMessage?(conversationId: ConversationId, messageId: MessageId): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction?(conversationId: ConversationId, action?: "typing", options?: { topic?: ImTopicContext }): Promise<void>;
  setMessageReaction?(conversationId: ConversationId, messageId: MessageId, emoji?: string, options?: MessageReactionOptions): Promise<void>;
  downloadFile?(fileId: string, options?: DownloadFileOptions): Promise<DownloadedFile>;
}
