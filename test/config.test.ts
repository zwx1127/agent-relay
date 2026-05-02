import { describe, expect, test } from "bun:test";
import { isAuthorized, loadConfig, parseIdSet } from "../src/config.ts";

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
    expect(config.telegramAllowedUserIds.has(10)).toBe(true);
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
