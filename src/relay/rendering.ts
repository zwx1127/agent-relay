import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger, LogFields } from "../domain/logger.ts";
import type { EditMessageTextOptions, ImAdapter, InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { ensureRendered } from "./ui/text-parts.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";
import type { InboundMessage } from "../ports/im.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;
type RenderingAdapter = Pick<ImAdapter, "sendMessage" | "editMessageText" | "answerCallbackQuery">;

export class RelayMessageRenderer {
  constructor(
    private readonly adapter: RenderingAdapter,
    private readonly logger: Logger,
  ) {}

  async sendRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options: Omit<SendMessageOptions, "entities" | "parseMode"> = {},
  ): Promise<{ messageId?: MessageId }> {
    return await this.adapter.sendMessage(conversationId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  async trySendRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    failureEvent: string,
    fields: LogFields = {},
    options: Omit<SendMessageOptions, "entities" | "parseMode"> = {},
  ): Promise<void> {
    try {
      await this.sendRendered(conversationId, rendered, options);
    } catch (error) {
      this.logger.warn(failureEvent, {
        conversation_id: conversationId,
        ...fields,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async editRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options: Omit<EditMessageTextOptions, "entities" | "parseMode">,
  ): Promise<void> {
    if (!this.adapter.editMessageText) throw new Error("IM adapter cannot edit messages.");
    await this.adapter.editMessageText(conversationId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  async renderCallbackPage(
    message: CallbackMessage,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<RenderCallbackPageResult> {
    const rendered = ensureRendered(body);
    if (!message.messageId) {
      const result = await this.sendRendered(message.conversationId, rendered, { replyMarkup });
      return { method: "send", messageId: result.messageId };
    }
    try {
      await this.editRendered(message.conversationId, rendered, {
        messageId: message.messageId,
        replyMarkup,
      });
      return { method: "edit", messageId: message.messageId };
    } catch (error) {
      this.logger.warn("router.callback_edit_fallback", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      const result = await this.sendRendered(message.conversationId, rendered, { replyMarkup });
      return { method: "send", messageId: result.messageId };
    }
  }

  async renderStrictCallbackPage(
    message: CallbackMessage,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<RenderCallbackPageResult> {
    const rendered = ensureRendered(body);
    if (!message.messageId) throw new Error("Callback message is missing.");
    await this.editRendered(message.conversationId, rendered, {
      messageId: message.messageId,
      replyMarkup,
    });
    return { method: "edit", messageId: message.messageId };
  }

  async tryRenderCallbackPage(
    message: CallbackMessage,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
    failureEvent: string,
  ): Promise<void> {
    try {
      await this.renderCallbackPage(message, body, replyMarkup);
    } catch (error) {
      this.logger.warn(failureEvent, {
        conversation_id: message.conversationId,
        callback_query_id: message.callbackQueryId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.adapter.answerCallbackQuery) return;
    try {
      await this.adapter.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.logger.warn("router.callback_answer_failed", {
        callback_query_id: callbackQueryId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
