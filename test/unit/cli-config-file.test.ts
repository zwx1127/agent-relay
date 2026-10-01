import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { defaultConfigPath, importEnvFile, mergeConfigEnv, readConfigFile, selectConfigEnv, writeConfigFile } from "../../src/cli/config-file.ts";
const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), "relay-config-test-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed CLI configuration", () => {
  test("selects explicit env, XDG and Windows paths without consulting cwd files", () => {
    expect(defaultConfigPath({}, "/home/alice", "linux")).toBe("/home/alice/.config/agent-relay/config.json");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/private/config" }, "/home/alice", "darwin")).toBe("/private/config/agent-relay/config.json");
    expect(defaultConfigPath({ APPDATA: "/roaming" }, "/home/alice", "win32")).toBe("/roaming/agent-relay/config.json");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "relative" }, "/home/alice", "linux")).toBe("/home/alice/.config/agent-relay/config.json");
    expect(defaultConfigPath({ APPDATA: "relative" }, "/home/alice", "win32")).toBe("/home/alice/AppData/Roaming/agent-relay/config.json");
    expect(defaultConfigPath({ AGENT_RELAY_CONFIG: "/private/custom.json" })).toBe("/private/custom.json");
  });
  test("atomically saves versioned credentials with private directory and file modes", () => {
    const path = join(temp(), "private", "config.json");
    writeConfigFile(path, { TELEGRAM_BOT_TOKEN: "test-secret", WORKSPACE_ROOT: "/work", SQLITE_PATH: "/state/db", PATH: "never-persist" });
    expect(readConfigFile(path)?.TELEGRAM_BOT_TOKEN).toBe("test-secret");
    expect(readFileSync(path, "utf8")).not.toContain("never-persist");
    if (process.platform !== "win32") { expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700); }
    writeConfigFile(path, { TELEGRAM_BOT_TOKEN: "replacement" });
    expect(readConfigFile(path)?.TELEGRAM_BOT_TOKEN).toBe("replacement");
    expect(readdirSync(join(path, ".."))).toEqual(["config.json"]);
  });
  test("rejects insecure config reads and directories without broad chmod changes", () => {
    if (process.platform === "win32") return;
    const root = temp(); const path = join(root, "config.json");
    writeFileSync(path, '{"version":1,"env":{}}', { mode: 0o644 });
    expect(() => readConfigFile(path)).toThrow("chmod 600");
    chmodSync(root, 0o755);
    expect(() => writeConfigFile(path, { TELEGRAM_BOT_TOKEN: "secret" })).toThrow("private configuration directory");
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });
  test("rejects symlink config and directory targets", () => {
    if (process.platform === "win32") return;
    const root = temp(); const path = join(root, "target.json"); writeConfigFile(path, {});
    const link = join(root, "link.json"); symlinkSync(path, link);
    expect(() => readConfigFile(link)).toThrow("symlink");
    expect(() => writeConfigFile(link, {})).toThrow("non-regular");
    const dangling = join(root, "dangling.json"); symlinkSync(join(root, "missing"), dangling);
    expect(() => readConfigFile(dangling)).toThrow("symlink");
    expect(() => writeConfigFile(dangling, {})).toThrow("non-regular");
    const linkedDir = join(root, "dir"); symlinkSync(root, linkedDir);
    expect(() => writeConfigFile(join(linkedDir, "another.json"), {})).toThrow("symlink");
  });
  test("rejects directories and FIFOs before a blocking open", () => {
    const root = temp();
    expect(() => readConfigFile(root)).toThrow("regular file");
    if (process.platform !== "win32") {
      const fifo = join(root, "config.fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      expect(() => readConfigFile(fifo)).toThrow("regular file");
    }
  });
  test("invalid config and migration errors never quote contents", () => {
    const path = join(temp(), "config.json"); writeFileSync(path, '"my-private-token', { mode: 0o600 });
    try { readConfigFile(path); throw new Error("expected failure"); } catch (error) { expect(String(error)).not.toContain("my-private-token"); }
    writeFileSync(path, '{"version":2,"env":{}}', { mode: 0o600 }); expect(() => readConfigFile(path)).toThrow("schema");
    const env = join(temp(), ".env"); writeFileSync(env, "private-token-without-assignment");
    try { importEnvFile(env); throw new Error("expected failure"); } catch (error) { expect(String(error)).not.toContain("private-token-without-assignment"); }
    expect(() => importEnvFile(join(temp(), "absent"))).toThrow("does not exist");
  });
  test("migrates relative paths against env file rather than changing launch cwd", () => {
    const root = temp(); const env = join(root, ".env");
    writeFileSync(env, 'WORKSPACE_ROOT=./projects\nSQLITE_PATH=.data/relay.sqlite\nCODEX_BIN=./tools/codex\nLARK_APP_SECRET="spaces \\\" quote"\nPATH=not-copied\n');
    const imported = importEnvFile(env);
    expect(imported.WORKSPACE_ROOT).toBe(join(root, "projects")); expect(imported.SQLITE_PATH).toBe(join(root, ".data/relay.sqlite"));
    expect(imported.CODEX_BIN).toBe(join(root, "tools/codex")); expect(imported.PATH).toBeUndefined();
    const merged = mergeConfigEnv(imported, { SQLITE_PATH: "override.sqlite" }, "/launch");
    expect(merged.WORKSPACE_ROOT).toBe(join(root, "projects")); expect(merged.SQLITE_PATH).toBe("/launch/override.sqlite");
  });
  test("missing config returns undefined and unknown env variables are discarded", () => {
    const root = temp(); mkdirSync(join(root, "empty"));
    expect(readConfigFile(join(root, "missing"))).toBeUndefined();
    expect(selectConfigEnv({ TELEGRAM_BOT_TOKEN: "kept", NODE_OPTIONS: "bad", AGENT_RELAY_CONFIG: "not-saved" })).toEqual({ TELEGRAM_BOT_TOKEN: "kept" });
    expect(existsSync(join(root, "missing"))).toBe(false);
  });
});

describe("native backend config migration", () => {
  test("migrates every native executable path with spaces without splitting arguments", () => {
    const root = temp();
    const legacy = join(root, ".env");
    writeFileSync(legacy, 'AGENT_PROVIDER=claude\nCLAUDE_BIN="./native tools/claude"\nDSH_BIN="./native tools/dsh"\nCODEX_BIN=codex\n');
    const env = importEnvFile(legacy);
    expect(env.CLAUDE_BIN).toBe(join(root, "native tools", "claude"));
    expect(env.DSH_BIN).toBe(join(root, "native tools", "dsh"));
    expect(env.CODEX_BIN).toBe("codex");
    const config = join(root, "private", "config.json");
    writeConfigFile(config, env);
    expect(readConfigFile(config)).toEqual(env);
    expect(mergeConfigEnv(env, { DSH_BIN: "overrides/my dsh", CLAUDE_BIN: "claude" }, root)).toMatchObject({ DSH_BIN: join(root, "overrides", "my dsh"), CLAUDE_BIN: "claude" });
  });
});
