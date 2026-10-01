import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import metadata from "../../package.json";
import {
  currentInstallPrefix, defaultInstallPrefix, installAndConfigure, installedPaths, launchCommand, npmCommand, shellQuote, validatePackageFile,
  type InstallOptions, type InstallRunner, type ProcessCommand, type ProcessResult,
} from "../../src/cli/install.ts";
import { WizardCancelledError, type Choice, type WizardUI } from "../../src/cli/prompts.ts";
import type { Env } from "../../src/runtime/config-types.ts";

class InstallUI implements WizardUI {
  readonly messages: string[] = [];
  readonly confirmations: { message: string; defaultValue?: boolean }[] = [];
  closeCount = 0;
  constructor(readonly answer: boolean | Error = true) {}
  write(message: string): void { this.messages.push(message); }
  async confirm(message: string, defaultValue?: boolean): Promise<boolean> {
    this.confirmations.push({ message, defaultValue });
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
  async text(): Promise<string> { throw new Error("The installer must delegate credential prompts to installed setup."); }
  async choose<T extends string>(_message: string, _choices: readonly Choice<T>[]): Promise<T> {
    throw new Error("The installer must delegate choices to installed setup.");
  }
  close(): void { this.closeCount++; }
  get output(): string { return this.messages.join("\n"); }
}

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "relay-install-"));
  tempDirectories.push(directory);
  const prefix = join(directory, "persistent copy's npm");
  const configPath = join(directory, "private settings", "relay's config.json");
  const envFile = join(directory, "import settings", "relay's .env");
  const npmCli = join(directory, "node with spaces", "npm-cli.js");
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "// fixture only; never executed\n");
  const node = join(directory, "node with spaces", "node");
  const env: Env = { AGENT_RELAY_NODE_PATH: node, npm_execpath: npmCli, PATH: "" };
  return { directory, prefix, configPath, envFile, npmCli, node, env };
}

function createInstalledFixture(prefix: string, version = metadata.version, name = metadata.name): void {
  const paths = installedPaths(prefix);
  const files = [paths.launcher, paths.executable, join(paths.root, "src", "cli", "setup.ts"), join(paths.root, "node_modules", "bun", "bin", "bun.exe")];
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture, not an executable\n");
  }
  writeFileSync(join(paths.root, "package.json"), JSON.stringify({ name, version }));
}

interface RecordedCall { command: ProcessCommand; env: Env; capture: boolean; }
function runner(prefix: string, options: { npmCode?: number; setupCode?: number; versionCode?: number; versionOutput?: string; omitInstall?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const run: InstallRunner = async (command, env, capture = false): Promise<ProcessResult> => {
    calls.push({ command, env, capture });
    if (command.args.includes("--global")) {
      const code = options.npmCode ?? 0;
      if (!code && !options.omitInstall) createInstalledFixture(prefix);
      return { code, stdout: "private npm output must not be printed" };
    }
    if (command.args[1] === "--version") return { code: options.versionCode ?? 0, stdout: options.versionOutput ?? `${metadata.version}\n` };
    if (command.args[2] === join(installedPaths(prefix).root, "src", "cli", "setup.ts")) return { code: options.setupCode ?? 0, stdout: "private setup output must not be printed" };
    throw new Error("Unexpected installer subprocess");
  };
  return { calls, run };
}

function installOptions(files: ReturnType<typeof fixture>, ui: InstallUI, run: InstallRunner): InstallOptions {
  return { prefix: files.prefix, configPath: files.configPath, env: files.env, isTTY: true, ui, run };
}

function writePrivateFiles(files: ReturnType<typeof fixture>) {
  const contents = new Map([
    [files.configPath, '{"version":1,"env":{"TELEGRAM_BOT_TOKEN":"fixture-private-token"}}\n'],
    [files.envFile, "LARK_APP_SECRET=fixture-private-secret\n"],
    [join(files.directory, ".npmrc"), "prefix=/existing/npm/prefix\n"],
    [join(files.directory, ".profile"), "export PATH=/existing/bin:$PATH\n"],
  ]);
  for (const [file, content] of contents) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
  }
  const modes = new Map([...contents.keys()].map((file) => [file, statSync(file).mode]));
  return () => {
    for (const [file, content] of contents) {
      expect(readFileSync(file, "utf8")).toBe(content);
      expect(statSync(file).mode).toBe(modes.get(file)!);
    }
  };
}

