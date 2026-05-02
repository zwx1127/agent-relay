import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export type Env = Record<string, string | undefined>;

export function loadDotEnvFile(path = ".env"): Env {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) return {};

  const env: Env = {};
  const text = readFileSync(resolvedPath, "utf8");
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex < 1) {
      throw new Error(`${path}:${index + 1} is not a valid KEY=value entry`);
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${path}:${index + 1} contains an invalid environment key: ${key}`);
    }

    env[key] = parseDotEnvValue(normalized.slice(equalsIndex + 1).trim());
  }

  return env;
}

function parseDotEnvValue(value: string): string {
  if (!value) return "";

  const quote = value[0];
  if ((quote === `"` || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === `"` ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, `"`) : inner;
  }

  const commentIndex = value.search(/\s#/);
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
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

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadConfig(env?: Env): AppConfig {
  const effectiveEnv = env ?? { ...loadDotEnvFile(), ...process.env };
  const allowedChats = effectiveEnv.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  return {
    telegramBotToken: requireEnv(effectiveEnv, "TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserIds: parseIdSet(requireEnv(effectiveEnv, "TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS"),
    telegramAllowedChatIds: allowedChats ? parseIdSet(allowedChats, "TELEGRAM_ALLOWED_CHAT_IDS") : undefined,
    workspaceRoot: requireEnv(effectiveEnv, "WORKSPACE_ROOT"),
    sqlitePath: effectiveEnv.SQLITE_PATH?.trim() || ".data/agent-relay.sqlite",
    codexBin: effectiveEnv.CODEX_BIN?.trim() || "codex",
    codexSandbox: effectiveEnv.CODEX_SANDBOX?.trim() || "workspace-write",
    codexApproval: effectiveEnv.CODEX_APPROVAL?.trim() || "on-request",
  };
}

export function isAuthorized(config: Pick<AppConfig, "telegramAllowedUserIds" | "telegramAllowedChatIds">, userId: number, chatId: number): boolean {
  if (!config.telegramAllowedUserIds.has(userId)) return false;
  if (config.telegramAllowedChatIds && !config.telegramAllowedChatIds.has(chatId)) return false;
  return true;
}
