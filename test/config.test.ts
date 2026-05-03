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
    expect(config.telegramPollTimeoutSeconds).toBe(30);
    expect(config.telegramRequestRetryMaxAttempts).toBe(3);
    expect(config.telegramRetryInitialDelayMs).toBe(500);
    expect(config.telegramRetryMaxDelayMs).toBe(10000);
    expect(config.telegramAllowedUserIds.has(10)).toBe(true);
  });

  test("loads telegram polling and retry settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
      TELEGRAM_POLL_TIMEOUT_SECONDS: "20",
      TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS: "5",
      TELEGRAM_RETRY_INITIAL_DELAY_MS: "100",
      TELEGRAM_RETRY_MAX_DELAY_MS: "3000",
    });
    expect(config.telegramPollTimeoutSeconds).toBe(20);
    expect(config.telegramRequestRetryMaxAttempts).toBe(5);
    expect(config.telegramRetryInitialDelayMs).toBe(100);
    expect(config.telegramRetryMaxDelayMs).toBe(3000);
  });

  test("rejects invalid telegram polling and retry settings", () => {
    const baseEnv = {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };
    for (const name of [
      "TELEGRAM_POLL_TIMEOUT_SECONDS",
      "TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS",
      "TELEGRAM_RETRY_INITIAL_DELAY_MS",
      "TELEGRAM_RETRY_MAX_DELAY_MS",
    ]) {
      expect(() => loadConfig({ ...baseEnv, [name]: "" })).toThrow(name);
      expect(() => loadConfig({ ...baseEnv, [name]: "0" })).toThrow(name);
      expect(() => loadConfig({ ...baseEnv, [name]: "-1" })).toThrow(name);
      expect(() => loadConfig({ ...baseEnv, [name]: "1.5" })).toThrow(name);
      expect(() => loadConfig({ ...baseEnv, [name]: "nope" })).toThrow(name);
    }
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

  test("loads developer and model instructions from env and files", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-config-instructions-"));
    try {
      const devFile = join(dir, "developer.md");
      const modelFile = join(dir, "model.md");
      writeFileSync(devFile, "file developer");
      writeFileSync(modelFile, "model instructions");
      const config = loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_ALLOWED_USER_IDS: "10",
        WORKSPACE_ROOT: "/tmp/workspaces",
        CODEX_DEVELOPER_INSTRUCTIONS_FILE: devFile,
        CODEX_DEVELOPER_INSTRUCTIONS: "inline developer",
        CODEX_MODEL_INSTRUCTIONS_FILE: modelFile,
      });
      expect(config.codexDeveloperInstructions).toBe("file developer\n\ninline developer");
      expect(config.codexBaseInstructions).toBe("model instructions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
