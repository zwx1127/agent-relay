import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Logger } from "../domain/logger.ts";
import type { AppConfig } from "../runtime/config.ts";

export const SEAMLESS_GATEWAY_PROTOCOL_VERSION = 1;

export interface SeamlessGatewayState {
  experimental: true;
  protocolVersion: number;
  pid: number;
  appServerPid: number;
  url: string;
  startedAt: number;
}

export function resolveGatewayStatePath(path: string, cwd = process.cwd()): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function gatewayLogPath(statePath: string): string {
  return statePath.toLowerCase().endsWith(".json") ? statePath.slice(0, -5) + ".log" : `${statePath}.log`;
}

export function readGatewayState(path: string): SeamlessGatewayState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SeamlessGatewayState>;
    if (
      value.experimental !== true
      || value.protocolVersion !== SEAMLESS_GATEWAY_PROTOCOL_VERSION
      || !Number.isInteger(value.pid)
      || !Number.isInteger(value.appServerPid)
      || typeof value.url !== "string"
      || !value.url.startsWith("ws://127.0.0.1:")
      || typeof value.startedAt !== "number"
    ) return undefined;
    return value as SeamlessGatewayState;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isGatewayReady(state: SeamlessGatewayState): Promise<boolean> {
  const healthUrl = state.url.replace(/^ws:/, "http:").replace(/\/$/, "") + "/readyz";
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureSeamlessGateway(
  config: AppConfig,
  logger: Logger,
  options: { timeoutMs?: number } = {},
): Promise<SeamlessGatewayState> {
  if (!config.experimentalSeamlessWorkEnabled) {
    throw new Error("Experimental seamless work is disabled.");
  }
  const statePath = resolveGatewayStatePath(config.experimentalSeamlessGatewayStatePath);
  const existing = readGatewayState(statePath);
  if (existing && isProcessAlive(existing.pid) && isProcessAlive(existing.appServerPid)) {
    if (await isGatewayReady(existing)) return existing;
    throw new Error(`Experimental seamless Gateway is running but unhealthy at ${existing.url}; refusing to start a second app-server.`);
  }
  if (existsSync(statePath)) unlinkSync(statePath);
  mkdirSync(dirname(statePath), { recursive: true });

  const gatewayMain = fileURLToPath(new URL("./main.ts", import.meta.url));
  const child = spawn(process.execPath, [gatewayMain], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EXPERIMENTAL_SEAMLESS_WORK_ENABLED: "true",
      EXPERIMENTAL_SEAMLESS_GATEWAY_PORT: String(config.experimentalSeamlessGatewayPort),
      EXPERIMENTAL_SEAMLESS_GATEWAY_STATE_PATH: statePath,
      CODEX_BIN: config.codexBin,
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  logger.warn("seamless.gateway_starting", {
    experimental: true,
    gateway_pid: child.pid,
    state_path: statePath,
  });

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const state = readGatewayState(statePath);
    if (state && isProcessAlive(state.pid) && isProcessAlive(state.appServerPid) && await isGatewayReady(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Experimental seamless Gateway failed to start. Check ${gatewayLogPath(statePath)}.`);
}