/** Minimal valid ustar fixture; no external tar/npm invocation or extraction. */
function tarball(files: { name: string; content: string; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write(file.type ?? "0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function writePackage(directory: string, manifest: unknown = { name: metadata.name, version: metadata.version }): string {
  const file = join(directory, "local package's release.tgz");
  writeFileSync(file, tarball([{ name: "package/package.json", content: JSON.stringify(manifest) }]));
  return file;
}

describe("persistent install and configure", () => {
  test("confirms, installs the exact scoped version, verifies it, and starts installed setup in order", async () => {
    const files = fixture();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    const untouched = writePrivateFiles(files);
    const run: InstallRunner = async (command, env, capture) => {
      if (command.args.includes("--global")) expect(ui.confirmations).toHaveLength(1);
      if (command.args[2] === join(installedPaths(files.prefix).root, "src", "cli", "setup.ts")) expect(ui.closeCount).toBeGreaterThan(0);
      return processRunner.run(command, env, capture);
    };
    expect(await installAndConfigure({ ...installOptions(files, ui, run), envFile: files.envFile })).toBe(0);
    expect(processRunner.calls.map((call) => call.command)).toEqual([
      { command: files.node, args: [files.npmCli, "install", "--global", "--prefix", files.prefix, "--no-audit", "--no-fund", `${metadata.name}@${metadata.version}`] },
      { command: files.node, args: [installedPaths(files.prefix).launcher, "--version"] },
      { command: join(installedPaths(files.prefix).root, "node_modules", "bun", "bin", "bun.exe"), args: ["--no-env-file", "--no-install", join(installedPaths(files.prefix).root, "src", "cli", "setup.ts"), "--config", files.configPath, "--env-file", files.envFile] },
    ]);
    expect(processRunner.calls.map((call) => call.capture)).toEqual([false, true, false]);
    expect(ui.confirmations[0]?.defaultValue).toBe(true);
    expect(ui.output).toContain(`Verified persistent installation: ${metadata.name}@${metadata.version}`);
    expect(ui.output).toContain("Installation and configuration completed.");
    expect(ui.output).toContain("Your PATH has not been changed.");
    expect(ui.output).toContain(`Start: ${launchCommand(installedPaths(files.prefix).executable)} start --config ${shellQuote(files.configPath)}`);
    expect(ui.output).not.toContain("private npm output");
    expect(ui.output).not.toContain("private setup output");
    expect(ui.closeCount).toBeGreaterThan(0);
    untouched();
  });

  test("reuses a complete matching installation without running or locating npm", async () => {
    const files = fixture();
    createInstalledFixture(files.prefix);
    const ui = new InstallUI(false);
    const processRunner = runner(files.prefix);
    const env = { AGENT_RELAY_NODE_PATH: files.node, PATH: dirname(installedPaths(files.prefix).executable) };
    expect(await installAndConfigure({ ...installOptions(files, ui, processRunner.run), env })).toBe(0);
    expect(processRunner.calls.map((call) => call.command.args[1])).toEqual(["--version", "--no-install"]);
    expect(ui.confirmations).toHaveLength(0);
    expect(ui.output).toContain("already installed");
    expect(ui.output).not.toContain("not on PATH");
  });

  test("upgrades an older installation before opening configuration", async () => {
    const files = fixture();
    createInstalledFixture(files.prefix, "0.0.1");
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(0);
    expect(processRunner.calls).toHaveLength(3);
    expect(processRunner.calls[0]?.command.args.at(-1)).toBe(`${metadata.name}@${metadata.version}`);
    expect(JSON.parse(readFileSync(join(installedPaths(files.prefix).root, "package.json"), "utf8")).version).toBe(metadata.version);
    expect(ui.confirmations).toHaveLength(1);
  });

  test("repairs an incomplete matching-version installation instead of skipping npm", async () => {
    const files = fixture();
    createInstalledFixture(files.prefix);
    rmSync(join(installedPaths(files.prefix).root, "node_modules", "bun", "bin", "bun.exe"));
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(0);
    expect(processRunner.calls[0]?.command.args).toContain("--global");
    expect(ui.confirmations).toHaveLength(1);
  });

  test("an earlier same-version copy without the internal wizard is reinstalled before setup", async () => {
    const files = fixture();
    createInstalledFixture(files.prefix);
    rmSync(join(installedPaths(files.prefix).root, "src", "cli", "setup.ts"));
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(0);
    expect(processRunner.calls[0]?.command.args).toContain("--global");
    expect(ui.confirmations).toHaveLength(1);
    expect(processRunner.calls.at(-1)?.command.args).toContain(join(installedPaths(files.prefix).root, "src", "cli", "setup.ts"));
    expect(processRunner.calls.every(({ command }) => !command.args.includes("init"))).toBe(true);
  });

  for (const brokenCheck of [{ code: 1, stdout: "" }, { code: 0, stdout: "0.0.1\n" }]) {
    test(`repairs matching installed files whose executable fails verification: ${JSON.stringify(brokenCheck)}`, async () => {
      const files = fixture();
      const untouched = writePrivateFiles(files);
      createInstalledFixture(files.prefix);
      const ui = new InstallUI();
      const processRunner = runner(files.prefix);
      let firstProbe = true;
      const run: InstallRunner = async (command, env, capture) => {
        const result = await processRunner.run(command, env, capture);
        if (command.args[1] === "--version" && firstProbe) { firstProbe = false; return brokenCheck; }
        if (command.args.includes("--global")) expect(ui.confirmations).toHaveLength(1);
        return result;
      };
      expect(await installAndConfigure(installOptions(files, ui, run))).toBe(0);
      expect(processRunner.calls.map((call) => call.command.args[1])).toEqual(["--version", "install", "--version", "--no-install"]);
      expect(processRunner.calls.map((call) => call.capture)).toEqual([true, false, true, false]);
      expect(ui.output).toContain("existing copy failed its version check");
      expect(ui.output).toContain("repair it before configuration");
      expect(ui.output).toContain("Installation and configuration completed");
      expect(ui.confirmations).toHaveLength(1);
      untouched();
    });
  }

  test("declining repair after a failed existing-runtime probe preserves the old installation", async () => {
    const files = fixture();
    const untouched = writePrivateFiles(files);
    createInstalledFixture(files.prefix);
    const paths = installedPaths(files.prefix);
    const originalLauncher = readFileSync(paths.launcher, "utf8");
    const ui = new InstallUI(false);
    const processRunner = runner(files.prefix, { versionCode: 1 });
    expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(130);
    expect(processRunner.calls.map((call) => call.command.args[1])).toEqual(["--version"]);
    expect(readFileSync(paths.launcher, "utf8")).toBe(originalLauncher);
    expect(ui.output).toContain("No persistent installation or configuration was changed");
    expect(ui.output).not.toContain("Verified persistent installation");
    untouched();
  });

  test("failed npm repair never opens setup or treats stale matching metadata as success", async () => {
    const files = fixture();
    createInstalledFixture(files.prefix);
    const ui = new InstallUI();
    const processRunner = runner(files.prefix, { versionCode: 1, npmCode: 2 });
    expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(2);
    expect(processRunner.calls.map((call) => call.command.args[1])).toEqual(["--version", "install"]);
    expect(ui.output).not.toContain("Verified persistent installation");
    expect(ui.output).not.toContain("Installation and configuration completed");
  });

  for (const stage of ["existing", "newly installed"] as const) {
    for (const signalCode of [130, 143]) {
      test(`${stage} version probe exit ${signalCode} stops without repair or setup and preserves files`, async () => {
        const files = fixture();
        const untouched = writePrivateFiles(files);
        if (stage === "existing") createInstalledFixture(files.prefix);
        const ui = new InstallUI();
        const processRunner = runner(files.prefix, { versionCode: signalCode });
        expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(signalCode);
        expect(processRunner.calls.map((call) => call.command.args[1])).toEqual(stage === "existing" ? ["--version"] : ["install", "--version"]);
        expect(ui.confirmations).toHaveLength(stage === "existing" ? 0 : 1);
        expect(existsSync(installedPaths(files.prefix).launcher)).toBe(true);
        expect(ui.output).not.toContain("repair it before configuration");
        expect(ui.output).not.toContain("Verified persistent installation");
        expect(ui.output).not.toContain("Opening the installed configuration wizard");
        expect(ui.output).not.toContain("Installation and configuration completed");
        expect(ui.closeCount).toBeGreaterThan(0);
        untouched();
      });
    }
  }

  for (const npmCode of [1, 130, 143]) {
    test(`npm exit ${npmCode} never opens configuration or prints success`, async () => {
      const files = fixture();
      const untouched = writePrivateFiles(files);
      const ui = new InstallUI();
      const processRunner = runner(files.prefix, { npmCode });
      expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(npmCode);
      expect(processRunner.calls).toHaveLength(1);
      expect(ui.output).toContain("Configuration was not opened or changed");
      expect(ui.output).not.toContain("Verified persistent installation");
      expect(ui.output).not.toContain("Installation and configuration completed");
      expect(ui.output).not.toContain("Start:");
      expect(existsSync(files.prefix)).toBe(false);
      expect(ui.closeCount).toBeGreaterThan(0);
      untouched();
    });
  }

  for (const answer of [false, new WizardCancelledError()]) {
    test(`cancelling ${answer === false ? "confirmation" : "with Ctrl-C"} happens before npm and preserves private files`, async () => {
      const files = fixture();
      const untouched = writePrivateFiles(files);
      const ui = new InstallUI(answer);
      const processRunner = runner(files.prefix);
      expect(await installAndConfigure(installOptions(files, ui, processRunner.run))).toBe(130);
      expect(processRunner.calls).toHaveLength(0);
      expect(existsSync(files.prefix)).toBe(false);
      expect(ui.output).toContain("Installation cancelled");
      expect(ui.output).not.toContain("completed");
      expect(ui.closeCount).toBeGreaterThan(0);
      untouched();
    });
  }

  for (const setupCode of [1, 130, 143]) {
    test(`setup exit ${setupCode} leaves software installed and does not claim configuration succeeded`, async () => {
      const files = fixture();
      const untouched = writePrivateFiles(files);
      const ui = new InstallUI();
      const processRunner = runner(files.prefix, { setupCode });
      expect(await installAndConfigure({ ...installOptions(files, ui, processRunner.run), envFile: files.envFile })).toBe(setupCode);
      expect(processRunner.calls).toHaveLength(3);
      expect(existsSync(installedPaths(files.prefix).launcher)).toBe(true);
      expect(existsSync(installedPaths(files.prefix).executable)).toBe(true);
      expect(ui.output).toContain("The software remains installed; configuration did not complete");
      expect(ui.output).toContain(`Run again: ${launchCommand(installedPaths(files.prefix).executable)} install --config ${shellQuote(files.configPath)} --env-file ${shellQuote(files.envFile)}`);
      expect(ui.output).not.toMatch(/\binit\b/);
      expect(ui.output).not.toContain("Installation and configuration completed");
      untouched();
    });
  }

  test("a cancelled installed setup is distinguished from cancelling installation", async () => {
    const files = fixture();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    const run: InstallRunner = async (command, env, capture) => {
      if (command.args[2] === join(installedPaths(files.prefix).root, "src", "cli", "setup.ts")) throw new WizardCancelledError();
      return processRunner.run(command, env, capture);
    };
    expect(await installAndConfigure(installOptions(files, ui, run))).toBe(130);
    expect(existsSync(installedPaths(files.prefix).launcher)).toBe(true);
    expect(ui.output).toContain("Setup cancelled. The software remains installed");
    expect(ui.output).not.toContain("Installation and configuration completed");
  });

  test("non-TTY invocation rejects before prompts, subprocesses, or filesystem mutation", async () => {
    const files = fixture();
    const untouched = writePrivateFiles(files);
    const entries = readdirSync(files.directory).sort();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    await expect(installAndConfigure({ ...installOptions(files, ui, processRunner.run), isTTY: false })).rejects.toThrow("interactive terminal (TTY)");
    expect(processRunner.calls).toHaveLength(0);
    expect(ui.messages).toHaveLength(0);
    expect(ui.confirmations).toHaveLength(0);
    expect(existsSync(files.prefix)).toBe(false);
    expect(readdirSync(files.directory).sort()).toEqual(entries);
    untouched();
  });

  test("npm receives no provider secrets or relay settings, while installed setup retains explicit environment", async () => {
    const files = fixture();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    const relayEnv = {
      TELEGRAM_BOT_TOKEN: "fixture-telegram-secret", TELEGRAM_BOT_USERNAME: "private-bot",
      LARK_APP_ID: "fixture-app-id", LARK_APP_SECRET: "fixture-lark-secret", LARK_DOMAIN: "feishu",
      IM_PROVIDER: "lark", ALLOWED_USER_IDS: "private-user", ALLOWED_CONVERSATION_IDS: "private-chat",
      WORKSPACE_ROOT: "/private/workspace", SQLITE_PATH: "/private/state", CODEX_BIN: "/private/codex",
      AGENT_PROVIDER: "claude", CLAUDE_BIN: "/private/claude", DSH_BIN: "/private/dsh",
      CODEX_DEVELOPER_INSTRUCTIONS: "private-instructions", RELAY_CONTROL_ENABLED: "false", LOG_LEVEL: "debug",
    };
    const env = Object.freeze({ ...files.env, ...relayEnv, AGENT_RELAY_BUN_PATH: "/untrusted/transient/bun", KEEP_ME: "unrelated-value" });
    const original = { ...env };
    expect(await installAndConfigure({ ...installOptions(files, ui, processRunner.run), env })).toBe(0);
    const [npm, version, setup] = processRunner.calls;
    for (const [key, value] of Object.entries(relayEnv)) {
      expect(npm?.env[key]).toBeUndefined();
      expect(setup?.env[key]).toBe(value);
      expect(ui.output).not.toContain(value);
      expect(npm?.command.args).not.toContain(value);
      expect(setup?.command.args).not.toContain(value);
    }
    for (const call of [npm, version, setup]) {
      expect(call?.env.AGENT_RELAY_BUN_PATH).toBeUndefined();
      expect(call?.env.KEEP_ME).toBe("unrelated-value");
    }
    expect(setup?.env.AGENT_RELAY_INSTALLED_EXECUTABLE).toBe(installedPaths(files.prefix).executable);
    expect(env).toEqual(original);
  });

  test("npm success without a complete persistent package never opens setup", async () => {
    const files = fixture();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix, { omitInstall: true });
    await expect(installAndConfigure(installOptions(files, ui, processRunner.run))).rejects.toThrow("expected installed package");
    expect(processRunner.calls).toHaveLength(1);
    expect(ui.output).not.toContain("Verified persistent installation");
    expect(ui.output).not.toContain("completed");
    expect(ui.closeCount).toBeGreaterThan(0);
  });

  for (const version of [{ versionCode: 1 }, { versionOutput: "0.0.1\n" }, { versionOutput: `${metadata.version}\nprivate-data` }]) {
    test(`failed or incorrect version verification never opens setup: ${JSON.stringify(version)}`, async () => {
      const files = fixture();
      const ui = new InstallUI();
      const processRunner = runner(files.prefix, version);
      await expect(installAndConfigure(installOptions(files, ui, processRunner.run))).rejects.toThrow("failed its version check");
      expect(processRunner.calls).toHaveLength(2);
      expect(processRunner.calls[1]?.capture).toBe(true);
      expect(ui.output).not.toContain("Verified persistent installation");
      expect(ui.output).not.toContain("private-data");
      expect(ui.closeCount).toBeGreaterThan(0);
    });
  }

  test("prefix control characters and existing files are rejected before any prompt or subprocess", async () => {
    const files = fixture();
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    for (const prefix of [join(files.directory, "bad\nprefix"), files.npmCli]) {
      await expect(installAndConfigure({ ...installOptions(files, ui, processRunner.run), prefix })).rejects.toThrow("prefix");
    }
    expect(processRunner.calls).toHaveLength(0);
    expect(ui.messages).toHaveLength(0);
  });
});

describe("local installer tarball", () => {
  test("a matching .tgz is validated before installation and passed to npm as one absolute argument", async () => {
    const files = fixture();
    const packageFile = writePackage(files.directory);
    createInstalledFixture(files.prefix);
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    expect(() => validatePackageFile(packageFile)).not.toThrow();
    expect(await installAndConfigure({ ...installOptions(files, ui, processRunner.run), packageFile })).toBe(0);
    expect(processRunner.calls).toHaveLength(3);
    expect(processRunner.calls[0]?.command.args.at(-1)).toBe(resolve(packageFile));
    expect(processRunner.calls[0]?.command.args).not.toContain(`${metadata.name}@${metadata.version}`);
    const setupArgs = processRunner.calls[2]!.command.args;
    expect(setupArgs).toEqual(["--no-env-file", "--no-install", join(installedPaths(files.prefix).root, "src", "cli", "setup.ts"), "--config", files.configPath]);
    for (const recursiveArgument of ["init", "install", "--prefix", "--package", packageFile]) expect(setupArgs).not.toContain(recursiveArgument);
    expect(ui.confirmations).toHaveLength(1);
  });

  for (const manifest of [
    { name: metadata.name, version: "0.0.1" },
    { name: "agent-relay", version: metadata.version },
    { name: "@different/agent-relay", version: metadata.version },
    { name: metadata.name },
  ]) {
    test(`wrong package identity is rejected before mutation: ${JSON.stringify(manifest)}`, async () => {
      const files = fixture();
      const packageFile = writePackage(files.directory, manifest);
      const untouched = writePrivateFiles(files);
      const ui = new InstallUI();
      const processRunner = runner(files.prefix);
      await expect(installAndConfigure({ ...installOptions(files, ui, processRunner.run), packageFile })).rejects.toThrow(`must contain ${metadata.name}@${metadata.version}`);
      expect(processRunner.calls).toHaveLength(0);
      expect(ui.messages).toHaveLength(0);
      expect(existsSync(files.prefix)).toBe(false);
      untouched();
    });
  }

  test("missing, non-tgz, directory, corrupt, and oversized input reject without writes", async () => {
    const files = fixture();
    const text = join(files.directory, "package.txt");
    const corrupt = join(files.directory, "corrupt.tgz");
    const oversized = join(files.directory, "oversized.tgz");
    const directory = join(files.directory, "directory.tgz");
    writeFileSync(text, "not a tarball");
    writeFileSync(corrupt, "not a tarball");
    writeFileSync(oversized, "");
    truncateSync(oversized, 32 * 1024 * 1024 + 1);
    mkdirSync(directory);
    const ui = new InstallUI();
    const processRunner = runner(files.prefix);
    for (const packageFile of [join(files.directory, "missing.tgz"), text, corrupt, oversized, directory]) {
      await expect(installAndConfigure({ ...installOptions(files, ui, processRunner.run), packageFile })).rejects.toThrow();
    }
    expect(processRunner.calls).toHaveLength(0);
    expect(ui.messages).toHaveLength(0);
    expect(existsSync(files.prefix)).toBe(false);
  });

  test("duplicate or malformed manifests are rejected rather than selecting an ambiguous package", () => {
    const files = fixture();
    const packageFile = join(files.directory, "ambiguous.tgz");
    const entry = { name: "package/package.json", content: JSON.stringify({ name: metadata.name, version: metadata.version }) };
    for (const entries of [[entry, entry], [{ ...entry, content: "not json" }]]) {
      writeFileSync(packageFile, tarball(entries));
      expect(() => validatePackageFile(packageFile)).toThrow("Could not read");
    }
  });

  test("a manifest symlink or missing package manifest cannot authorize installing a tarball", () => {
    const files = fixture();
    const packageFile = join(files.directory, "missing-manifest.tgz");
    for (const entries of [
      [{ name: "package/package.json", content: JSON.stringify(metadata), type: "2" }],
      [{ name: "elsewhere/package.json", content: JSON.stringify(metadata) }],
    ]) {
      writeFileSync(packageFile, tarball(entries));
      expect(() => validatePackageFile(packageFile)).toThrow("must contain");
    }
  });
});

describe("installer paths and subprocess construction", () => {
  test("current installation prefix discovery excludes source and temporary npx layouts", () => {
    const files = fixture();
    expect(currentInstallPrefix()).toBeUndefined();
    expect(currentInstallPrefix(installedPaths(files.prefix).root)).toBeUndefined();
    createInstalledFixture(files.prefix);
    expect(currentInstallPrefix(installedPaths(files.prefix).root)).toBe(files.prefix);
    const npxRoot = join(files.directory, "npm cache", "_npx", "random", "node_modules", metadata.name);
    mkdirSync(npxRoot, { recursive: true });
    expect(currentInstallPrefix(npxRoot)).toBeUndefined();
  });

  test("the default POSIX prefix uses absolute XDG_DATA_HOME or the user's local share directory", () => {
    expect(defaultInstallPrefix({ XDG_DATA_HOME: "/custom data" }, "/home/alice", "linux")).toBe("/custom data/agent-relay/npm");
    expect(defaultInstallPrefix({}, "/home/alice", "darwin")).toBe("/home/alice/.local/share/agent-relay/npm");
    expect(defaultInstallPrefix({ XDG_DATA_HOME: "relative/data" }, "/home/alice", "linux")).toBe("/home/alice/.local/share/agent-relay/npm");
    expect(defaultInstallPrefix({ XDG_DATA_HOME: "" }, "/home/alice", "linux")).toBe("/home/alice/.local/share/agent-relay/npm");
  });

  test("the Windows prefix uses LOCALAPPDATA and Windows separators even on a POSIX test host", () => {
    expect(defaultInstallPrefix({ LOCALAPPDATA: "D:\\Local Data" }, "C:\\Users\\Alice", "win32")).toBe("D:\\Local Data\\agent-relay\\npm");
    expect(defaultInstallPrefix({}, "C:\\Users\\Alice", "win32")).toBe("C:\\Users\\Alice\\AppData\\Local\\agent-relay\\npm");
    expect(defaultInstallPrefix({ LOCALAPPDATA: "relative\\data" }, "C:\\Users\\Alice", "win32")).toBe("C:\\Users\\Alice\\AppData\\Local\\agent-relay\\npm");
  });

  test("the scoped package layout and executable paths are correct on both platforms", () => {
    expect(installedPaths("/home/alice/npm", "linux")).toEqual({
      root: `/home/alice/npm/lib/node_modules/${metadata.name}`,
      launcher: `/home/alice/npm/lib/node_modules/${metadata.name}/bin/agent-relay.mjs`,
      executable: "/home/alice/npm/bin/agent-relay",
    });
    const root = win32.join("C:\\Users\\Alice\\Relay npm", "node_modules", metadata.name);
    expect(installedPaths("C:\\Users\\Alice\\Relay npm", "win32")).toEqual({
      root, launcher: win32.join(root, "bin", "agent-relay.mjs"), executable: "C:\\Users\\Alice\\Relay npm\\agent-relay.cmd",
    });
  });

  test("POSIX display commands quote spaces, single quotes, and shell metacharacters", () => {
    const path = "/home/alice's relay/$(touch never); & executable";
    expect(shellQuote(path, "linux")).toBe("'/home/alice'\"'\"'s relay/$(touch never); & executable'");
    expect(launchCommand(path, "linux")).toBe(shellQuote(path, "linux"));
    expect(shellQuote("bad\npath\u001b", "linux")).toBe("'badpath'");
  });

  test("PowerShell display commands quote apostrophes and use the call operator", () => {
    const path = "C:\\Alice's relay\\$(Write-Output never)& agent-relay.cmd";
    expect(shellQuote(path, "win32")).toBe("'C:\\Alice''s relay\\$(Write-Output never)& agent-relay.cmd'");
    expect(launchCommand(path, "win32")).toBe(`& ${shellQuote(path, "win32")}`);
    expect(shellQuote("bad\r\npath", "win32")).toBe("'badpath'");
  });

  test("an inherited npm-cli.js runs through node with a separate path argument on both platforms", () => {
    const files = fixture();
    for (const platform of ["linux", "win32"]) {
      expect(npmCommand(files.env, files.node, platform, () => { throw new Error("PATH lookup must not run"); })).toEqual({ command: files.node, args: [files.npmCli] });
    }
  });

  test("POSIX npm scripts run through node without invoking a command shell", () => {
    const files = fixture();
    expect(npmCommand({}, files.node, "linux", (name) => {
      expect(name).toBe("npm");
      return files.npmCli;
    })).toEqual({ command: files.node, args: [files.npmCli] });
  });

  test("missing npm gives an actionable error without a subprocess", () => {
    expect(() => npmCommand({}, "/fixture/node", "linux", () => null)).toThrow("npm was not found");
    expect(() => npmCommand({}, "C:\\node.exe", "win32", () => null)).toThrow("npm was not found");
  });
});
