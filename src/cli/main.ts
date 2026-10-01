import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import metadata from "../../package.json";
import { loadConfig, type Env } from "../runtime/config.ts";
import { absoluteConfigPaths, defaultConfigPath, importEnvFile, mergeConfigEnv, readConfigFile, requireAbsoluteState } from "./config-file.ts";
import { installAndConfigure } from "./install.ts";
import { AGENT_BACKENDS, detectAgent, backendVersionRequirement } from "./agent-detection.ts";

export interface CliArgs { command: string; subcommand?: string; configPath: string; envFile?: string; prefix?: string; packageFile?: string; }
export function parseArgs(args: string[], env: Env = process.env): CliArgs {
  let configPath = defaultConfigPath(env);
  let envFile: string | undefined;
  let prefix: string | undefined;
  let packageFile: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" || arg === "--env-file" || arg === "--prefix" || arg === "--package") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path.`);
      if (arg === "--config") configPath = resolve(value);
      else if (arg === "--env-file") envFile = resolve(value);
      else if (arg === "--prefix") prefix = resolve(value);
      else packageFile = resolve(value);
    } else if (arg === "--help" || arg === "-h") return { command: "help", configPath };
    else if (arg === "--version" || arg === "-v") return { command: "version", configPath };
    else if (arg.startsWith("-")) throw new Error("Unknown option. Run agent-relay --help; credentials must never be passed as command-line arguments.");
    else positional.push(arg);
  }
  const command = positional[0] || "start";
  if (!["install", "start", "doctor", "config", "gateway", "help", "version"].includes(command)) throw new Error("Unknown command. Run agent-relay --help.");
  if (positional.length > (command === "config" || command === "gateway" ? 2 : 1)) throw new Error("Too many arguments. Run agent-relay --help.");
  if (command === "config" && positional[1] !== "path") throw new Error("usage: agent-relay config path");
  if (command === "gateway" && !["setup", "start", "stop", "status", "remove"].includes(positional[1] || "status")) throw new Error("usage: agent-relay gateway <setup|start|stop|status|remove>");
  if ((prefix || packageFile) && command !== "install") throw new Error("--prefix and --package are only valid with install.");
  return { command, subcommand: positional[1], configPath, envFile, ...(prefix ? { prefix } : {}), ...(packageFile ? { packageFile } : {}) };
}

const HELP = `${metadata.name} ${metadata.version}
Usage: agent-relay [command] [--config <file>] [--env-file <file>]

  install        Install or reconfigure using the English setup wizard
  start          Start in foreground (default); configure with install first
  doctor         Check config, paths, Bun and the selected agent; no bot network calls
  config path    Print the selected configuration file path, never its credentials
  gateway ...    Explicit experimental setup/start/stop/status/remove
  --help         Show this help
  --version      Show package version

Install options: --prefix <directory> and --package <local.tgz> (same name/version).
install requires a TTY and confirmation before installing; it never edits PATH.
Fresh installs use a per-user prefix; installed copies reuse their own prefix.
Absolute launch commands are printed; --prefix explicitly selects another location.
install does not start the relay. --env-file imports existing .env settings into setup,
or uses them for one start/doctor invocation. Implicit cwd .env files are ignored by
this CLI. Existing source-checkout 'bun run start' keeps its .env behavior.
Configuration: --config > AGENT_RELAY_CONFIG > per-user config.json.
Values: shell environment > explicit --env-file OR saved config. No config files are
merged together. Secrets are masked during setup; never put them in CLI arguments.
Gateway setup is separate, experimental, Codex-only, and can modify native client integration.
`;

export function redactCliError(error: unknown, env: Env): string {
  let message = error instanceof Error ? error.message : "Operation failed.";
  for (const key of ["TELEGRAM_BOT_TOKEN", "LARK_APP_SECRET", "LARK_APP_ID"]) {
    const value = env[key];
    if (value) message = message.split(value).join("[redacted]");
  }
  return message.replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g, "[redacted]");
}

