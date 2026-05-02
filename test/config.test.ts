import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthorized, loadConfig, loadDotEnvFile, parseIdSet } from "../src/config.ts";

describe("config", () => {
  test("parses comma separated ids", () => {
    expect([...parseIdSet("1, 2,3", "IDS")]).toEqual([1, 2, 3]);
  });

  test("rejects invalid ids", () => {
    expect(() => parseIdSet("1, nope", "IDS")).toThrow("non-integer");
  });

  test("loads required env and defaults", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    });
    expect(config.sqlitePath).toBe(".data/agent-relay.sqlite");
    expect(config.codexBin).toBe("codex");
    expect(config.logLevel).toBe("info");
    expect(config.telegramAllowedUserIds.has(10)).toBe(true);
  });

  test("loads log level", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
      LOG_LEVEL: "debug",
    });
    expect(config.logLevel).toBe("debug");
  });

  test("rejects invalid log level", () => {
    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
      LOG_LEVEL: "verbose",
    })).toThrow("LOG_LEVEL");
  });

  test("loads values from dotenv files", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-config-"));
    const path = join(dir, ".env");
    try {
      writeFileSync(path, [
        "TELEGRAM_BOT_TOKEN=token",
        "TELEGRAM_ALLOWED_USER_IDS=10, 20",
        "WORKSPACE_ROOT=/tmp/workspaces # trailing comment",
        'CODEX_BIN="custom codex"',
      ].join("\n"));

      const env = loadDotEnvFile(path);
      const config = loadConfig(env);
      expect(config.telegramBotToken).toBe("token");
      expect([...config.telegramAllowedUserIds]).toEqual([10, 20]);
      expect(config.workspaceRoot).toBe("/tmp/workspaces");
      expect(config.codexBin).toBe("custom codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires user and optional chat allowlist", () => {
    const config = {
      telegramAllowedUserIds: new Set([1]),
      telegramAllowedChatIds: new Set([2]),
    };
    expect(isAuthorized(config, 1, 2)).toBe(true);
    expect(isAuthorized(config, 1, 3)).toBe(false);
    expect(isAuthorized(config, 9, 2)).toBe(false);
  });
});
