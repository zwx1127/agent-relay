import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadDotEnvFile, type Env } from "../runtime/config.ts";
import { parseBooleanEnv, parsePositiveIntegerEnv } from "../runtime/env.ts";
import { parseLogLevel, TextLogger, type LogLevel } from "../domain/logger.ts";
import {
  defaultGatewayStatePath,
  readRelayWorkControl,
  relayWorkControlPath,
  relayWorkInstallDir,
  requireRelayWorkControl,
  writeRelayWorkControl,
} from "./control.ts";
import { ensureRelayGateway, gatewayLogPath, isGatewayReady, isProcessAlive, readGatewayState } from "./state.ts";

const INSTALL_VERSION = 1;
const LINUX_BLOCK_START = "# >>> agent-relay experimental relay work >>>";
const LINUX_BLOCK_END = "# <<< agent-relay experimental relay work <<<";

type SupportedPlatform = "win32" | "darwin" | "linux";
type LinuxShellKind = "bash" | "zsh" | "fish";
type DesktopAdapter = "windows-codex-cli-path" | "macos-launch-environment" | "linux-official-app-reserved";

interface LinuxShellInstall {
  kind: LinuxShellKind;
  configPath: string;
  envFilePath: string;
}

interface GatewayInstallState {
  experimental: true;
  installVersion: number;
  platform: SupportedPlatform;
  desktopAdapter: DesktopAdapter;
  proxyPath: string;
  launcherConfigPath: string;
  controlStatePath: string;
  realCodexBin: string;
  previousCodexCliPath: string | null;
  previousUserPath: string | null;
  installedUserPath?: string;
  linuxShell?: LinuxShellInstall;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  contents?: string;
}

export interface GatewayManagementConfig {
  experimentalRelayWorkEnabled: boolean;
  experimentalRelayGatewayPort: number;
  experimentalRelayGatewayStatePath: string;
  codexBin: string;
  logLevel: LogLevel;
}

export function loadGatewayManagementConfig(env?: Env): GatewayManagementConfig {
  const effectiveEnv = env ?? { ...loadDotEnvFile(), ...process.env };
  const port = parsePositiveIntegerEnv(effectiveEnv, "EXPERIMENTAL_RELAY_GATEWAY_PORT", 18765);
  if (port > 65534) throw new Error("EXPERIMENTAL_RELAY_GATEWAY_PORT must be at most 65534.");
  return {
    experimentalRelayWorkEnabled: parseBooleanEnv(effectiveEnv, "EXPERIMENTAL_RELAY_WORK_ENABLED", false),
    experimentalRelayGatewayPort: port,
    experimentalRelayGatewayStatePath: effectiveEnv.EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH?.trim() || defaultGatewayStatePath(),
    codexBin: effectiveEnv.CODEX_BIN?.trim() || "codex",
    logLevel: parseLogLevel(effectiveEnv.LOG_LEVEL),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  if (command === "setup") return setupGatewayClients();
  if (command === "start") return startGateway();
  if (command === "stop") return stopGatewayCommand();
  if (command === "status") return showStatus();
  if (command === "remove") return removeGatewaySetup();
  throw new Error("usage: bun run gateway <setup|start|stop|status|remove>");
}

function requireEnabled(enabled: boolean): void {
  if (!enabled) throw new Error("Set EXPERIMENTAL_RELAY_WORK_ENABLED=true manually before using this experimental feature.");
}

function supportedPlatform(platform = process.platform): SupportedPlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") return platform;
  throw new Error(`Relay work Gateway setup does not support ${platform}.`);
}

function desktopAdapterFor(platform: SupportedPlatform): DesktopAdapter {
  if (platform === "win32") return "windows-codex-cli-path";
  if (platform === "darwin") return "macos-launch-environment";
  return "linux-official-app-reserved";
}

