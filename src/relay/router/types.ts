import type { AppConfig } from "../../app/config.ts";
import type { AgentDriver } from "../../agents/types.ts";
import type { ConversationId, MessageId } from "../../core/ids.ts";
import type { Logger } from "../../core/logger.ts";
import type { MediaInboundMessage, MessagingAdapter } from "../../messaging/types.ts";
import type { Store } from "../../persistence/store.ts";

export interface RouterDeps {
  config: AppConfig;
  store: Store;
  adapter: Pick<MessagingAdapter, "sendMessage" | "sendPhoto" | "editMessageText" | "answerCallbackQuery" | "sendChatAction" | "setMessageReaction" | "downloadFile" | "capabilities">;
  agent: AgentDriver;
  logger?: Logger;
}

export interface LiveOutputState {
  conversationId: ConversationId;
  text: string;
  startedAt: number;
  segmentId: number;
  turnId?: string;
  replyToMessageId?: MessageId;
  timer?: Timer;
  messageId?: MessageId;
  pageToken?: string;
  lastFlushedText?: string;
  flushPromise?: Promise<void>;
  finalPageRendered?: boolean;
}

export interface MediaGroupState {
  conversationId: ConversationId;
  messages: MediaInboundMessage[];
  timer?: Timer;
}
