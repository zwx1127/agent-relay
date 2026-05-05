import type { ConversationId } from "../types.ts";
import { decodePart } from "../agent.ts";

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
    return { agentProvider: "codex", conversationId, workspaceName };
  }
  return undefined;
}