async function setupGatewayClients(): Promise<void> {
  const config = loadGatewayManagementConfig();
  requireEnabled(config.experimentalRelayWorkEnabled);
  const platform = supportedPlatform();
  const installDir = relayWorkInstallDir();
  const existing = readInstallState();
  const existingControl = readRelayWorkControl(relayWorkControlPath());
  if (existingControl?.mode === "gateway") {
    throw new Error("Gateway mode is active. Run the Gateway stop command before running setup again.");
  }
  const linuxShell = platform === "linux" ? linuxShellInstall(process.env.SHELL, homedir(), installDir) : undefined;
  const proxyPath = join(installDir, platform === "win32" ? "codex.exe" : "codex");
  const realCodexBin = resolveRealCodexBin(config.codexBin, proxyPath, existing?.realCodexBin);
  const launcherConfigPath = join(installDir, "launcher.json");
  const controlStatePath = relayWorkControlPath();
  const temporaryProxyPath = `${proxyPath}.${process.pid}.tmp`;
  const backupProxyPath = `${proxyPath}.${process.pid}.bak`;
  const snapshots = [
    snapshotFile(launcherConfigPath),
    snapshotFile(installStatePath()),
    snapshotFile(controlStatePath),
    ...(linuxShell ? [snapshotFile(linuxShell.configPath), snapshotFile(linuxShell.envFilePath)] : []),
  ];
  const currentCodexCliPath = platform === "linux" ? null : persistentCodexCliPath(platform) ?? null;
  const currentUserPath = platform === "linux" ? null : persistentUserPath(platform) ?? null;
  let environmentChanged = false;

  try {
    mkdirSync(installDir, { recursive: true });
    const launcherEntry = fileURLToPath(new URL("./codex-launcher.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["build", launcherEntry, "--compile", `--outfile=${temporaryProxyPath}`], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Failed to compile the experimental Codex launcher.");
    rmSync(backupProxyPath, { force: true });
    if (existsSync(proxyPath)) renameSync(proxyPath, backupProxyPath);
    renameSync(temporaryProxyPath, proxyPath);
    if (platform !== "win32") chmodSync(proxyPath, 0o755);

    writeJsonAtomic(launcherConfigPath, {
      experimental: true,
      controlStatePath,
      realCodexBin,
    });

    let installedUserPath: string | undefined;
    if (platform === "linux") {
      environmentChanged = true;
      installLinuxShell(linuxShell!);
    } else {
      installedUserPath = prependPathEntry(currentUserPath ?? undefined, installDir, platform);
      environmentChanged = true;
      setPersistentUserPath(installedUserPath, platform);
      setPersistentCodexCliPath(proxyPath, platform);
    }

    const installState: GatewayInstallState = {
      experimental: true,
      installVersion: INSTALL_VERSION,
      platform,
      desktopAdapter: desktopAdapterFor(platform),
      proxyPath,
      launcherConfigPath,
      controlStatePath,
      realCodexBin,
      previousCodexCliPath: existing ? existing.previousCodexCliPath : currentCodexCliPath,
      previousUserPath: existing ? existing.previousUserPath : currentUserPath,
      ...(installedUserPath ? { installedUserPath } : {}),
      ...(linuxShell ? { linuxShell } : {}),
    };
    writeJsonAtomic(installStatePath(), installState);
    writeRelayWorkControl("local", resolve(config.experimentalRelayGatewayStatePath || defaultGatewayStatePath()), controlStatePath);
    rmSync(backupProxyPath, { force: true });
    print(`setup complete; Gateway remains stopped in local mode (${proxyPath})`);
    print(platform === "linux"
      ? `open a new ${linuxShell!.kind} shell before running Codex`
      : "open a new terminal and restart Codex Desktop before running Codex");
  } catch (error) {
    rmSync(temporaryProxyPath, { force: true });
    if (existsSync(backupProxyPath)) {
      rmSync(proxyPath, { force: true });
      renameSync(backupProxyPath, proxyPath);
    }
    for (const snapshot of snapshots) restoreFile(snapshot);
    if (platform !== "linux" && environmentChanged) {
      if (platform === "darwin" && !existing) {
        removeMacLaunchEnvironment("com.agent-relay.experimental-relay-work-desktop-env", "CODEX_CLI_PATH", currentCodexCliPath ?? undefined);
        removeMacLaunchEnvironment("com.agent-relay.experimental-relay-work-cli-env", "PATH", currentUserPath ?? undefined);
      } else {
        setPersistentCodexCliPath(currentCodexCliPath ?? undefined, platform);
        setPersistentUserPath(currentUserPath ?? undefined, platform);
      }
    }
    throw error;
  }
}

async function startGateway(): Promise<void> {
  const config = loadGatewayManagementConfig();
  requireEnabled(config.experimentalRelayWorkEnabled);
  const install = requireInstallState();
  const control = requireRelayWorkControl(install.controlStatePath);
  const gatewayConfig = {
    ...config,
    codexBin: install.realCodexBin,
    experimentalRelayGatewayStatePath: control.gatewayStatePath,
  };
  const state = await ensureRelayGateway(gatewayConfig, new TextLogger(config.logLevel));
  try {
    writeRelayWorkControl("gateway", gatewayConfig.experimentalRelayGatewayStatePath, install.controlStatePath);
  } catch (error) {
    await stopGatewayAtPath(gatewayConfig.experimentalRelayGatewayStatePath);
    throw error;
  }
  print(`Gateway is ready (pid ${state.pid}, app-server ${state.appServerPid}, ${state.url})`);
  print("new Codex CLI/Desktop and Relay connections now use the shared Gateway");
}

async function stopGatewayCommand(): Promise<void> {
  const install = requireInstallState();
  const control = requireRelayWorkControl(install.controlStatePath);
  const statePath = control.gatewayStatePath;
  writeRelayWorkControl("local", statePath, install.controlStatePath);
  await stopGatewayAtPath(statePath);
  print("Gateway is stopped; new Codex CLI/Desktop processes use local mode");
}

async function removeGatewaySetup(): Promise<void> {
  const install = requireInstallState();
  const control = requireRelayWorkControl(install.controlStatePath);
  const statePath = control.gatewayStatePath;
  writeRelayWorkControl("local", statePath, install.controlStatePath);
  await stopGatewayAtPath(statePath);
  uninstallClientEnvironment(install);
  rmSync(statePath, { force: true });
  rmSync(`${statePath}.lock`, { force: true });
  rmSync(gatewayLogPath(statePath), { force: true });
  rmSync(relayWorkInstallDir(), { recursive: true, force: true });
  print("Gateway setup, launcher, control state, and user-level Gateway data were removed");
}

async function showStatus(): Promise<void> {
  const install = readInstallState();
  print(`setup: ${install ? `installed (${install.proxyPath})` : "not installed"}`);
  const controlPath = install?.controlStatePath ?? relayWorkControlPath();
  const control = readRelayWorkControl(controlPath);
  print(`mode: ${control?.mode ?? "not setup"}`);
  const statePath = control?.gatewayStatePath ?? defaultGatewayStatePath();
  const state = readGatewayState(statePath);
  if (state && isProcessAlive(state.pid) && isProcessAlive(state.appServerPid)) {
    const health = await isGatewayReady(state) ? "ready" : "unhealthy";
    print(`runtime: ${health} (pid ${state.pid}, app-server ${state.appServerPid})`);
    print(`url: ${state.url}`);
  } else if (state) {
    print(`runtime: stopped (recorded pid ${state.pid}, app-server ${state.appServerPid})`);
    print(`url: ${state.url}`);
  } else {
    print("runtime: stopped");
  }
  print(`state: ${statePath}`);
  print(`launcher: ${install?.proxyPath ?? "not installed"}`);
}

async function stopGatewayAtPath(path: string): Promise<void> {
  const state = readGatewayState(path);
  if (!state) return;
  if (isProcessAlive(state.pid)) process.kill(state.pid, "SIGTERM");
  else if (isProcessAlive(state.appServerPid)) process.kill(state.appServerPid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (isProcessAlive(state.pid) || isProcessAlive(state.appServerPid))) await Bun.sleep(100);
  if (isProcessAlive(state.appServerPid)) process.kill(state.appServerPid, "SIGTERM");
  const childDeadline = Date.now() + 5_000;
  while (Date.now() < childDeadline && (isProcessAlive(state.pid) || isProcessAlive(state.appServerPid))) await Bun.sleep(100);
  if (isProcessAlive(state.pid) || isProcessAlive(state.appServerPid)) {
    throw new Error(`Gateway did not stop cleanly (pid ${state.pid}, app-server ${state.appServerPid}); setup was kept for retry.`);
  }
  removeRuntimeState(path, state.pid);
}

function removeRuntimeState(path: string, expectedPid: number): void {
  const current = readGatewayState(path);
  if (current?.pid === expectedPid) rmSync(path, { force: true });
  const lockPath = `${path}.lock`;
  if (!existsSync(lockPath)) return;
  try {
    if (Number(readFileSync(lockPath, "utf8").trim()) === expectedPid) rmSync(lockPath, { force: true });
  } catch {
    // Startup owns validation of an unreadable stale lock.
  }
}

function uninstallClientEnvironment(state: GatewayInstallState): void {
  if (state.platform === "linux") {
    if (state.linuxShell) removeLinuxShell(state.linuxShell);
    return;
  }
  const currentCodex = persistentCodexCliPath(state.platform);
  const currentPath = persistentUserPath(state.platform);
  const withoutProxy = removePathEntry(currentPath, dirname(state.proxyPath), state.platform);
  const unchanged = state.installedUserPath !== undefined && equalPathValue(currentPath, state.installedUserPath, state.platform);
  if (state.platform === "darwin") {
    const restoredCodex = currentCodex && samePath(currentCodex, state.proxyPath, state.platform)
      ? state.previousCodexCliPath ?? undefined
      : currentCodex;
    const restoredPath = unchanged ? state.previousUserPath ?? undefined : withoutProxy;
    removeMacLaunchEnvironment("com.agent-relay.experimental-relay-work-desktop-env", "CODEX_CLI_PATH", restoredCodex);
    removeMacLaunchEnvironment("com.agent-relay.experimental-relay-work-cli-env", "PATH", restoredPath);
    return;
  }
  if (currentCodex && samePath(currentCodex, state.proxyPath, state.platform)) {
    setPersistentCodexCliPath(state.previousCodexCliPath ?? undefined, state.platform);
  }
  setPersistentUserPath(unchanged ? state.previousUserPath ?? undefined : withoutProxy, state.platform);
}

export function linuxShellInstall(shell: string | undefined, home: string, installDir: string): LinuxShellInstall {
  const name = posix.basename(shell?.trim() || "");
  if (name === "bash") return { kind: "bash", configPath: posix.join(home, ".bashrc"), envFilePath: posix.join(installDir, "client-env.sh") };
  if (name === "zsh") return { kind: "zsh", configPath: posix.join(home, ".zshrc"), envFilePath: posix.join(installDir, "client-env.sh") };
  if (name === "fish") return {
    kind: "fish",
    configPath: posix.join(home, ".config", "fish", "conf.d", "agent-relay-experimental-relay-work.fish"),
    envFilePath: posix.join(installDir, "client-env.fish"),
  };
  throw new Error("Linux Gateway setup supports the current Bash, Zsh, or Fish shell only. Set SHELL to the shell you use and retry.");
}

function installLinuxShell(shell: LinuxShellInstall): void {
  mkdirSync(dirname(shell.configPath), { recursive: true });
  mkdirSync(dirname(shell.envFilePath), { recursive: true });
  const installDir = dirname(shell.envFilePath);
  if (shell.kind === "fish") {
    writeFileSync(shell.envFilePath, `if not contains -- ${fishLiteral(installDir)} $PATH\n  set -gx PATH ${fishLiteral(installDir)} $PATH\nend\n`);
    writeFileSync(shell.configPath, `${LINUX_BLOCK_START}\nsource ${fishLiteral(shell.envFilePath)}\n${LINUX_BLOCK_END}\n`);
    return;
  }
  writeFileSync(shell.envFilePath, `case ":$PATH:" in\n  *:${shellLiteral(installDir)}:*) ;;\n  *) export PATH=${shellLiteral(installDir)}:"$PATH" ;;\nesac\n`);
  const current = existsSync(shell.configPath) ? readFileSync(shell.configPath, "utf8") : "";
  const clean = removeManagedShellBlock(current).replace(/\s*$/, "");
  const block = `${LINUX_BLOCK_START}\n[ -f ${shellLiteral(shell.envFilePath)} ] && . ${shellLiteral(shell.envFilePath)}\n${LINUX_BLOCK_END}`;
  writeFileSync(shell.configPath, `${clean ? `${clean}\n\n` : ""}${block}\n`);
}

function removeLinuxShell(shell: LinuxShellInstall): void {
  if (!existsSync(shell.configPath)) return;
  const current = readFileSync(shell.configPath, "utf8");
  const clean = removeManagedShellBlock(current);
  if (shell.kind === "fish" || !clean.trim()) rmSync(shell.configPath, { force: true });
  else writeFileSync(shell.configPath, clean);
}

export function removeManagedShellBlock(value: string): string {
  let result = value;
  while (true) {
    const start = result.indexOf(LINUX_BLOCK_START);
    if (start < 0) return result;
    const end = result.indexOf(LINUX_BLOCK_END, start);
    if (end < 0) return result;
    result = result.slice(0, start) + result.slice(end + LINUX_BLOCK_END.length);
  }
}

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function fishLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function snapshotFile(path: string): FileSnapshot {
  return existsSync(path) ? { path, existed: true, contents: readFileSync(path, "utf8") } : { path, existed: false };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) rmSync(snapshot.path, { force: true });
  else {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.contents ?? "");
  }
}

