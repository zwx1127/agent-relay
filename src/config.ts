import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLogLevel, type LogLevel } from "./logger.ts";

export interface AppConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: Set<number>;
  telegramAllowedChatIds?: Set<number>;
  telegramPollTimeoutSeconds: number;
  telegramRequestRetryMaxAttempts: number;
  telegramRetryInitialDelayMs: number;
  telegramRetryMaxDelayMs: number;
  workspaceRoot: string;
  sqlitePath: string;
  codexBin: string;
  codexSandbox: string;
  codexApproval: string;
  codexDeveloperInstructions?: string;
  codexBaseInstructions?: string;
  logLevel: LogLevel;
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

function parsePositiveIntegerEnv(env: Env, name: string, defaultValue: number): number {
  const rawEnvValue = env[name];
  if (rawEnvValue === undefined) return defaultValue;
  const rawValue = rawEnvValue.trim();
  if (!rawValue) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env?: Env): AppConfig {
  const effectiveEnv = env ?? { ...loadDotEnvFile(), ...process.env };
  const allowedChats = effectiveEnv.TELEGRAM_ALLOWED_CHAT_IDS?.trim();
  const developerInstructions = combineInstructionSources(
    effectiveEnv.CODEX_DEVELOPER_INSTRUCTIONS_FILE,
    effectiveEnv.CODEX_DEVELOPER_INSTRUCTIONS,
    "CODEX_DEVELOPER_INSTRUCTIONS_FILE",
  );
  const baseInstructions = readInstructionFile(
    effectiveEnv.CODEX_MODEL_INSTRUCTIONS_FILE,
    "CODEX_MODEL_INSTRUCTIONS_FILE",
  );
  return {
    telegramBotToken: requireEnv(effectiveEnv, "TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserIds: parseIdSet(requireEnv(effectiveEnv, "TELEGRAM_ALLOWED_USER_IDS"), "TELEGRAM_ALLOWED_USER_IDS"),
    telegramAllowedChatIds: allowedChats ? parseIdSet(allowedChats, "TELEGRAM_ALLOWED_CHAT_IDS") : undefined,
    telegramPollTimeoutSeconds: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_POLL_TIMEOUT_SECONDS", 30),
    telegramRequestRetryMaxAttempts: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS", 3),
    telegramRetryInitialDelayMs: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_RETRY_INITIAL_DELAY_MS", 500),
    telegramRetryMaxDelayMs: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_RETRY_MAX_DELAY_MS", 10000),
    workspaceRoot: requireEnv(effectiveEnv, "WORKSPACE_ROOT"),
    sqlitePath: effectiveEnv.SQLITE_PATH?.trim() || ".data/agent-relay.sqlite",
    codexBin: effectiveEnv.CODEX_BIN?.trim() || "codex",
    codexSandbox: effectiveEnv.CODEX_SANDBOX?.trim() || "workspace-write",
    codexApproval: effectiveEnv.CODEX_APPROVAL?.trim() || "on-request",
    ...(developerInstructions ? { codexDeveloperInstructions: developerInstructions } : {}),
    ...(baseInstructions ? { codexBaseInstructions: baseInstructions } : {}),
    logLevel: parseLogLevel(effectiveEnv.LOG_LEVEL),
  };
}

function combineInstructionSources(filePath: string | undefined, inline: string | undefined, fileEnvName: string): string | undefined {
  const fileText = readInstructionFile(filePath, fileEnvName);
  const inlineText = inline?.trim();
  return [fileText, inlineText].filter((part): part is string => Boolean(part)).join("\n\n") || undefined;
}

function readInstructionFile(filePath: string | undefined, envName: string): string | undefined {
  const trimmed = filePath?.trim();
  if (!trimmed) return undefined;
  try {
    return readFileSync(resolve(trimmed), "utf8").trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${envName} could not be read: ${detail}`);
  }
}

export function isAuthorized(config: Pick<AppConfig, "telegramAllowedUserIds" | "telegramAllowedChatIds">, userId: number, chatId: number): boolean {
  if (!config.telegramAllowedUserIds.has(userId)) return false;
  if (config.telegramAllowedChatIds && !config.telegramAllowedChatIds.has(chatId)) return false;
  return true;
}
