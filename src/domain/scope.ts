import type { ConversationId, MessageId } from "./ids.ts";

export type ImTopicProvider = "telegram" | "lark";

export interface ImTopicContext {
  provider: ImTopicProvider;
  id: string;
  rootMessageId?: MessageId;
}

export interface ChatScope {
  conversationId: ConversationId;
  scopeKey: string;
  topic?: ImTopicContext;
}

export function chatScope(conversationId: ConversationId, topic?: ImTopicContext): ChatScope {
  return {
    conversationId,
    scopeKey: chatScopeKey(conversationId, topic),
    ...(topic ? { topic } : {}),
  };
}

export function chatScopeKey(conversationId: ConversationId, topic?: ImTopicContext): string {
  if (!topic?.id) return String(conversationId);
  const parts = [
    encodeURIComponent(String(conversationId)),
    topic.provider,
    encodeURIComponent(topic.id),
    topic.rootMessageId ? encodeURIComponent(String(topic.rootMessageId)) : "",
  ];
  return parts.join("|");
}

export function parseChatScopeKey(scopeKey: string): ChatScope {
  const parts = scopeKey.split("|");
  if (parts.length >= 3) {
    const conversationId = decodeURIComponent(parts[0] ?? "");
    const provider = parts[1] === "telegram" || parts[1] === "lark" ? parts[1] : undefined;
    const id = decodeURIComponent(parts[2] ?? "");
    if (conversationId && provider && id) {
      const rootMessageId = parts[3] ? decodeURIComponent(parts[3]) : undefined;
      return {
        conversationId,
        scopeKey,
        topic: {
          provider,
          id,
          ...(rootMessageId ? { rootMessageId } : {}),
        },
      };
    }
  }
  return { conversationId: scopeKey, scopeKey };
}

export function conversationIdForScope(scopeKey: string): ConversationId {
  return parseChatScopeKey(scopeKey).conversationId;
}
