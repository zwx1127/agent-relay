import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { codexSpawnCommand } from "../providers/agents/codex/spawn.ts";
import { isProcessAlive, readGatewayState } from "./state.ts";
import { relayWorkControlPath, requireRelayWorkControl } from "./control.ts";

interface LauncherConfig {
  experimental: true;
  controlStatePath: string;
  realCodexBin: string;
}

const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "exec", "e", "review", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply", "a",
  "resume", "archive", "delete", "unarchive", "fork", "cloud", "exec-server", "features", "help",
]);
const CODEX_REMOTE_TUI_COMMANDS = new Set(["resume", "fork"]);
const CODEX_NON_GATEWAY_AGENT_COMMANDS = new Set([
  "exec", "e", "review", "mcp-server", "remote-control", "exec-server",
]);
const ROOT_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox",
  "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
const APP_SERVER_OPTIONS_WITH_VALUE = new Set([
  "-c", "--config", "--enable", "--disable", "--listen", "--ws-auth", "--ws-token-file",
  "--ws-token-sha256", "--ws-shared-secret-file", "--ws-issuer", "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadLauncherConfig();
  assertNoUserRemoteOption(args);
  const control = requireRelayWorkControl(config.controlStatePath);
  if (control.mode === "local") {
    await runRealCodex(config.realCodexBin, args);
    return;
  }
  if (isNonGatewayAgentInvocation(args)) {
    throw new Error(
      "This Codex command starts an independent agent or server that cannot join the shared Gateway and is disabled while experimental relay work is enabled.",
    );
  }

  const appServerInvocation = isCodexAppServerProxyInvocation(args);
  const gatewayCli = isGatewayCliInvocation(args);
  const requestsSharedGateway = appServerInvocation || gatewayCli;

  if (!requestsSharedGateway) {
    await runRealCodex(config.realCodexBin, args);
    return;
  }
  const gateway = readGatewayState(control.gatewayStatePath);
  if (!gateway || !isProcessAlive(gateway.pid) || !isProcessAlive(gateway.appServerPid)) {
    throw new Error(`Experimental relay Gateway is unavailable. Gateway mode remains active after an unexpected exit; run the Gateway start command to recover. State: ${control.gatewayStatePath}`);
  }

  if (appServerInvocation) {
    await proxyStdioToWebSocket(gateway.url);
    return;
  }

  const rewritten = rewriteCodexRemoteArgs(args, gateway.url);
  await runRealCodex(config.realCodexBin, rewritten);
}

export function isCodexAppServerProxyInvocation(args: string[]): boolean {
  const command = topLevelCommand(args);
  return command?.name === "app-server" && !appServerSubcommand(args, command.index);
}

export function rewriteCodexRemoteArgs(args: string[], gatewayUrl: string): string[] {
  assertNoUserRemoteOption(args);
  const rewritten = [...args];
  const command = topLevelCommand(args);
  if (command && CODEX_REMOTE_TUI_COMMANDS.has(command.name)) {
    rewritten.splice(command.index + 1, 0, "--remote", gatewayUrl);
  } else {
    rewritten.unshift("--remote", gatewayUrl);
  }
  return rewritten;
}

export function assertNoUserRemoteOption(args: string[]): void {
  if (args.some((arg) => arg === "--remote" || arg.startsWith("--remote=") || arg === "--remote-auth-token-env" || arg.startsWith("--remote-auth-token-env="))) {
    throw new Error(
      "The --remote client mode is not available while the relay work launcher is installed. Run codex normally; the launcher selects local or Gateway mode automatically.",
    );
  }
}

export function isNonGatewayAgentInvocation(args: string[]): boolean {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) return false;
  const command = topLevelCommand(args);
  if (!command) return false;
  if (CODEX_NON_GATEWAY_AGENT_COMMANDS.has(command.name)) return true;
  if (command.name !== "app-server") return false;
  const appServerCommand = appServerSubcommand(args, command.index);
  return appServerCommand === "daemon" || appServerCommand === "proxy";
}

export function isGatewayCliInvocation(args: string[]): boolean {
  if (isCodexAppServerProxyInvocation(args)) return false;
  const command = topLevelCommand(args);
  if (command) return CODEX_REMOTE_TUI_COMMANDS.has(command.name);
  return !args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
}

function topLevelCommand(args: string[]): { name: string; index: number } | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return undefined;
    if (ROOT_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return CODEX_TOP_LEVEL_COMMANDS.has(arg) ? { name: arg, index } : undefined;
  }
  return undefined;
}

function appServerSubcommand(args: string[], commandIndex: number): string | undefined {
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (APP_SERVER_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function loadLauncherConfig(): LauncherConfig {
  const candidates = [
    process.env.AGENT_RELAY_WORK_LAUNCHER_CONFIG,
    join(dirname(process.execPath), "launcher.json"),
  ].filter((value): value is string => Boolean(value));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LauncherConfig>;
    if (value.experimental === true && value.controlStatePath && value.realCodexBin) {
      return value as LauncherConfig;
    }
  }
  return {
    experimental: true,
    controlStatePath: resolve(process.env.AGENT_RELAY_WORK_CONTROL_PATH || relayWorkControlPath()),
    realCodexBin: process.env.CODEX_REAL_BIN || process.env.CODEX_BIN || "codex",
  };
}

function proxyStdioToWebSocket(url: string): Promise<void> {
  return new Promise((resolveProxy, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.addEventListener("open", () => {
      process.stdin.setEncoding("utf8");
      let buffered = "";
      process.stdin.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) socket.send(line);
      });
      process.stdin.on("end", () => {
        if (buffered.trim()) socket.send(buffered);
        socket.close();
      });
      process.stdin.resume();
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const value = typeof event.data === "string" ? event.data : String(event.data);
      process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
    });
    socket.addEventListener("error", () => fail(new Error(`Failed to connect to experimental relay Gateway at ${url}.`)));
    socket.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      resolveProxy();
    });
  });
}

function runRealCodex(codexBin: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const command = codexSpawnCommand(codexBin, args, process.env);
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      ...(command.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Codex exited from signal ${signal}.`));
      else {
        process.exitCode = code ?? 1;
        resolveRun();
      }
    });
  });
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`[experimental relay work] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
