import type { InboundMessage, TextEntity, TextEntityType } from "../../../ports/im.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    entities?: TelegramMessageEntity[];
    caption_entities?: TelegramMessageEntity[];
    media_group_id?: string;
    photo?: Array<{ file_id: string; file_unique_id?: string; width: number; height: number; file_size?: number }>;
    document?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
    voice?: { file_id: string; file_unique_id?: string; duration: number; mime_type?: string; file_size?: number };
    audio?: { file_id: string; file_unique_id?: string; duration: number; file_name?: string; mime_type?: string; file_size?: number };
    chat: { id: number; type?: "private" | "group" | "supergroup" | "channel" };
    message_thread_id?: number;
    from?: { id: number };
    reply_to_message?: { message_id: number; message_thread_id?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; message_thread_id?: number; date?: number; chat: { id: number } };
  };
}

interface TelegramMessageEntity {
  type: "mention" | "text_mention" | "bot_command" | string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  user?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
}

type TelegramChatType = NonNullable<NonNullable<TelegramUpdate["message"]>["chat"]["type"]>;

export function normalizeBotUsername(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^@+/, "").toLowerCase();
  return normalized || undefined;
}

export function toTelegramInboundMessage(update: TelegramUpdate, botUsername: string | undefined): InboundMessage | undefined {
  const message = update.message;
  if (message?.text && message.from) {
    const mention = mentionContextForTelegram(message.text, message.entities, message.chat.type, botUsername);
    const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
    return {
      kind: "message",
      id: String(message.message_id),
      messageId: String(message.message_id),
      conversationId: String(message.chat.id),
      userId: String(message.from.id),
      text: mention.text,
      ...(mention.presentation ? { textPresentation: mention.presentation } : {}),
      ...mention.context,
      ...(topic ? { topic } : {}),
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      date: message.date,
    };
  }

  if (message?.photo?.length && message.from) {
    const mention = mentionContextForTelegram(message.caption ?? "", message.caption_entities, message.chat.type, botUsername);
    const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
    return {
      kind: "media",
      id: String(message.message_id),
      messageId: String(message.message_id),
      conversationId: String(message.chat.id),
      userId: String(message.from.id),
      ...(mention.text ? { caption: mention.text } : {}),
      ...(mention.text && mention.presentation ? { captionPresentation: mention.presentation } : {}),
      ...mention.context,
      ...(topic ? { topic } : {}),
      photos: message.photo.map((photo) => ({
        fileId: photo.file_id,
        ...(photo.file_unique_id ? { fileUniqueId: photo.file_unique_id } : {}),
        width: photo.width,
        height: photo.height,
        ...(typeof photo.file_size === "number" ? { fileSize: photo.file_size } : {}),
      })),
      ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      date: message.date,
    };
  }

  const audio = message?.voice ?? message?.audio ?? (message?.document?.mime_type?.startsWith("audio/") ? message.document : undefined);
  if (audio && message?.from) {
    const mention = mentionContextForTelegram(message.caption ?? "", message.caption_entities, message.chat.type, botUsername);
    const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
    return {
      kind: "audio",
      id: String(message.message_id),
      messageId: String(message.message_id),
      conversationId: String(message.chat.id),
      userId: String(message.from.id),
      ...(mention.text ? { caption: mention.text } : {}),
      ...(mention.text && mention.presentation ? { captionPresentation: mention.presentation } : {}),
      ...mention.context,
      ...(topic ? { topic } : {}),
      audio: {
        fileId: audio.file_id,
        ...(audio.file_unique_id ? { fileUniqueId: audio.file_unique_id } : {}),
        ...("file_name" in audio && audio.file_name ? { fileName: audio.file_name } : message.voice ? { fileName: `voice-${message.message_id}.ogg` } : {}),
        ...(audio.mime_type ? { mimeType: audio.mime_type } : message.voice ? { mimeType: "audio/ogg" } : {}),
        ...(typeof audio.file_size === "number" ? { fileSize: audio.file_size } : {}),
      },
      ...("duration" in audio && typeof audio.duration === "number" ? { durationSeconds: audio.duration } : {}),
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      date: message.date,
    };
  }

  if (message?.document && message.from) {
    const mention = mentionContextForTelegram(message.caption ?? "", message.caption_entities, message.chat.type, botUsername);
    const topic = telegramTopic(message.message_thread_id ?? message.reply_to_message?.message_thread_id);
    return {
      kind: "file",
      id: String(message.message_id),
      messageId: String(message.message_id),
      conversationId: String(message.chat.id),
      userId: String(message.from.id),
      ...(mention.text ? { caption: mention.text } : {}),
      ...(mention.text && mention.presentation ? { captionPresentation: mention.presentation } : {}),
      ...mention.context,
      ...(topic ? { topic } : {}),
      file: {
        fileId: message.document.file_id,
        ...(message.document.file_unique_id ? { fileUniqueId: message.document.file_unique_id } : {}),
        ...(message.document.file_name ? { fileName: message.document.file_name } : {}),
        ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
        ...(typeof message.document.file_size === "number" ? { fileSize: message.document.file_size } : {}),
      },
      ...(message.reply_to_message ? { replyToMessageId: String(message.reply_to_message.message_id) } : {}),
      date: message.date,
    };
  }

  const callback = update.callback_query;
  if (callback?.data && callback.message) {
    const topic = telegramTopic(callback.message.message_thread_id);
    return {
      kind: "callback_query",
      id: callback.id,
      callbackQueryId: callback.id,
      conversationId: String(callback.message.chat.id),
      userId: String(callback.from.id),
      messageId: String(callback.message.message_id),
      data: callback.data,
      ...(topic ? { topic } : {}),
      date: callback.message.date,
    };
  }
  return undefined;
}

