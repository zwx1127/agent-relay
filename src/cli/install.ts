import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import metadata from "../../package.json";
import type { Env } from "../runtime/config-types.ts";
import { selectConfigEnv } from "./config-file.ts";
import { TerminalWizardUI, terminalText, WizardCancelledError, type WizardUI } from "./prompts.ts";

export interface ProcessCommand { command: string; args: string[]; }
export interface ProcessResult { code: number; stdout: string; }
export type InstallRunner = (command: ProcessCommand, env: Env, capture?: boolean) => Promise<ProcessResult>;
export interface InstallOptions {
  configPath: string;
  envFile?: string;
  prefix?: string;
  packageFile?: string;
  env?: Env;
  ui?: WizardUI;
  isTTY?: boolean;
  run?: InstallRunner;
}

export function defaultInstallPrefix(env: Env = process.env, home = homedir(), platform: string = process.platform): string {
  const paths = platform === "win32" ? win32 : { isAbsolute, join };
  const candidate = platform === "win32" ? env.LOCALAPPDATA : env.XDG_DATA_HOME;
  const root = candidate && paths.isAbsolute(candidate) ? candidate
    : platform === "win32" ? paths.join(home, "AppData", "Local") : join(home, ".local", "share");
  return paths.join(root, "agent-relay", "npm");
}

export function installedPaths(prefix: string, platform: string = process.platform) {
  const paths = platform === "win32" ? win32 : { join };
  const root = paths.join(prefix, ...(platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]), metadata.name);
  return { root, launcher: paths.join(root, "bin", "agent-relay.mjs"), executable: paths.join(prefix, ...(platform === "win32" ? ["agent-relay.cmd"] : ["bin", "agent-relay"])) };
}

/** Discover only a persistent npm layout, not a source tree or an npx cache. */
export function currentInstallPrefix(packageRoot = fileURLToPath(new URL("../..", import.meta.url)), platform: string = process.platform): string | undefined {
  const paths = platform === "win32" ? win32 : { resolve, join };
  const prefix = paths.resolve(packageRoot, platform === "win32" ? "../../.." : "../../../..");
  const installed = installedPaths(prefix, platform);
  return paths.resolve(installed.root) === paths.resolve(packageRoot) && existsSync(installed.executable) ? prefix : undefined;
}

/** Quote a complete executable or argument for the user's POSIX shell / PowerShell. */
export function shellQuote(value: string, platform: string = process.platform): string {
  const safe = terminalText(value);
  return platform === "win32" ? `'${safe.replace(/'/g, "''")}'` : `'${safe.replace(/'/g, `'"'"'`)}'`;
}
export function launchCommand(executable: string, platform: string = process.platform): string {
  return `${platform === "win32" ? "& " : ""}${shellQuote(executable, platform)}`;
}

