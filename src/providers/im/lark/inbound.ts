import type { NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { InboundMediaFile, InboundMessage } from "../../../ports/im.ts";

export function toLarkInboundMessage(message: NormalizedMessage): InboundMessage | undefined {
  if (message.rawContentType === "interactive") return undefined;

  const imageResources = message.resources.filter((resource) => resource.type === "image");
  if (imageResources.length > 0) {
    return {
      kind: "media",
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.chatId,
      userId: message.senderId,
      ...larkMessageContext(message),
      ...larkTopicContext(message),
      photos: imageResources.map(resourceToPhoto),
      ...(captionFromMessage(message) ? { caption: captionFromMessage(message) } : {}),
      ...(captionFromMessage(message) && larkTextPresentation(message) ? { captionPresentation: larkTextPresentation(message) } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.rootId ? { replyRootMessageId: message.rootId } : {}),
      date: Math.floor(message.createTime / 1000),
    };
  }

  const audioResource = message.resources.find((resource) => resource.type === "audio");
  if (audioResource) {
    return {
      kind: "audio",
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.chatId,
      userId: message.senderId,
      ...larkMessageContext(message),
      ...larkTopicContext(message),
      audio: { fileId: audioResource.fileKey, fileName: audioResource.fileName ?? `audio-${message.messageId}` },
      ...(captionFromMessage(message) ? { caption: captionFromMessage(message) } : {}),
      ...(captionFromMessage(message) && larkTextPresentation(message) ? { captionPresentation: larkTextPresentation(message) } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.rootId ? { replyRootMessageId: message.rootId } : {}),
      date: Math.floor(message.createTime / 1000),
    };
  }

  const fileResource = message.resources.find((resource) => resource.type === "file");
  if (fileResource) {
    return {
      kind: "file",
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.chatId,
      userId: message.senderId,
      ...larkMessageContext(message),
      ...larkTopicContext(message),
      file: {
        fileId: fileResource.fileKey,
        ...(fileResource.fileName ? { fileName: fileResource.fileName } : {}),
      },
      ...(captionFromMessage(message) ? { caption: captionFromMessage(message) } : {}),
      ...(captionFromMessage(message) && larkTextPresentation(message) ? { captionPresentation: larkTextPresentation(message) } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.rootId ? { replyRootMessageId: message.rootId } : {}),
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
    ...larkMessageContext(message),
    ...larkTopicContext(message),
    text: stripLarkBotMentions(text, message),
    ...(larkTextPresentation(message) ? { textPresentation: larkTextPresentation(message) } : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    ...(message.rootId ? { replyRootMessageId: message.rootId } : {}),
    date: Math.floor(message.createTime / 1000),
  };
}

function larkTextPresentation(message: NormalizedMessage): { format: "markdown" } | undefined {
  return message.rawContentType === "post" ? { format: "markdown" } : undefined;
}

function larkTopicContext(message: NormalizedMessage): { topic?: { provider: "lark"; id: string; rootMessageId?: string } } {
  if (!message.threadId) return {};
  return {
    topic: {
      provider: "lark",
      id: message.threadId,
      ...(message.rootId ? { rootMessageId: message.rootId } : {}),
    },
  };
}

function resourceToPhoto(resource: ResourceDescriptor): InboundMediaFile {
  return { fileId: resource.fileKey, width: 0, height: 0 };
}

function captionFromMessage(message: NormalizedMessage): string | undefined {
  if (message.rawContentType === "image") return undefined;
  const caption = stripLarkBotMentions(message.content, message).trim();
  return caption.length > 0 ? caption : undefined;
}

function larkMessageContext(message: NormalizedMessage): {
  conversationType: "direct" | "group" | "unknown";
  mentionedBot: boolean;
  mentionAll: boolean;
  mentions?: Array<{ label: string; userId?: string; isBot?: boolean }>;
} {
  const mentions = message.mentions.map((mention) => ({
    label: mention.name ?? mention.key,
    ...(mention.openId ? { userId: mention.openId } : mention.userId ? { userId: mention.userId } : {}),
    ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
  }));
  return {
    conversationType: message.chatType === "p2p" ? "direct" : message.chatType === "group" ? "group" : "unknown",
    mentionedBot: message.mentionedBot,
    mentionAll: message.mentionAll,
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

function stripLarkBotMentions(text: string, message: NormalizedMessage): string {
  let next = text;
  for (const mention of message.mentions.filter((item) => item.isBot)) {
    const candidates = [mention.key, mention.name ? `@${mention.name}` : undefined, mention.name].filter((item): item is string => Boolean(item));
    for (const candidate of candidates) next = stripStandaloneLarkBotMentionCandidate(next, candidate);
  }
  return next.trim();
}

function stripStandaloneLarkBotMentionCandidate(text: string, candidate: string): string {
  let next = text;
  let searchFrom = 0;
  while (searchFrom < next.length) {
    const index = next.indexOf(candidate, searchFrom);
    if (index < 0) break;
    if (isStandaloneTextToken(next, index, candidate.length)) {
      next = `${next.slice(0, index)}${next.slice(index + candidate.length)}`;
      searchFrom = Math.max(0, index - 1);
    } else {
      searchFrom = index + candidate.length;
    }
  }
  return next;
}

function isStandaloneTextToken(text: string, offset: number, length: number): boolean {
  const before = offset > 0 ? text[offset - 1] : undefined;
  const afterIndex = offset + length;
  const after = afterIndex < text.length ? text[afterIndex] : undefined;
  return (!before || /\s/.test(before)) && (!after || /\s/.test(after));
}
