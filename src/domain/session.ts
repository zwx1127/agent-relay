import type { ConversationId, ProviderId } from "./ids.ts";

const DEFAULT_AGENT_PROVIDER = "codex";

export function sessionKey(conversationId: ConversationId, workspaceName: string, agentProvider: ProviderId = DEFAULT_AGENT_PROVIDER): string {
  return `${encodePart(agentProvider)}:${encodePart(String(conversationId))}:${encodePart(workspaceName)}`;
}

export function parseSessionKey(key: string): { agentProvider: string; conversationId: ConversationId; workspaceName: string } | undefined {
  const parts = key.split(":");
  if (parts.length === 3) {
    const [agentProvider, conversationId, workspaceName] = parts.map(decodePart);
    if (!agentProvider || !conversationId || !workspaceName) return undefined;
    return { agentProvider, conversationId, workspaceName };
  }
  if (parts.length === 2) {
    const [conversationId, workspaceName] = parts;
    if (!conversationId || !workspaceName) return undefined;
    return { agentProvider: DEFAULT_AGENT_PROVIDER, conversationId, workspaceName };
  }
  return undefined;
}

export function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function decodePart(value: string): string {
  return decodeURIComponent(value);
}
