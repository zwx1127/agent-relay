import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { loadDotEnvFile } from "../runtime/env.ts";
import type { Env } from "../runtime/config-types.ts";

const CONFIG_KEYS = new Set([
  "IM_PROVIDER", "AGENT_PROVIDER", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "ALLOWED_USER_IDS", "ALLOWED_CONVERSATION_IDS", "WORKSPACE_ROOT",
  "LARK_APP_ID", "LARK_APP_SECRET", "LARK_DOMAIN", "LARK_CARD_ACTION_DISPATCH_DELAY_MS", "TELEGRAM_POLL_TIMEOUT_SECONDS", "TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS",
  "TELEGRAM_RETRY_INITIAL_DELAY_MS", "TELEGRAM_RETRY_MAX_DELAY_MS", "MEDIA_MAX_BYTES", "SQLITE_PATH", "CODEX_BIN", "CODEX_SANDBOX", "CODEX_APPROVAL", "CLAUDE_BIN", "DSH_BIN",
  "CODEX_DEVELOPER_INSTRUCTIONS_FILE", "CODEX_DEVELOPER_INSTRUCTIONS", "CODEX_MODEL_INSTRUCTIONS_FILE", "RELAY_AGENT_NAME", "RELAY_PEER_AGENTS_FILE",
  "RELAY_CONTROL_ENABLED", "RELAY_CONTROL_PORT", "EXPERIMENTAL_RELAY_WORK_ENABLED", "EXPERIMENTAL_RELAY_GATEWAY_PORT", "EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH", "LOG_LEVEL",
]);
const PATH_KEYS = ["WORKSPACE_ROOT", "SQLITE_PATH", "CODEX_DEVELOPER_INSTRUCTIONS_FILE", "CODEX_MODEL_INSTRUCTIONS_FILE", "RELAY_PEER_AGENTS_FILE", "EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH"];

export function defaultConfigPath(env: Env = process.env, home = homedir(), platform = process.platform): string {
  if (env.AGENT_RELAY_CONFIG?.trim()) return resolve(env.AGENT_RELAY_CONFIG);
  const candidate = platform === "win32" ? env.APPDATA : env.XDG_CONFIG_HOME;
  const validRoot = candidate && (platform === "win32" ? win32.isAbsolute(candidate) : isAbsolute(candidate));
  const root = validRoot ? candidate : platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  return resolve(root, "agent-relay", "config.json");
}

export function selectConfigEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => CONFIG_KEYS.has(key) && value !== undefined));
}

export function absoluteConfigPaths(env: Env, base: string): Env {
  const result = selectConfigEnv(env);
  for (const key of PATH_KEYS) if (result[key]?.trim()) result[key] = resolve(base, result[key]!);
  for (const key of ["CODEX_BIN", "CLAUDE_BIN", "DSH_BIN"]) {
    if (result[key]?.includes("/") || result[key]?.includes("\\")) result[key] = resolve(base, result[key]!);
  }
  return result;
}

function noFollowStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function readConfigFile(path: string): Env | undefined {
  const existing = noFollowStat(path);
  if (!existing) return undefined;
  if (existing.isSymbolicLink()) throw new Error("Configuration must be a regular file, not a symlink.");
  if (!existing.isFile()) throw new Error("Configuration must be a regular file.");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Configuration must be a regular file under 1 MiB.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Configuration contains credentials and must be private. Run chmod 600 on the config file.");
    let data: unknown;
    try { data = JSON.parse(readFileSync(descriptor, "utf8")); } catch { throw new Error("Configuration is not valid JSON; its contents were not printed because they may contain credentials."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid configuration format.");
    const doc = data as { version?: unknown; env?: unknown };
    if (doc.version !== 1 || !doc.env || typeof doc.env !== "object" || Array.isArray(doc.env)) throw new Error("Unsupported configuration schema; expected version 1 and an env object.");
    const env = doc.env as Record<string, unknown>;
    if (Object.values(env).some((value) => typeof value !== "string")) throw new Error("Configuration values must be strings.");
    return absoluteConfigPaths(env as Env, dirname(resolve(path)));
  } finally { closeSync(descriptor); }
}

export function importEnvFile(path: string): Env {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new Error("The requested --env-file does not exist or is not a regular file.");
  try { return absoluteConfigPaths(loadDotEnvFile(absolute), dirname(absolute)); }
  catch { throw new Error("Could not parse --env-file. Check KEY=value syntax; contents are hidden to protect credentials."); }
}

/** Atomic replacement, no readable intermediate file and no credential-bearing backups. */
export function writeConfigFile(path: string, env: Env): void {
  path = resolve(path);
  const parent = dirname(path);
  const created = !existsSync(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (lstatSync(parent).isSymbolicLink()) throw new Error("The configuration directory must not be a symlink.");
  if (created && process.platform !== "win32") chmodSync(parent, 0o700);
  if (process.platform !== "win32" && (lstatSync(parent).mode & 0o077) !== 0) throw new Error("Choose a private configuration directory (mode 700); existing directory permissions are not changed automatically.");
  const existing = noFollowStat(path);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Refusing to replace a non-regular configuration file.");
  const temp = join(parent, `.config-${randomUUID()}.tmp`);
  const descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    try {
      writeFileSync(descriptor, JSON.stringify({ version: 1, env: absoluteConfigPaths(env, parent) }, null, 2) + "\n");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function mergeConfigEnv(config: Env, env: Env = process.env, cwd = process.cwd()): Env {
  // Saved/migrated paths are stable; deliberate environment overrides are relative to launch cwd.
  return { ...config, ...absoluteConfigPaths(selectConfigEnv(env), cwd) };
}

export function requireAbsoluteState(env: Env, configPath: string): Env {
  return { ...env, SQLITE_PATH: env.SQLITE_PATH || join(dirname(resolve(configPath)), "state", "agent-relay.sqlite") };
}
