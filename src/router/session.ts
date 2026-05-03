import type { ChatId } from "../types.ts";

export function parseSessionKey(key: string): { chatId: ChatId; workspaceName: string } | undefined {
  const index = key.indexOf(":");
  if (index < 1) return undefined;
  const chatId = Number(key.slice(0, index));
  const workspaceName = key.slice(index + 1);
  if (!Number.isFinite(chatId) || workspaceName.length === 0) return undefined;
  return { chatId, workspaceName };
}
