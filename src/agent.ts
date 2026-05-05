import type { ConversationId, ProviderId } from "./types.ts";

const DEFAULT_AGENT_PROVIDER = "codex";

export function sessionKey(conversationId: ConversationId, workspaceName: string, agentProvider: ProviderId = DEFAULT_AGENT_PROVIDER): string {
  return `${encodePart(agentProvider)}:${encodePart(String(conversationId))}:${encodePart(workspaceName)}`;
}

export function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function decodePart(value: string): string {
  return decodeURIComponent(value);
}