function mentionContextForTelegram(
  text: string,
  entities: TelegramMessageEntity[] | undefined,
  chatType: TelegramChatType | undefined,
  botUsername: string | undefined,
): {
  text: string;
  presentation?: { format: "plain"; entities: TextEntity[] };
  context: { conversationType?: "direct" | "group" | "unknown"; mentionedBot?: boolean; mentionAll?: boolean; mentions?: Array<{ label: string; userId?: string; isBot?: boolean }> };
} {
  const conversationType: "direct" | "group" | "unknown" | undefined = chatType === "private" ? "direct" : chatType === "group" || chatType === "supergroup" ? "group" : chatType ? "unknown" : undefined;
  const mentions = (entities ?? [])
    .filter((entity) => entity.type === "mention" || entity.type === "text_mention")
    .map((entity) => {
      const label = text.slice(entity.offset, entity.offset + entity.length);
      return {
        label,
        ...(entity.user?.id !== undefined ? { userId: String(entity.user.id) } : {}),
        ...(entity.user?.is_bot !== undefined ? { isBot: entity.user.is_bot } : {}),
      };
    });
  const bot = normalizeBotUsername(botUsername);
  const botMentionEntities = bot ? (entities ?? []).filter((entity) => entityMentionsBot(text, entity, bot)) : [];
  const stripped = stripBotMentions(text, entities ?? [], botMentionEntities);
  const context: { conversationType?: "direct" | "group" | "unknown"; mentionedBot?: boolean; mentions?: Array<{ label: string; userId?: string; isBot?: boolean }> } = {
    ...(conversationType ? { conversationType } : {}),
    ...(conversationType === "group" ? { mentionedBot: botMentionEntities.length > 0 } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
  return {
    text: stripped.text,
    ...(stripped.entities.length > 0 ? { presentation: { format: "plain", entities: stripped.entities } } : {}),
    context,
  };
}

function entityMentionsBot(text: string, entity: TelegramMessageEntity, botUsername: string): boolean {
  const value = text.slice(entity.offset, entity.offset + entity.length);
  if (entity.type === "mention") return normalizeBotUsername(value) === botUsername && isStandaloneMentionToken(text, entity);
  if (entity.type === "text_mention") return normalizeBotUsername(entity.user?.username) === botUsername && isStandaloneMentionToken(text, entity);
  if (entity.type !== "bot_command") return false;
  const atIndex = value.indexOf("@");
  return atIndex >= 0 && normalizeBotUsername(value.slice(atIndex + 1)) === botUsername;
}

function isStandaloneMentionToken(text: string, entity: TelegramMessageEntity): boolean {
  const before = entity.offset > 0 ? text[entity.offset - 1] : undefined;
  const afterIndex = entity.offset + entity.length;
  const after = afterIndex < text.length ? text[afterIndex] : undefined;
  return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
}

function stripBotMentions(
  text: string,
  entities: TelegramMessageEntity[],
  botMentionEntities: TelegramMessageEntity[],
): { text: string; entities: TextEntity[] } {
  const deleted = new Array<boolean>(text.length).fill(false);
  const botEntities = new Set(botMentionEntities);
  for (const entity of botMentionEntities) {
    const start = clampOffset(entity.offset, text.length);
    const end = clampOffset(entity.offset + entity.length, text.length);
    const value = text.slice(start, end);
    const deleteFrom = entity.type === "bot_command" && value.includes("@")
      ? start + value.indexOf("@")
      : start;
    for (let index = deleteFrom; index < end; index += 1) deleted[index] = true;
  }

  const boundaries = new Array<number>(text.length + 1).fill(0);
  let withoutBot = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!deleted[index]) withoutBot += text[index];
    boundaries[index + 1] = withoutBot.length;
  }
  const leadingTrim = withoutBot.length - withoutBot.trimStart().length;
  const normalized = withoutBot.trim();
  const normalizedEnd = leadingTrim + normalized.length;
  const normalizedEntities = entities.flatMap((entity): TextEntity[] => {
    if (botEntities.has(entity) || !isTextEntityType(entity.type)) return [];
    const originalStart = clampOffset(entity.offset, text.length);
    const originalEnd = clampOffset(entity.offset + entity.length, text.length);
    const mappedStart = boundaries[originalStart] ?? 0;
    const mappedEnd = boundaries[originalEnd] ?? mappedStart;
    const clippedStart = Math.max(mappedStart, leadingTrim);
    const clippedEnd = Math.min(mappedEnd, normalizedEnd);
    if (clippedEnd <= clippedStart) return [];
    return [{
      type: entity.type,
      offset: clippedStart - leadingTrim,
      length: clippedEnd - clippedStart,
      ...(entity.url ? { url: entity.url } : {}),
      ...(entity.language ? { language: entity.language } : {}),
    }];
  });
  return { text: normalized, entities: normalizedEntities };
}

function clampOffset(value: number, textLength: number): number {
  return Math.max(0, Math.min(textLength, Number.isFinite(value) ? Math.floor(value) : 0));
}

function isTextEntityType(value: string): value is TextEntityType {
  return value === "bold"
    || value === "italic"
    || value === "underline"
    || value === "strikethrough"
    || value === "spoiler"
    || value === "code"
    || value === "pre"
    || value === "text_link"
    || value === "blockquote"
    || value === "expandable_blockquote";
}

function telegramTopic(messageThreadId: number | undefined): { provider: "telegram"; id: string } | undefined {
  return messageThreadId !== undefined ? { provider: "telegram", id: String(messageThreadId) } : undefined;
}
