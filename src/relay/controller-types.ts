import type { AppConfig } from "../runtime/config.ts";
import type { AgentDriver } from "../ports/agent.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import type { MediaInboundMessage, MessagingAdapter } from "../ports/messaging.ts";
import type { SQLiteStore } from "../storage/sqlite-store.ts";

export interface RelayControllerDeps {
  config: AppConfig;
  store: SQLiteStore;
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
