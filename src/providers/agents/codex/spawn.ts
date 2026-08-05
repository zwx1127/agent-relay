import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
export const CODEX_VERSION_ARGS = ["--version"] as const;
export const MINIMUM_CODEX_VERSION = "0.145.0";

export interface CodexSpawnCommand {
  command: string;
  args: string[];
  resolvedCodexBin: string;
  windowsVerbatimArguments?: boolean;
}

type Env = Record<string, string | undefined>;

export function codexAppServerSpawnCommand(
  codexBin: string,
  env: Env = process.env,
  platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): CodexSpawnCommand {
  return codexSpawnCommand(codexBin, [...CODEX_APP_SERVER_ARGS], env, platform, exists);
}

export function codexAppServerWebSocketSpawnCommand(
  codexBin: string,
  url: string,
  env: Env = process.env,
  platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): CodexSpawnCommand {
  return codexSpawnCommand(codexBin, ["app-server", "--listen", url], env, platform, exists);
}

export function codexVersionSpawnCommand(
  codexBin: string,
  env: Env = process.env,
  platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): CodexSpawnCommand {
  return codexSpawnCommand(codexBin, [...CODEX_VERSION_ARGS], env, platform, exists);
}

export function parseCodexVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.exec(output.trim())?.slice(1, 4).join(".");
}

export function isCodexVersionSupported(version: string, minimum = MINIMUM_CODEX_VERSION): boolean {
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  if (actual.length !== 3 || required.length !== 3 || [...actual, ...required].some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index]!;
    const right = required[index]!;
    if (left !== right) return left > right;
  }
  return true;
}

export function codexSpawnCommand(
  codexBin: string,
  args: string[],
  env: Env = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): CodexSpawnCommand {
  if (platform !== "win32") {
    return { command: codexBin, args, resolvedCodexBin: codexBin };
  }

  const normalizedCodexBin = normalizeWindowsCommandValue(codexBin);
  const resolvedCodexBin = normalizeWindowsPowershellShim(
    resolveWindowsExecutable(normalizedCodexBin, env, exists),
    exists,
  );
  if (isWindowsCommandShim(resolvedCodexBin)) {
    return {
      command: windowsEnvValue(env, "ComSpec") || "cmd.exe",
      args: ["/d", "/s", "/c", ["call", quoteCmdCommand(resolvedCodexBin), ...args.map(quoteCmdArg)].join(" ")],
      resolvedCodexBin,
      windowsVerbatimArguments: true,
    };
  }

  return { command: resolvedCodexBin, args, resolvedCodexBin };
}

export function formatCodexSpawnError(error: unknown, codexBin: string): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const fields = source as Error & { code?: unknown; errno?: unknown; path?: unknown };
  const code = typeof fields.code === "string" ? fields.code : undefined;
  const path = typeof fields.path === "string" ? fields.path : codexBin;
  const detail = source.message ? ` Original error: ${source.message}` : "";
  let message = `Failed to start Codex app-server using CODEX_BIN=${JSON.stringify(codexBin)}.`;

  if (code === "ENOENT") {
    message += ` Codex was not found from the agent-relay process PATH. Install Codex, add it to PATH, or set CODEX_BIN to a full path such as codex.exe or C:\\Users\\Admin\\AppData\\Roaming\\npm\\codex.cmd. In PowerShell, use where.exe codex or Get-Command codex to inspect the resolved command.`;
  } else if (code === "EFTYPE") {
    message += ` ${JSON.stringify(path)} is not directly executable by uv_spawn. On Windows this usually means CODEX_BIN points at a command shim such as codex.cmd or codex.ps1; set CODEX_BIN to codex.cmd/codex.exe and use a relay build with Windows shim support.`;
  }

  const wrapped = new Error(`${message}${detail}`);
  if (code !== undefined) (wrapped as Error & { code?: string }).code = code;
  return wrapped;
}

function resolveWindowsExecutable(
  command: string,
  env: Env,
  exists: (path: string) => boolean,
): string {
  const searchDirs = windowsPathDirs(env);
  const hasDirectory = command.includes("/") || command.includes("\\") || win32.isAbsolute(command);
  const bases = hasDirectory ? [command] : [command, ...searchDirs.map((dir) => win32.join(dir, command))];
  for (const base of bases) {
    for (const candidate of windowsExecutableCandidates(base, env)) {
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

function windowsExecutableCandidates(command: string, env: Env): string[] {
  const ext = win32.extname(command);
  if (ext) return [command];
  return [command, ...windowsPathExts(env).map((pathExt) => `${command}${pathExt}`)];
}

function windowsPathDirs(env: Env): string[] {
  const pathValue = windowsEnvValue(env, "Path") || "";
  return pathValue.split(";").filter(Boolean);
}

function windowsPathExts(env: Env): string[] {
  const value = windowsEnvValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD";
  const exts = value.split(";").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return exts.length > 0 ? exts : [".COM", ".EXE", ".BAT", ".CMD"];
}

function windowsEnvValue(env: Env, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) return exact;
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

function normalizeWindowsPowershellShim(path: string, exists: (path: string) => boolean): string {
  if (win32.extname(path).toLowerCase() !== ".ps1") return path;
  const cmdPath = `${path.slice(0, -".ps1".length)}.cmd`;
  return exists(cmdPath) ? cmdPath : path;
}

function isWindowsCommandShim(path: string): boolean {
  const ext = win32.extname(path).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteCmdCommand(value: string): string {
  return `"${escapeCmdQuotedValue(value)}"`;
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"&()<>^|]/.test(value)) return value;
  return `"${escapeCmdQuotedValue(value)}"`;
}

function normalizeWindowsCommandValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  if (
    (trimmed.startsWith(String.raw`\"`) && trimmed.endsWith(String.raw`\"`))
    || (trimmed.startsWith(String.raw`\'`) && trimmed.endsWith(String.raw`\'`))
  ) {
    return trimmed.slice(2, -2);
  }
  const quote = trimmed[0];
  if ((quote === `"` || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeCmdQuotedValue(value: string): string {
  return value.replace(/(["^&()<>|])/g, "^$1");
}
