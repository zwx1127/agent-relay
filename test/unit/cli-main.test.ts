import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import metadata from "../../package.json";
import { parseArgs, redactCliError } from "../../src/cli/main.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function isolatedCli() {
  const root = mkdtempSync(join(tmpdir(), "relay-cli-test-")); roots.push(root);
  const home = join(root, "home"); mkdirSync(home);
  const config = join(home, "private", "config.json");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), AGENT_RELAY_CONFIG: "" };
  for (const key of Object.keys(env)) if (/^(TELEGRAM_|LARK_|CODEX_|CLAUDE_|DSH_|IM_PROVIDER$|AGENT_PROVIDER$|ALLOWED_|WORKSPACE_ROOT$|SQLITE_PATH$|RELAY_|EXPERIMENTAL_RELAY_)/.test(key)) delete env[key];
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)), ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: result.stdout + result.stderr };
  };
  return { root, home, config, run };
}

describe("CLI arguments", () => {
  test("defaults to foreground start and accepts explicit paths anywhere", () => {
    expect(parseArgs([], { AGENT_RELAY_CONFIG: "/private/config.json" })).toEqual({ command: "start", configPath: "/private/config.json", subcommand: undefined, envFile: undefined });
    expect(parseArgs(["--config", "/one/config.json", "install", "--env-file", "/project/.env"]).envFile).toBe("/project/.env");
    expect(parseArgs(["gateway", "status"]).subcommand).toBe("status");
    expect(parseArgs(["config", "path"]).command).toBe("config");
  });
  test("rejects typo/secret arguments without printing them", () => {
    expect(() => parseArgs(["--config"])).toThrow("requires a path");
    expect(() => parseArgs(["--token=my-secret"])).toThrow("Unknown option");
    expect(() => parseArgs(["install", "my-secret"])).toThrow("Too many");
    expect(() => parseArgs(["config", "show"])).toThrow("config path");
    expect(() => parseArgs(["gateway", "unknown"])).toThrow("usage");
  });
  test("install accepts explicit prefix and local package paths without splitting spaces", () => {
    expect(parseArgs(["--prefix", "persistent npm", "install", "--package", "packed release.tgz", "--config", "private config.json", "--env-file", "import settings.env"])).toEqual({
      command: "install", subcommand: undefined,
      prefix: resolve("persistent npm"), packageFile: resolve("packed release.tgz"),
      configPath: resolve("private config.json"), envFile: resolve("import settings.env"),
    });
    expect(parseArgs(["install"]).command).toBe("install");
  });
  test("init is an unknown command, including with configuration and install options", () => {
    for (const args of [["init"], ["init", "my-secret"], ["init", "--config", "/private/config.json"], ["init", "--env-file", "/private/settings.env"], ["init", "--prefix", "/private/prefix"]]) {
      expect(() => parseArgs(args)).toThrow("Unknown command");
    }
  });
  test("setup and configure do not expose replacement public aliases", () => {
    for (const command of ["setup", "configure"]) expect(() => parseArgs([command])).toThrow("Unknown command");
  });
  test("install-only options reject missing paths and use with other commands", () => {
    for (const option of ["--prefix", "--package"]) {
      expect(() => parseArgs(["install", option])).toThrow(`${option} requires a path`);
      expect(() => parseArgs(["install", option, "--config", "/private/config.json"])).toThrow(`${option} requires a path`);
      for (const args of [["start"], ["doctor"], ["gateway", "status"], ["config", "path"], []]) {
        expect(() => parseArgs([...args, option, "local-path"])).toThrow("only valid with install");
      }
    }
    expect(() => parseArgs(["install", "init"])).toThrow("Too many arguments");
  });
  test("redacts known credentials and token-shaped strings from errors", () => {
    expect(redactCliError(new Error("url/123456:abcdefghijklmnopqrst?secret=supersecret app=cli_private"), { LARK_APP_SECRET: "supersecret", LARK_APP_ID: "cli_private" })).toBe("url/[redacted]?secret=[redacted] app=[redacted]");
  });
});