function resolveRealCodexBin(configured: string, proxyPath: string, previouslyResolved?: string): string {
  if (
    previouslyResolved
    && (isAbsolute(previouslyResolved) || previouslyResolved.includes("/") || previouslyResolved.includes("\\"))
    && !samePath(previouslyResolved, proxyPath)
  ) return previouslyResolved;
  if (isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    const candidate = resolve(configured);
    if (samePath(candidate, proxyPath)) throw new Error("CODEX_BIN resolves to the relay work launcher instead of the real Codex CLI.");
    return candidate;
  }
  const lookupPath = removePathEntry(process.env.PATH, dirname(proxyPath), process.platform);
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [configured], {
    encoding: "utf8",
    env: { ...process.env, PATH: lookupPath },
  });
  const candidate = result.status === 0
    ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value && !samePath(value, proxyPath))
    : undefined;
  if (!candidate) throw new Error(`Could not resolve the real Codex CLI executable for ${JSON.stringify(configured)}.`);
  if (samePath(candidate, proxyPath)) throw new Error("CODEX_BIN resolves to the relay work launcher instead of the real Codex CLI.");
  return candidate;
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

function installStatePath(): string {
  return join(relayWorkInstallDir(), "install.json");
}

function readInstallState(): GatewayInstallState | undefined {
  const path = installStatePath();
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GatewayInstallState>;
    if (
      value.experimental !== true
      || value.installVersion !== INSTALL_VERSION
      || !value.proxyPath
      || !value.launcherConfigPath
      || !value.controlStatePath
      || !value.realCodexBin
      || (value.platform !== "win32" && value.platform !== "darwin" && value.platform !== "linux")
    ) return undefined;
    if (value.desktopAdapter !== desktopAdapterFor(value.platform)) return undefined;
    return value as GatewayInstallState;
  } catch {
    return undefined;
  }
}

