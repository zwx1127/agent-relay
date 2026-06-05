import type { ConversationId, ProviderId } from "./ids.ts";
import { parseChatScopeKey } from "./scope.ts";

const DEFAULT_AGENT_PROVIDER = "codex";

export function sessionKey(scopeKey: ConversationId, workspaceName: string, agentProvider: ProviderId = DEFAULT_AGENT_PROVIDER): string {
  return `${encodePart(agentProvider)}:${encodePart(String(scopeKey))}:${encodePart(workspaceName)}`;
}

export function parseSessionKey(key: string): { agentProvider: string; conversationId: ConversationId; scopeKey: string; workspaceName: string } | undefined {
  const parts = key.split(":");
  if (parts.length === 3) {
    const [agentProvider, scopeKey, workspaceName] = parts.map(decodePart);
    if (!agentProvider || !scopeKey || !workspaceName) return undefined;
    return { agentProvider, conversationId: parseChatScopeKey(scopeKey).conversationId, scopeKey, workspaceName };
  }
  if (parts.length === 2) {
    const [scopeKey, workspaceName] = parts;
    if (!scopeKey || !workspaceName) return undefined;
    return { agentProvider: DEFAULT_AGENT_PROVIDER, conversationId: parseChatScopeKey(scopeKey).conversationId, scopeKey, workspaceName };
  }
  return undefined;
}

export function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function decodePart(value: string): string {
  return decodeURIComponent(value);
}