/** Read only the tarball manifest: no extraction, scripts, network, or destination writes. */
export function validatePackageFile(file: string): void {
  if (!file.endsWith(".tgz") || !existsSync(file) || !statSync(file).isFile() || statSync(file).size > 32 * 1024 * 1024) {
    throw new Error("--package requires a local npm .tgz file under 32 MiB. Use npm pack to create it.");
  }
  let manifest: { name?: unknown; version?: unknown } | undefined;
  try {
    const tar = gunzipSync(readFileSync(file), { maxOutputLength: 64 * 1024 * 1024 });
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
      if (!name) break;
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error();
      if (name === "package/package.json" && [0, 48].includes(header[156]!)) {
        if (size > 1024 * 1024 || manifest) throw new Error();
        manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } catch { throw new Error("Could not read the local npm tarball manifest. Recreate it with npm pack."); }
  if (manifest?.name !== metadata.name || manifest?.version !== metadata.version) {
    throw new Error(`The tarball must contain ${metadata.name}@${metadata.version}, matching this installer. No installation was attempted.`);
  }
}

export function npmCommand(env: Env, node: string, platform: string = process.platform, find = (name: string) => Bun.which(name)): ProcessCommand {
  const inherited = env.npm_execpath;
  if (inherited && basename(inherited) === "npm-cli.js" && existsSync(inherited)) return { command: node, args: [inherited] };
  const executable = find(platform === "win32" ? "npm.cmd" : "npm");
  if (!executable) throw new Error("npm was not found. Install Node.js 20+ with npm and retry; no installation was attempted.");
  if (platform === "win32") {
    const cli = win32.join(win32.dirname(executable), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) throw new Error("Could not locate npm's npm-cli.js beside npm.cmd. Repair your Node.js/npm installation and retry.");
    // Never interpolate user-supplied paths into cmd.exe or PowerShell.
    return { command: node, args: [cli] };
  }
  const target = realpathSync(executable);
  return target.endsWith(".js") ? { command: node, args: [target] } : { command: executable, args: [] };
}

export const runInstallProcess: InstallRunner = (command, env, capture = false) => new Promise((resolveResult) => {
  const child = spawn(command.command, command.args, { env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: false });
  let stdout = "";
  child.stdout?.on("data", (data: Buffer) => { if (stdout.length < 8192) stdout += data.toString().slice(0, 8192 - stdout.length); });
  // Captured diagnostic output can contain private data; never forward it.
  child.stderr?.resume();
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const finish = (code: number) => { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); resolveResult({ code, stdout }); };
  child.once("error", () => finish(1));
  child.once("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
});

function matchingInstall(prefix: string, runningRuntime?: string): boolean {
  const paths = installedPaths(prefix);
  try {
    const installed = JSON.parse(readFileSync(join(paths.root, "package.json"), "utf8"));
    return installed.name === metadata.name && installed.version === metadata.version
      && [paths.launcher, paths.executable, join(paths.root, "src", "cli", "setup.ts"), runningRuntime ?? join(paths.root, "node_modules", "bun", "bin", "bun.exe")].every(existsSync);
  } catch { return false; }
}

export async function installAndConfigure(options: InstallOptions): Promise<number> {
  if (!(options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error("Install and setup require an interactive terminal (TTY). No persistent installation or configuration was changed. Run agent-relay install in a terminal.");
  }
  const env = options.env ?? process.env;
  const ownPrefix = currentInstallPrefix();
  const prefix = resolve(options.prefix ?? ownPrefix ?? defaultInstallPrefix(env));
  if (/[\u0000-\u001f\u007f]/.test(prefix)) throw new Error("The installation prefix must not contain control characters.");
  if (existsSync(prefix) && !statSync(prefix).isDirectory()) throw new Error("The installation prefix must be a directory.");
  const packageFile = options.packageFile ? resolve(options.packageFile) : undefined;
  if (packageFile) validatePackageFile(packageFile);
  const paths = installedPaths(prefix);
  // Reconfiguration may reuse the Bun that already launched this installed copy,
  // including an explicit external runtime. Fresh installs still verify bundled Bun.
  const runningRuntime = !packageFile && prefix === ownPrefix ? process.execPath : undefined;
  const node = env.AGENT_RELAY_NODE_PATH || Bun.which("node");
  if (!node) throw new Error("Node.js 20+ was not found. Install Node.js with npm and retry.");
  const run = options.run ?? runInstallProcess;
  const ui = options.ui ?? new TerminalWizardUI();
  const childEnv: Env = { ...env };
  delete childEnv.AGENT_RELAY_BUN_PATH;
  if (runningRuntime) childEnv.AGENT_RELAY_BUN_PATH = runningRuntime;
  // npm and dependency lifecycle scripts do not need bot credentials or relay settings.
  const npmEnv: Env = { ...childEnv };
  delete npmEnv.AGENT_RELAY_BUN_PATH;
  for (const key of Object.keys(selectConfigEnv(npmEnv))) delete npmEnv[key];
  let installed = false;
  try {
    const candidate = !packageFile && matchingInstall(prefix, runningRuntime);
    const priorCheck = candidate ? await run({ command: node, args: [paths.launcher, "--version"] }, childEnv, true) : undefined;
    if (priorCheck && [130, 143].includes(priorCheck.code)) {
      ui.write("Installation check interrupted. Configuration was not opened or changed."); return priorCheck.code;
    }
    const already = priorCheck?.code === 0 && priorCheck.stdout.trim() === metadata.version;
    const npm = already ? undefined : npmCommand(env, node);
    ui.write(`Install and configure ${metadata.name}@${metadata.version}\nPersistent npm prefix: ${terminalText(prefix)}\nExecutable: ${terminalText(paths.executable)}\nConfiguration: ${terminalText(options.configPath)}\nSource: ${packageFile ? terminalText(packageFile) : `${metadata.name}@${metadata.version}`}\nNo sudo, shell profile changes, or npm settings changes are used. npm installs the official Bun dependency. Bot creation, console setup, native agent installation, and native agent sign-in remain manual guided steps.`);
    if (candidate && !already) ui.write("The existing copy failed its version check. Confirm installation below to repair it before configuration.");
    if (!already && !(await ui.confirm("Install this version here, then open configuration?", true))) {
      ui.write("Installation cancelled. No persistent installation or configuration was changed."); return 130;
    }
    if (already) ui.write("This version is already installed here; checking it before opening configuration.");
    else {
      ui.write("Installing the persistent copy with npm...");
      const result = await run({ command: npm!.command, args: [...npm!.args, "install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", packageFile ?? `${metadata.name}@${metadata.version}`] }, npmEnv);
      if (result.code !== 0) {
        ui.write("npm installation did not complete. Configuration was not opened or changed. npm may have left partial files in the displayed prefix; fix the npm error and rerun the same command. Do not use sudo.");
        return result.code;
      }
    }
    if (!matchingInstall(prefix, runningRuntime)) throw new Error("The expected installed package, executable, or bundled Bun is missing. Configuration was not opened; repair the displayed prefix and retry.");
    const check = already ? priorCheck! : await run({ command: node, args: [paths.launcher, "--version"] }, childEnv, true);
    if ([130, 143].includes(check.code)) {
      ui.write("Installation check interrupted. The package files remain in the displayed prefix; configuration was not opened or changed."); return check.code;
    }
    if (check.code !== 0 || check.stdout.trim() !== metadata.version) throw new Error("The persistent executable failed its version check. Configuration was not opened; repair the installation and retry.");
    installed = true;
    ui.write(`Verified persistent installation: ${metadata.name}@${metadata.version}`);
    const binDirectory = dirname(paths.executable);
    const onPath = (env.PATH ?? env.Path ?? "").split(delimiter).some((entry) => resolve(entry) === binDirectory);
    if (!onPath) ui.write(`The installation directory is not on PATH. The absolute commands below work immediately. Optionally add ${terminalText(binDirectory)} to your user PATH manually. Your PATH has not been changed.`);
    const command = launchCommand(paths.executable);
    ui.write(`Opening the installed configuration wizard. If you cancel, the software stays installed and configuration is unchanged.\nRun again: ${command} install --config ${shellQuote(options.configPath)}${options.envFile ? ` --env-file ${shellQuote(options.envFile)}` : ""}`);
    // Release raw-input listeners before starting the installed copy. Never recurse into install.
    ui.close?.();
    const runtime = runningRuntime ?? join(paths.root, "node_modules", "bun", "bin", "bun.exe");
    const setup = join(paths.root, "src", "cli", "setup.ts");
    const args = ["--no-env-file", "--no-install", setup, "--config", options.configPath, ...(options.envFile ? ["--env-file", options.envFile] : [])];
    const result = await run({ command: runtime, args }, { ...childEnv, AGENT_RELAY_INSTALLED_EXECUTABLE: paths.executable });
    ui.write(result.code === 0 ? "Installation and configuration completed." : "The software remains installed; configuration did not complete. Rerun the install command above when ready.");
    ui.write(`Check: ${command} doctor --config ${shellQuote(options.configPath)}\nStart: ${command} start --config ${shellQuote(options.configPath)}`);
    return result.code;
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      ui.write(installed ? "Setup cancelled. The software remains installed; configuration was not changed." : "Installation cancelled. Configuration was not changed.");
      return 130;
    }
    throw error;
  } finally { ui.close?.(); }
}