function requireInstallState(): GatewayInstallState {
  const state = readInstallState();
  if (!state) throw new Error("Gateway setup is required. Run `scripts/gateway.ps1 setup` on Windows or `./scripts/gateway.sh setup` on macOS/Linux.");
  return state;
}

function persistentCodexCliPath(platform: "win32" | "darwin"): string | undefined {
  if (platform === "win32") {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "CODEX_CLI_PATH"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    return /^\s*CODEX_CLI_PATH\s+REG_\w+\s+(.+)$/im.exec(result.stdout)?.[1]?.trim() || undefined;
  }
  const result = spawnSync("launchctl", ["getenv", "CODEX_CLI_PATH"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function persistentUserPath(platform: "win32" | "darwin"): string | undefined {
  if (platform === "win32") {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    return /^\s*Path\s+REG_\w+\s+(.+)$/im.exec(result.stdout)?.[1]?.trim() || undefined;
  }
  const result = spawnSync("launchctl", ["getenv", "PATH"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || process.env.PATH : process.env.PATH;
}

function setPersistentUserPath(value: string | undefined, platform: "win32" | "darwin"): void {
  if (platform === "win32") {
    const result = value
      ? spawnSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", value, "/f"], { stdio: "ignore" })
      : spawnSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"], { stdio: "ignore" });
    if (result.status !== 0 && value) throw new Error("Failed to update the user Path environment variable.");
    return;
  }
  setMacLaunchEnvironment("com.agent-relay.experimental-relay-work-cli-env", "PATH", value);
}

function setPersistentCodexCliPath(value: string | undefined, platform: "win32" | "darwin"): void {
  if (platform === "win32") {
    const result = value
      ? spawnSync("reg", ["add", "HKCU\\Environment", "/v", "CODEX_CLI_PATH", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" })
      : spawnSync("reg", ["delete", "HKCU\\Environment", "/v", "CODEX_CLI_PATH", "/f"], { stdio: "ignore" });
    if (result.status !== 0 && value) throw new Error("Failed to update the user CODEX_CLI_PATH environment variable.");
    return;
  }
  setMacLaunchEnvironment("com.agent-relay.experimental-relay-work-desktop-env", "CODEX_CLI_PATH", value);
}

function setMacLaunchEnvironment(label: string, name: string, value: string | undefined): void {
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (existsSync(path)) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
  if (!value) {
    rmSync(path, { force: true });
    spawnSync("launchctl", ["unsetenv", name], { stdio: "ignore" });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>${name}</string><string>${xml(value)}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`;
  writeFileSync(path, plist, { encoding: "utf8", mode: 0o600 });
  const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Failed to install the macOS ${name} environment LaunchAgent.`);
  spawnSync("launchctl", ["setenv", name, value], { stdio: "ignore" });
}

function removeMacLaunchEnvironment(label: string, name: string, restoredValue: string | undefined): void {
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (existsSync(path)) spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { stdio: "ignore" });
  rmSync(path, { force: true });
  if (restoredValue) spawnSync("launchctl", ["setenv", name, restoredValue], { stdio: "ignore" });
  else spawnSync("launchctl", ["unsetenv", name], { stdio: "ignore" });
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function print(message: string): void {
  process.stdout.write(`[experimental relay work] ${message}\n`);
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`[experimental relay work] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
