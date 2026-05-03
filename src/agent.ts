export function sessionKey(chatId: number, workspaceName: string): string {
  return `${chatId}:${workspaceName}`;
}