async function doctor(env: Env, configPath: string): Promise<void> {
  const config = loadConfig(env);
  console.log(`Bun ${Bun.version}; config: ${configPath}; provider: ${config.imProvider}; agent backend: ${config.agentProvider}`);
  let failed = false;
  if (!existsSync(config.workspaceRoot) || !statSync(config.workspaceRoot).isDirectory()) {
    console.error("Workspace root is missing or is not a directory. Create it or rerun install."); failed = true;
  } else console.log(`Workspace root: ${config.workspaceRoot}`);
  console.log(`State database: ${resolve(config.sqlitePath)}`);
  const backend = AGENT_BACKENDS[config.agentProvider];
  const binary = config.agentProvider === "codex" ? config.codexBin : config.agentProvider === "claude" ? config.claudeBin ?? "claude" : config.dshBin ?? "dsh";
  const detected = await detectAgent(config.agentProvider, binary, process.cwd());
  if (!detected.found) {
    console.error(`${backend.label} was not found or its version check failed; its output is hidden. Install/configure the native CLI yourself, then rerun install or set ${backend.binaryKey}.`); failed = true;
  } else if (!detected.version) {
    console.error(`${backend.label} version check failed; its output is hidden. Verify ${backend.binaryKey} manually.`); failed = true;
  } else if (detected.compatible === false) {
    console.error(backendVersionRequirement(config.agentProvider)); failed = true;
  } else {
    console.log(`${backend.label}${detected.version ? ` ${detected.version}` : " (version unrecognized)"} is available (authentication and bot delivery are not tested).`);
    if (config.agentProvider !== "codex") console.log("This is executable detection only; native protocol compatibility and permission behavior require an end-to-end check. Codex settings and Gateway sharing do not apply.");
  }
  console.log("Bot credentials, webhook state, Feishu permissions/events/publication and native agent authentication are not verified by doctor. Use install for opt-in credential validation, then send /relay for an end-to-end check.");
  if (failed) process.exitCode = 1;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.command === "help") { console.log(HELP); return; }
  if (parsed.command === "version") { console.log(metadata.version); return; }
  if (parsed.command === "config") { console.log(parsed.configPath); return; }
  const saved = parsed.envFile ? importEnvFile(parsed.envFile) : readConfigFile(parsed.configPath);
  const initial = requireAbsoluteState(mergeConfigEnv(saved ?? {}, process.env), parsed.configPath);
  try {
    if (parsed.command === "install") { process.exitCode = await installAndConfigure(parsed); return; }
    if (parsed.command === "gateway") {
      if (initial.AGENT_PROVIDER?.trim() && initial.AGENT_PROVIDER.trim() !== "codex") {
        throw new Error("Experimental Gateway commands require AGENT_PROVIDER=codex. They cannot manage a Claude Code or DeepSeek Harness backend.");
      }
      const entry = fileURLToPath(new URL("../gateway/manage.ts", import.meta.url));
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", entry, parsed.subcommand || "status"], {
        stdio: "inherit", env: { ...process.env, ...initial, AGENT_RELAY_DISABLE_DOTENV: "1" },
      });
      if (result.error) throw new Error("Could not start Gateway management.");
      process.exitCode = result.status ?? 1; return;
    }
    if (parsed.command === "doctor") return await doctor(initial, parsed.envFile || parsed.configPath);
    if (!saved) {
      try { loadConfig(initial); }
      catch { throw new Error("Configuration is missing or incomplete. Run agent-relay install in an interactive terminal (TTY) to configure it, then start again; or select an existing --env-file <file>."); }
    }
    const config = loadConfig(absoluteConfigPaths(initial, process.cwd()));
    // Private state by default, regardless of the caller's umask. Never write inside npm/npx caches.
    process.umask(0o077);
    mkdirSync(dirname(resolve(config.sqlitePath)), { recursive: true, mode: 0o700 });
    const { main } = await import("../runtime/bootstrap.ts");
    await main(config);
  } catch (error) { throw new Error(redactCliError(error, initial)); }
}

if (import.meta.main) {
  try { await runCli(); }
  catch (error) { console.error(redactCliError(error, process.env)); process.exitCode = 1; }
}
