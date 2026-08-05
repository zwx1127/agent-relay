import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../runtime/config.ts";
import { loadDotEnvFile } from "../runtime/env.ts";
import { TextLogger } from "../domain/logger.ts";
import { ensureSeamlessGateway, isGatewayReady, isProcessAlive, readGatewayState, resolveGatewayStatePath } from "./state.ts";

interface DesktopInstallState {
  experimental: true;
  proxyPath: string;
  launcherConfigPath: string;
  previousCodexCliPath: string | null;
  previousUserPath?: string | null;
  installedUserPath?: string;
  realCodexBin?: string;
}

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  if (command === "start") {
    const config = loadConfig();
    requireEnabled(config.experimentalSeamlessWorkEnabled);
    const state = await ensureSeamlessGateway(config, new TextLogger(config.logLevel));
    print(`experimental seamless Gateway is running (pid ${state.pid}, app-server ${state.appServerPid}, ${state.url})`);
    return;
  }
  if (command === "stop") {
    await stopGateway();
    return;
  }
  if (command === "status") {
    await showStatus();
    return;
  }
  if (command === "desktop-enable" || command === "clients-enable") {
    const config = loadConfig();
    requireEnabled(config.experimentalSeamlessWorkEnabled);
    await ensureSeamlessGateway(config, new TextLogger(config.logLevel));
    enableDesktop(config.codexBin, resolveGatewayStatePath(config.experimentalSeamlessGatewayStatePath));
    return;
  }
  if (command === "gateway-install") {
    const config = loadConfig();
    requireEnabled(config.experimentalSeamlessWorkEnabled);
    installGatewayAutostart(config.codexBin, config.experimentalSeamlessGatewayPort, resolveGatewayStatePath(config.experimentalSeamlessGatewayStatePath));
    await ensureSeamlessGateway(config, new TextLogger(config.logLevel));
    return;
  }
  if (command === "gateway-uninstall") {
    uninstallGatewayAutostart();
    return;
  }
  if (command === "desktop-disable" || command === "clients-disable") {
    disableDesktop();
    return;
  }
  if (command === "disable") {
    disableDesktop();
    uninstallGatewayAutostart();
    await stopGateway();
    print("experimental seamless work is stopped; set EXPERIMENTAL_SEAMLESS_WORK_ENABLED=false to keep it disabled");
    return;
  }
  throw new Error("usage: bun run seamless <start|stop|status|gateway-install|gateway-uninstall|clients-enable|clients-disable|desktop-enable|desktop-disable|disable>");
}

function requireEnabled(enabled: boolean): void {
  if (!enabled) throw new Error("Set EXPERIMENTAL_SEAMLESS_WORK_ENABLED=true manually before using this experimental feature.");
}

function statePathFromEnvironment(): string {
  const env = { ...loadDotEnvFile(), ...process.env };
  return resolveGatewayStatePath(env.EXPERIMENTAL_SEAMLESS_GATEWAY_STATE_PATH?.trim() || ".data/agent-relay-gateway.json");
}

async function stopGateway(): Promise<void> {
  const path = statePathFromEnvironment();
  const state = readGatewayState(path);
  if (!state) {
    print("experimental seamless Gateway is stopped");
    return;
  }
  if (!isProcessAlive(state.pid)) {
    if (isProcessAlive(state.appServerPid)) {
      process.kill(state.appServerPid, "SIGTERM");
      const orphanDeadline = Date.now() + 5_000;
      while (Date.now() < orphanDeadline && isProcessAlive(state.appServerPid)) await Bun.sleep(100);
    }
    if (!isProcessAlive(state.appServerPid)) removeStoppedGatewayState(path, state.pid);
    print("experimental seamless Gateway is stopped");
    return;
  }
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (isProcessAlive(state.pid) || isProcessAlive(state.appServerPid))) {
    await Bun.sleep(100);
  }
  if (isProcessAlive(state.appServerPid)) process.kill(state.appServerPid, "SIGTERM");
  const childDeadline = Date.now() + 5_000;
  while (Date.now() < childDeadline && (isProcessAlive(state.pid) || isProcessAlive(state.appServerPid))) {
    await Bun.sleep(100);
  }
  if (!isProcessAlive(state.pid) && !isProcessAlive(state.appServerPid)) removeStoppedGatewayState(path, state.pid);
  print(`experimental seamless Gateway stop requested (pid ${state.pid})`);
}