describe("public CLI setup entry point", () => {
  test("help exposes install, and the package has no init script", () => {
    const { home, run } = isolatedCli();
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^\s+install\s+/m);
    expect(result.output).not.toMatch(/\binit\b/);
    expect(result.output).not.toContain("first run offers setup");
    expect("init" in metadata.scripts).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });
  test("non-TTY init rejects before reading or changing configuration", () => {
    const { home, config, run } = isolatedCli();
    const missing = run(["init", "--config", config]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("Unknown command");
    expect(missing.output).not.toContain("TTY");
    expect(readdirSync(home)).toEqual([]);
    mkdirSync(join(home, "private"), { mode: 0o700 });
    // Invalid private contents prove command rejection happens before any config read.
    const saved = "not-json: fake-private-cli-secret";
    writeFileSync(config, saved, { mode: 0o600 });
    const existing = run(["init", "--config", config]);
    expect(existing.code).toBe(1);
    expect(existing.output).toContain("Unknown command");
    expect(existing.output).not.toContain(saved);
    expect(readFileSync(config, "utf8")).toBe(saved);
    expect(readdirSync(join(home, "private"))).toEqual(["config.json"]);
    expect(readdirSync(home)).toEqual(["private"]);
  });
  test("start and the default command direct missing configuration to install without setup or writes", () => {
    const { home, config, run } = isolatedCli();
    for (const args of [["start"], []]) {
      const result = run([...args, "--config", config]);
      expect(result.code).toBe(1);
      expect(result.output).toContain("agent-relay install");
      expect(result.output).not.toContain("Select a number");
      expect(result.output).not.toContain("requires an interactive terminal");
      expect(result.output).not.toMatch(/\binit\b/);
      expect(existsSync(config)).toBe(false);
      expect(readdirSync(home)).toEqual([]);
    }
  });
});

describe("selected backend doctor and Gateway boundary", () => {
  test("doctor detects only the selected backend without reading stale Codex instruction files", () => {
    for (const provider of ["claude", "dsh"] as const) {
      const { root, home, config, run } = isolatedCli();
      const binary = join(root, process.platform === "win32" ? "native agent.cmd" : "native agent");
      const log = join(root, "native-version-args.json");
      const script = join(root, "version-fixture.cjs");
      const version = provider === "dsh" ? "0.2.0-rc.2" : "2.1.280";
      writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(`${provider} ${version}`)});`);
      writeFileSync(binary, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
      chmodSync(binary, 0o700);
      mkdirSync(join(home, "private"), { mode: 0o700 });
      writeFileSync(config, JSON.stringify({ version: 1, env: {
        AGENT_PROVIDER: provider, [provider === "claude" ? "CLAUDE_BIN" : "DSH_BIN"]: binary,
        TELEGRAM_BOT_TOKEN: "fake-token", ALLOWED_USER_IDS: "10", WORKSPACE_ROOT: root,
        CODEX_BIN: join(root, "must-not-detect-codex"), CODEX_MODEL_INSTRUCTIONS_FILE: join(root, "missing-codex-instructions"),
      } }), { mode: 0o600 });
      const result = run(["doctor", "--config", config]);
      expect(result.code).toBe(0);
      expect(result.output).toContain(`agent backend: ${provider}`);
      expect(result.output).toContain(version);
      expect(result.output).toContain("executable detection only");
      expect(result.output).toContain("native agent authentication are not verified");
      expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(["--version"]);
    }
  });

  test("Gateway commands fail closed for non-Codex backends before launching management", () => {
    const { home, config, run } = isolatedCli();
    mkdirSync(join(home, "private"), { mode: 0o700 });
    for (const provider of ["claude", "dsh"]) {
      writeFileSync(config, JSON.stringify({ version: 1, env: { AGENT_PROVIDER: provider } }), { mode: 0o600 });
      for (const subcommand of ["setup", "start", "status", "stop", "remove"]) {
        const result = run(["gateway", subcommand, "--config", config]);
        expect(result.code).toBe(1);
        expect(result.output).toContain("Gateway commands require AGENT_PROVIDER=codex");
      }
    }
    expect(readdirSync(home)).toEqual(["private"]);
    expect(readdirSync(join(home, "private"))).toEqual(["config.json"]);
  });
});
