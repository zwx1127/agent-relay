import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLogLevel } from "../domain/logger.ts";
import type { AppConfig, Env } from "./config-types.ts";
import { loadDotEnvFile, parseBooleanEnv, parseNonNegativeIntegerEnv, parsePositiveIntegerEnv, parseStringSet, requireEnv } from "./env.ts";
import { normalizeTelegramUsername, parsePeerAgentsFile } from "./peer-agents.ts";

export type { AppConfig, Env, RelayPeerAgent } from "./config-types.ts";
export { loadDotEnvFile, parseStringSet } from "./env.ts";

export function loadConfig(env?: Env): AppConfig {
  const effectiveEnv = env ?? { ...loadDotEnvFile(), ...process.env };
  rejectDeprecatedEnv(effectiveEnv, "MESSAGING_PROVIDER", "IM_PROVIDER");
  const imProvider = parseImProvider(effectiveEnv.IM_PROVIDER?.trim() || "telegram");
  const agentProvider = parseAgentProvider(effectiveEnv.AGENT_PROVIDER?.trim() || "codex");
  const allowedConversations = effectiveEnv.ALLOWED_CONVERSATION_IDS?.trim();
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
    imProvider,
    agentProvider,
    allowedUserIds: parseStringSet(requireEnv(effectiveEnv, "ALLOWED_USER_IDS"), "ALLOWED_USER_IDS"),
    allowedConversationIds: allowedConversations ? parseStringSet(allowedConversations, "ALLOWED_CONVERSATION_IDS") : undefined,
    mediaMaxBytes: parsePositiveIntegerEnv(effectiveEnv, "MEDIA_MAX_BYTES", 20 * 1024 * 1024),
    ...(imProvider === "telegram" ? { telegramBotToken: requireEnv(effectiveEnv, "TELEGRAM_BOT_TOKEN") } : {}),
    ...(effectiveEnv.TELEGRAM_BOT_USERNAME?.trim() ? { telegramBotUsername: normalizeTelegramUsername(effectiveEnv.TELEGRAM_BOT_USERNAME) } : {}),
    telegramPollTimeoutSeconds: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_POLL_TIMEOUT_SECONDS", 30),
    telegramRequestRetryMaxAttempts: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS", 3),
    telegramRetryInitialDelayMs: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_RETRY_INITIAL_DELAY_MS", 500),
    telegramRetryMaxDelayMs: parsePositiveIntegerEnv(effectiveEnv, "TELEGRAM_RETRY_MAX_DELAY_MS", 10000),
    ...(imProvider === "lark" ? {
      larkAppId: requireEnv(effectiveEnv, "LARK_APP_ID"),
      larkAppSecret: requireEnv(effectiveEnv, "LARK_APP_SECRET"),
    } : {}),
    larkDomain: parseLarkDomain(effectiveEnv.LARK_DOMAIN?.trim() || "feishu"),
    larkCardActionDispatchDelayMs: parseNonNegativeIntegerEnv(effectiveEnv, "LARK_CARD_ACTION_DISPATCH_DELAY_MS", 150),
    workspaceRoot: requireEnv(effectiveEnv, "WORKSPACE_ROOT"),
    sqlitePath: effectiveEnv.SQLITE_PATH?.trim() || ".data/agent-relay.sqlite",
    codexBin: effectiveEnv.CODEX_BIN?.trim() || "codex",
    codexSandbox: effectiveEnv.CODEX_SANDBOX?.trim() || "workspace-write",
    codexApproval: effectiveEnv.CODEX_APPROVAL?.trim() || "on-request",
    ...(developerInstructions ? { codexDeveloperInstructions: developerInstructions } : {}),
    ...(baseInstructions ? { codexBaseInstructions: baseInstructions } : {}),
    ...(effectiveEnv.RELAY_AGENT_NAME?.trim() ? { relayAgentName: effectiveEnv.RELAY_AGENT_NAME.trim() } : {}),
    relayPeerAgents: parsePeerAgentsFile(effectiveEnv.RELAY_PEER_AGENTS_FILE),
    relayControlEnabled: parseBooleanEnv(effectiveEnv, "RELAY_CONTROL_ENABLED", false),
    relayControlPort: parseNonNegativeIntegerEnv(effectiveEnv, "RELAY_CONTROL_PORT", 0),
    logLevel: parseLogLevel(effectiveEnv.LOG_LEVEL),
  };
}

function rejectDeprecatedEnv(env: Env, deprecatedName: string, replacementName: string): void {
  if (env[deprecatedName] !== undefined) {
    throw new Error(`${deprecatedName} has been renamed to ${replacementName}`);
  }
}

function parseImProvider(value: string): AppConfig["imProvider"] {
  if (value === "telegram") return value;
  if (value === "lark") return value;
  throw new Error(`IM_PROVIDER is not supported: ${value}`);
}

function parseLarkDomain(value: string): AppConfig["larkDomain"] {
  if (value === "feishu") return value;
  if (value === "lark") return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value.replace(/\/$/, "")) return url.origin;
  } catch {
    // Fall through to the normalized error below.
  }
  throw new Error("LARK_DOMAIN must be `feishu`, `lark`, or an HTTPS origin");
}

function parseAgentProvider(value: string): AppConfig["agentProvider"] {
  if (value === "codex") return value;
  throw new Error(`AGENT_PROVIDER is not supported: ${value}`);
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

export function isAuthorized(config: Pick<AppConfig, "allowedUserIds" | "allowedConversationIds">, userId: string | number, conversationId: string | number): boolean {
  const userKey = String(userId);
  const conversationKey = String(conversationId);
  if (!config.allowedUserIds.has(userKey)) return false;
  if (config.allowedConversationIds && !config.allowedConversationIds.has(conversationKey)) return false;
  return true;
}

export const parseIdSet = parseStringSet;
