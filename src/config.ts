export interface AppConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: Set<number>;
  telegramAllowedChatIds?: Set<number>;
  workspaceRoot: string;
  sqlitePath: string;
  codexBin: string;
  codexSandbox: string;
  codexApproval: string;
}

export function parseIdSet(value: string, name: string): Set<number> {
  const ids = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    if (!/^-?\d+$/.test(part)) {
      throw new Error(`${name} contains a non-integer id: ${part}`);
    }
    ids.add(Number(part));
  }
  if (ids.size === 0) {
    throw new Error(`${name} must contain at least one id`);
  }
  return ids;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowedChats = env.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  return {
    telegramBotToken: requireEnv(env, "TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserIds: parseIdSet(requireEnv(env, "TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS"),
    telegramAllowedChatIds: allowedChats ? parseIdSet(allowedChats, "TELEGRAM_ALLOWED_CHAT_IDS") : undefined,
    workspaceRoot: requireEnv(env, "WORKSPACE_ROOT"),
    sqlitePath: env.SQLITE_PATH?.trim() || ".data/agent-relay.sqlite",
    codexBin: env.CODEX_BIN?.trim() || "codex",
    codexSandbox: env.CODEX_SANDBOX?.trim() || "workspace-write",
    codexApproval: env.CODEX_APPROVAL?.trim() || "on-request",
  };
}

export function isAuthorized(config: Pick<AppConfig, "telegramAllowedUserIds" | "telegramAllowedChatIds">, userId: number, chatId: number): boolean {
  if (!config.telegramAllowedUserIds.has(userId)) return false;
  if (config.telegramAllowedChatIds && !config.telegramAllowedChatIds.has(chatId)) return false;
  return true;
}