function removeStoppedGatewayState(path: string, expectedPid: number): void {
  const current = readGatewayState(path);
  if (current?.pid === expectedPid) rmSync(path, { force: true });
  const lockPath = `${path}.lock`;
  if (!existsSync(lockPath)) return;
  try {
    if (Number(readFileSync(lockPath, "utf8").trim()) === expectedPid) rmSync(lockPath, { force: true });
  } catch {
    // Leave an unreadable lock for startup's stale-lock validation.
  }
}

async function showStatus(): Promise<void> {
  const path = statePathFromEnvironment();
  const state = readGatewayState(path);
  if (state && isProcessAlive(state.pid) && isProcessAlive(state.appServerPid)) {
    const health = await isGatewayReady(state) ? "ready" : "unhealthy";
    print(`experimental seamless Gateway is ${health} (pid ${state.pid}, app-server ${state.appServerPid}, ${state.url})`);
  } else {
    print("experimental seamless Gateway is stopped");
  }
  const desktop = readDesktopInstallState();
  print(`Codex CLI/Desktop proxy: ${desktop ? `enabled (${desktop.proxyPath})` : "disabled"}`);
}

function enableDesktop(realCodexBin: string, gatewayStatePath: string): void {
  const installDir = desktopInstallDir();
  mkdirSync(installDir, { recursive: true });
  const installed = readDesktopInstallState();
  const proxyPath = join(installDir, process.platform === "win32" ? "codex.exe" : "codex");
  const resolvedRealCodexBin = resolveRealCodexBin(realCodexBin, proxyPath, installed?.realCodexBin);
  const launcherEntry = fileURLToPath(new URL("./codex-launcher.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["build", launcherEntry, "--compile", `--outfile=${proxyPath}`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Failed to compile the experimental Codex desktop proxy.");
  const launcherConfigPath = join(installDir, "seamless-launcher.json");
  writeFileSync(launcherConfigPath, `${JSON.stringify({
    experimental: true,
    enabled: true,
    gatewayInteractiveCli: true,
    gatewayStatePath,
    realCodexBin: resolvedRealCodexBin,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const previous = installed?.previousCodexCliPath ?? persistentCodexCliPath() ?? null;
  const previousUserPath = installed?.previousUserPath ?? persistentUserPath() ?? null;
  setPersistentCodexCliPath(proxyPath);
  const currentUserPath = persistentUserPath() ?? (process.platform === "darwin" ? process.env.PATH : undefined);
  const installedUserPath = prependPathEntry(currentUserPath, installDir, process.platform);
  setPersistentUserPath(installedUserPath);
  const installState: DesktopInstallState = {
    experimental: true,
    proxyPath,
    launcherConfigPath,
    previousCodexCliPath: previous,
    previousUserPath,
    installedUserPath,
    realCodexBin: resolvedRealCodexBin,
  };
  writeFileSync(desktopInstallStatePath(), `${JSON.stringify(installState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (installed?.proxyPath && installed.proxyPath !== proxyPath) rmSync(installed.proxyPath, { force: true });
  print(`experimental Codex CLI/Desktop proxy enabled: ${proxyPath}`);
  print("open a new terminal for bare `codex` commands and restart Codex Desktop");
}

function disableDesktop(): void {
  const state = readDesktopInstallState();
  if (!state) {
    print("Codex CLI/Desktop proxy is already disabled");
    return;
  }
  setPersistentCodexCliPath(state.previousCodexCliPath ?? undefined);
  const currentUserPath = persistentUserPath();
  const withoutProxy = removePathEntry(currentUserPath, dirname(state.proxyPath), process.platform);
  const pathWasUnchanged = state.installedUserPath !== undefined
    && equalPathValue(currentUserPath, state.installedUserPath, process.platform);
  setPersistentUserPath(pathWasUnchanged ? state.previousUserPath ?? undefined : withoutProxy || state.previousUserPath || undefined);
  rmSync(state.proxyPath, { force: true });
  rmSync(state.launcherConfigPath, { force: true });
  rmSync(desktopInstallStatePath(), { force: true });
  print("experimental Codex CLI/Desktop proxy disabled and previous environment restored");
}

function resolveRealCodexBin(configured: string, proxyPath: string, previouslyResolved?: string): string {
  if (
    previouslyResolved
    && (isAbsolute(previouslyResolved) || previouslyResolved.includes("/") || previouslyResolved.includes("\\"))
    && !samePath(previouslyResolved, proxyPath)
  ) return previouslyResolved;
  if (isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) return resolve(configured);
  const lookupPath = removePathEntry(process.env.PATH, dirname(proxyPath), process.platform);
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [configured], {
    encoding: "utf8",
    env: { ...process.env, PATH: lookupPath },
  });
  const candidate = result.status === 0
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value && !samePath(value, proxyPath))
    : undefined;
  return candidate || configured;
}

export function prependPathEntry(value: string | undefined, entry: string, platform = process.platform): string {
  const separator = platform === "win32" ? ";" : ":";
  const entries = (value ?? "").split(separator).map((item) => item.trim()).filter(Boolean);
  return [entry, ...entries.filter((item) => !samePath(item, entry, platform))].join(separator);
}

export function removePathEntry(value: string | undefined, entry: string, platform = process.platform): string | undefined {
  const separator = platform === "win32" ? ";" : ":";
  const entries = (value ?? "").split(separator).map((item) => item.trim()).filter(Boolean)
    .filter((item) => !samePath(item, entry, platform));
  return entries.length > 0 ? entries.join(separator) : undefined;
}

function samePath(left: string, right: string, platform = process.platform): boolean {
  const normalize = (value: string): string => resolve(value).replace(/[\\/]+$/, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function equalPathValue(left: string | undefined, right: string | undefined, platform: string): boolean {
  if (left === undefined || right === undefined) return left === right;
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function installGatewayAutostart(realCodexBin: string, port: number, gatewayStatePath: string): void {
  const gatewayMain = fileURLToPath(new URL("./main.ts", import.meta.url));
  if (process.platform === "win32") {
    const installDir = desktopInstallDir();
    mkdirSync(installDir, { recursive: true });
    const launcherPath = join(installDir, "gateway-start.cmd");
    const hiddenLauncherPath = join(installDir, "gateway-start.vbs");
    const lines = [
      "@echo off",
      `cd /d "${process.cwd().replace(/"/g, '""')}"`,
      "set \"EXPERIMENTAL_SEAMLESS_WORK_ENABLED=true\"",
      `set "EXPERIMENTAL_SEAMLESS_GATEWAY_PORT=${port}"`,
      `set "EXPERIMENTAL_SEAMLESS_GATEWAY_STATE_PATH=${gatewayStatePath.replace(/"/g, '""')}"`,
      `set "CODEX_BIN=${realCodexBin.replace(/"/g, '""')}"`,
      `"${process.execPath}" "${gatewayMain}"`,
      "",
    ];
    writeFileSync(launcherPath, lines.join("\r\n"));
    writeFileSync(hiddenLauncherPath, `CreateObject("WScript.Shell").Run Chr(34) & "${launcherPath.replace(/"/g, '""')}" & Chr(34), 0, False\r\n`);
    const result = spawnSync("reg", [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "AgentRelayExperimentalSeamlessGateway",
      "/t",
      "REG_SZ",
      "/d",
      `wscript.exe "${hiddenLauncherPath}"`,
      "/f",
    ], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("Failed to install the Windows user-level Gateway startup entry.");
    print(`Windows user-level Gateway startup installed: ${launcherPath}`);
    return;
  }
  if (process.platform === "darwin") {
    const label = "com.agent-relay.experimental-seamless-gateway";
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(path), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(gatewayMain)}</string></array>
<key>WorkingDirectory</key><string>${xml(process.cwd())}</string>
<key>EnvironmentVariables</key><dict>
<key>EXPERIMENTAL_SEAMLESS_WORK_ENABLED</key><string>true</string>
<key>EXPERIMENTAL_SEAMLESS_GATEWAY_PORT</key><string>${port}</string>
<key>EXPERIMENTAL_SEAMLESS_GATEWAY_STATE_PATH</key><string>${xml(gatewayStatePath)}</string>
<key>CODEX_BIN</key><string>${xml(realCodexBin)}</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`;
    writeFileSync(path, plist, { encoding: "utf8", mode: 0o600 });
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
    const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("Failed to install the macOS Gateway LaunchAgent.");
    print(`macOS Gateway LaunchAgent installed: ${path}`);
    return;
  }
  throw new Error("Gateway autostart currently supports Windows and macOS only.");
}

function uninstallGatewayAutostart(): void {
  if (process.platform === "win32") {
    spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "AgentRelayExperimentalSeamlessGateway", "/f"], { stdio: "ignore" });
    rmSync(join(desktopInstallDir(), "gateway-start.cmd"), { force: true });
    rmSync(join(desktopInstallDir(), "gateway-start.vbs"), { force: true });
    print("Windows user-level Gateway startup removed");
    return;
  }
  if (process.platform === "darwin") {
    const path = join(homedir(), "Library", "LaunchAgents", "com.agent-relay.experimental-seamless-gateway.plist");
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (existsSync(path)) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
    rmSync(path, { force: true });
    print("macOS Gateway LaunchAgent removed");
    return;
  }
  throw new Error("Gateway autostart currently supports Windows and macOS only.");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function desktopInstallDir(): string {
  return join(homedir(), ".agent-relay", "experimental-seamless-work");
}

function desktopInstallStatePath(): string {
  return join(homedir(), ".agent-relay", "experimental-seamless-desktop.json");
}

function readDesktopInstallState(): DesktopInstallState | undefined {
  const path = desktopInstallStatePath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as DesktopInstallState;
    return value.experimental === true && value.proxyPath ? value : undefined;
  } catch {
    return undefined;
  }
}

function persistentCodexCliPath(): string | undefined {
  if (process.platform === "win32") {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "CODEX_CLI_PATH"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const match = /^\s*CODEX_CLI_PATH\s+REG_\w+\s+(.+)$/im.exec(result.stdout);
    return match?.[1]?.trim() || undefined;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["getenv", "CODEX_CLI_PATH"], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  }
  return process.env.CODEX_CLI_PATH;
}

function persistentUserPath(): string | undefined {
  if (process.platform === "win32") {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const match = /^\s*Path\s+REG_\w+\s+(.+)$/im.exec(result.stdout);
    return match?.[1]?.trim() || undefined;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["getenv", "PATH"], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() || undefined : undefined;
  }
  return process.env.PATH;
}

function setPersistentUserPath(value: string | undefined): void {
  if (process.platform === "win32") {
    const result = value
      ? spawnSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", value, "/f"], { stdio: "ignore" })
      : spawnSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], { stdio: "ignore" });
    if (result.status !== 0 && value) throw new Error("Failed to update the user Path environment variable.");
    return;
  }
  if (process.platform === "darwin") {
    const label = "com.agent-relay.experimental-seamless-cli-env";
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (existsSync(path)) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
    if (value) {
      mkdirSync(dirname(path), { recursive: true });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>PATH</string><string>${xml(value)}</string></array>
<key>RunAtLoad</key><true/></dict></plist>
`;
      writeFileSync(path, plist, { encoding: "utf8", mode: 0o600 });
      const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" });
      if (result.status !== 0) throw new Error("Failed to install the macOS Codex CLI Path LaunchAgent.");
      spawnSync("launchctl", ["setenv", "PATH", value], { stdio: "ignore" });
    } else {
      rmSync(path, { force: true });
      const result = spawnSync("launchctl", ["unsetenv", "PATH"], { stdio: "ignore" });
      if (result.status !== 0) throw new Error("Failed to clear Path through launchctl.");
    }
    return;
  }
  throw new Error("Codex CLI proxy management currently supports Windows and macOS only.");
}

function setPersistentCodexCliPath(value: string | undefined): void {
  if (process.platform === "win32") {
    const result = value
      ? spawnSync("setx", ["CODEX_CLI_PATH", value], { stdio: "ignore" })
      : spawnSync("reg", ["delete", "HKCU\\Environment", "/v", "CODEX_CLI_PATH", "/f"], { stdio: "ignore" });
    if (result.status !== 0 && value) throw new Error("Failed to update the user CODEX_CLI_PATH environment variable.");
    return;
  }
  if (process.platform === "darwin") {
    const label = "com.agent-relay.experimental-seamless-desktop-env";
    const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (existsSync(path)) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
    if (value) {
      mkdirSync(dirname(path), { recursive: true });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>CODEX_CLI_PATH</string><string>${xml(value)}</string></array>
<key>RunAtLoad</key><true/></dict></plist>
`;
      writeFileSync(path, plist, { encoding: "utf8", mode: 0o600 });
      const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" });
      if (result.status !== 0) throw new Error("Failed to install the macOS CODEX_CLI_PATH LaunchAgent.");
      spawnSync("launchctl", ["setenv", "CODEX_CLI_PATH", value], { stdio: "ignore" });
    } else {
      rmSync(path, { force: true });
      const result = spawnSync("launchctl", ["unsetenv", "CODEX_CLI_PATH"], { stdio: "ignore" });
      if (result.status !== 0) throw new Error("Failed to clear CODEX_CLI_PATH through launchctl.");
    }
    return;
  }
  throw new Error("Codex desktop proxy management currently supports Windows and macOS only.");
}

function print(message: string): void {
  process.stdout.write(`[experimental seamless work] ${message}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`[experimental seamless work] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
