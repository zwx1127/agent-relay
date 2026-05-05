import type { AppConfig } from "../runtime/config.ts";
import type { AgentDriver } from "../ports/agent.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import type { MediaInboundMessage, ImAdapter } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";

export interface RelayControllerDeps {
  config: AppConfig;
  store: RelayStore;
  adapter: Pick<ImAdapter, "sendMessage" | "sendPhoto" | "editMessageText" | "answerCallbackQuery" | "sendChatAction" | "setMessageReaction" | "downloadFile" | "capabilities">;
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
