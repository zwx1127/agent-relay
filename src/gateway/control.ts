import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isProcessAlive, readGatewayState, resolveGatewayStatePath } from "./state.ts";

export const RELAY_WORK_CONTROL_VERSION = 1;

export type RelayWorkMode = "local" | "gateway";

export interface RelayWorkControl {
  experimental: true;
  protocolVersion: number;
  mode: RelayWorkMode;
  gatewayStatePath: string;
  updatedAt: number;
}

export function relayWorkInstallDir(home = homedir()): string {
  return join(home, ".agent-relay", "experimental-relay-work");
}

export function defaultGatewayStatePath(home = homedir()): string {
  return join(relayWorkInstallDir(home), "gateway-state.json");
}

export function relayWorkControlPath(home = homedir()): string {
  return join(relayWorkInstallDir(home), "control.json");
}

export function readRelayWorkControl(path = relayWorkControlPath()): RelayWorkControl | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayWorkControl>;
    if (
      value.experimental !== true
      || value.protocolVersion !== RELAY_WORK_CONTROL_VERSION
      || (value.mode !== "local" && value.mode !== "gateway")
      || typeof value.gatewayStatePath !== "string"
      || !value.gatewayStatePath.trim()
      || typeof value.updatedAt !== "number"
    ) return undefined;
    return { ...value, gatewayStatePath: resolveGatewayStatePath(value.gatewayStatePath) } as RelayWorkControl;
  } catch {
    return undefined;
  }
}

export function requireRelayWorkControl(path = relayWorkControlPath()): RelayWorkControl {
  const control = readRelayWorkControl(path);
  if (!control) throw new Error(`Relay work Gateway setup is missing or invalid. Run the Gateway setup command first. Control file: ${path}`);
  return control;
}

export function writeRelayWorkControl(
  mode: RelayWorkMode,
  gatewayStatePath: string,
  path = relayWorkControlPath(),
): RelayWorkControl {
  const value: RelayWorkControl = {
    experimental: true,
    protocolVersion: RELAY_WORK_CONTROL_VERSION,
    mode,
    gatewayStatePath: resolveGatewayStatePath(gatewayStatePath),
    updatedAt: Date.now(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return value;
}

export function gatewayUrlForRelay(controlPath = relayWorkControlPath()): string {
  const control = requireRelayWorkControl(controlPath);
  if (control.mode === "local") {
    throw new Error("Relay work Gateway is stopped. Run `scripts/gateway.ps1 start` on Windows or `./scripts/gateway.sh start` on macOS/Linux.");
  }
  const state = readGatewayState(control.gatewayStatePath);
  if (!state || !isProcessAlive(state.pid) || !isProcessAlive(state.appServerPid)) {
    throw new Error("Relay work Gateway is unavailable. It remains in Gateway mode after an unexpected exit; run the Gateway start command to recover.");
  }
  return state.url;
}
