import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthorized, loadConfig, loadDotEnvFile, parseStringSet } from "../../src/runtime/config.ts";

describe("config", () => {
  test("parses comma separated ids", () => {
    expect([...parseStringSet("1, 2,3", "IDS")]).toEqual(["1", "2", "3"]);
  });

  test("rejects invalid ids", () => {
    expect(() => parseStringSet("", "IDS")).toThrow("IDS");
  });

  test("loads required env and defaults", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    });
    expect(config.sqlitePath).toBe(".data/agent-relay.sqlite");
    expect(config.codexBin).toBe("codex");
    expect(config.logLevel).toBe("info");
    expect(config.telegramPollTimeoutSeconds).toBe(30);
    expect(config.telegramRequestRetryMaxAttempts).toBe(3);
    expect(config.telegramRetryInitialDelayMs).toBe(500);
    expect(config.telegramRetryMaxDelayMs).toBe(10000);
    expect(config.relayControlEnabled).toBe(false);
    expect(config.relayControlPort).toBe(0);
    expect(config.experimentalSeamlessWorkEnabled).toBe(false);
    expect(config.experimentalSeamlessGatewayPort).toBe(18765);
    expect(config.experimentalSeamlessGatewayStatePath).toBe(".data/agent-relay-gateway.json");
    expect(config.relayPeerAgents).toEqual([]);
    expect(config.imProvider).toBe("telegram");
    expect(config.agentProvider).toBe("codex");
    expect(config.larkDomain).toBe("feishu");
    expect(config.larkCardActionDispatchDelayMs).toBe(150);
    expect(config.allowedUserIds.has("10")).toBe(true);
  });

  test("loads explicit IM provider", () => {
    const config = loadConfig({
      IM_PROVIDER: "telegram",
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    });
    expect(config.imProvider).toBe("telegram");
  });

  test("loads lark IM provider", () => {
    const config = loadConfig({
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      ALLOWED_USER_IDS: "ou_user",
      WORKSPACE_ROOT: "/tmp/workspaces",
    });
    expect(config.imProvider).toBe("lark");
    expect(config.larkAppId).toBe("cli_a");
    expect(config.larkAppSecret).toBe("secret");
    expect(config.larkDomain).toBe("feishu");
    expect(config.larkCardActionDispatchDelayMs).toBe(150);
    expect(config.telegramBotToken).toBeUndefined();
  });

  test("loads lark domain options", () => {
    const baseEnv = {
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      ALLOWED_USER_IDS: "ou_user",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };

    expect(loadConfig({ ...baseEnv, LARK_DOMAIN: "feishu" }).larkDomain).toBe("feishu");
    expect(loadConfig({ ...baseEnv, LARK_DOMAIN: "lark" }).larkDomain).toBe("lark");
    expect(loadConfig({ ...baseEnv, LARK_DOMAIN: "https://open.example.com" }).larkDomain).toBe("https://open.example.com");
    expect(loadConfig({ ...baseEnv, LARK_DOMAIN: "https://open.example.com/" }).larkDomain).toBe("https://open.example.com");
  });

  test("loads lark card action dispatch delay", () => {
    const baseEnv = {
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      ALLOWED_USER_IDS: "ou_user",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };

    expect(loadConfig(baseEnv).larkCardActionDispatchDelayMs).toBe(150);
    expect(loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "0" }).larkCardActionDispatchDelayMs).toBe(0);
    expect(loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "250" }).larkCardActionDispatchDelayMs).toBe(250);
  });

  test("rejects invalid lark card action dispatch delay", () => {
    const baseEnv = {
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      ALLOWED_USER_IDS: "ou_user",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };

    expect(() => loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "" })).toThrow("LARK_CARD_ACTION_DISPATCH_DELAY_MS");
    expect(() => loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "-1" })).toThrow("LARK_CARD_ACTION_DISPATCH_DELAY_MS");
    expect(() => loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "1.5" })).toThrow("LARK_CARD_ACTION_DISPATCH_DELAY_MS");
    expect(() => loadConfig({ ...baseEnv, LARK_CARD_ACTION_DISPATCH_DELAY_MS: "nope" })).toThrow("LARK_CARD_ACTION_DISPATCH_DELAY_MS");
  });

  test("rejects invalid and deprecated IM provider settings", () => {
    const baseEnv = {
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };
    expect(() => loadConfig({ ...baseEnv, IM_PROVIDER: "slack" })).toThrow("IM_PROVIDER");
    expect(() => loadConfig({ ...baseEnv, MESSAGING_PROVIDER: "telegram" })).toThrow("MESSAGING_PROVIDER has been renamed to IM_PROVIDER");
  });

  test("requires provider-specific IM credentials", () => {
    expect(() => loadConfig({
      IM_PROVIDER: "telegram",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    })).toThrow("TELEGRAM_BOT_TOKEN");
    expect(() => loadConfig({
      IM_PROVIDER: "lark",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    })).toThrow("LARK_APP_ID");
    expect(() => loadConfig({
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    })).toThrow("LARK_APP_SECRET");
    expect(() => loadConfig({
      IM_PROVIDER: "lark",
      LARK_APP_ID: "cli_a",
      LARK_APP_SECRET: "secret",
      LARK_DOMAIN: "unknown",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    })).toThrow("LARK_DOMAIN");
  });

  test("loads telegram polling and retry settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
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

  test("loads relay peer agent settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-peers-"));
    try {
      const peersFile = join(dir, "peers.json");
      writeFileSync(peersFile, JSON.stringify([
        { id: "designer", name: "Designer", telegramUsername: "@designer_bot", larkOpenId: "ou_designer" },
      ]));

      const config = loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_BOT_USERNAME: "@relay_bot",
        ALLOWED_USER_IDS: "10",
        WORKSPACE_ROOT: "/tmp/workspaces",
        RELAY_AGENT_NAME: "builder",
        RELAY_PEER_AGENTS_FILE: peersFile,
      });

      expect(config.telegramBotUsername).toBe("relay_bot");
      expect(config.relayAgentName).toBe("builder");
      expect(config.relayPeerAgents).toEqual([
        { id: "designer", name: "Designer", telegramUsername: "designer_bot", larkOpenId: "ou_designer" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects invalid telegram polling and retry settings", () => {
    const baseEnv = {
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
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
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
      LOG_LEVEL: "debug",
    });
    expect(config.logLevel).toBe("debug");
  });

  test("loads relay control settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
      RELAY_CONTROL_ENABLED: "true",
      RELAY_CONTROL_PORT: "37281",
    });
    expect(config.relayControlEnabled).toBe(true);
    expect(config.relayControlPort).toBe(37281);
  });

  test("rejects invalid relay control settings", () => {
    const baseEnv = {
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };
    expect(() => loadConfig({ ...baseEnv, RELAY_CONTROL_ENABLED: "maybe" })).toThrow("RELAY_CONTROL_ENABLED");
    expect(() => loadConfig({ ...baseEnv, RELAY_CONTROL_PORT: "" })).toThrow("RELAY_CONTROL_PORT");
    expect(() => loadConfig({ ...baseEnv, RELAY_CONTROL_PORT: "-1" })).toThrow("RELAY_CONTROL_PORT");
    expect(() => loadConfig({ ...baseEnv, RELAY_CONTROL_PORT: "1.5" })).toThrow("RELAY_CONTROL_PORT");
  });

  test("loads experimental seamless work only through an explicit valid opt-in", () => {
    const baseEnv = {
      TELEGRAM_BOT_TOKEN: "token",
      ALLOWED_USER_IDS: "10",
      WORKSPACE_ROOT: "/tmp/workspaces",
    };
    const config = loadConfig({
      ...baseEnv,
      EXPERIMENTAL_SEAMLESS_WORK_ENABLED: "true",
      EXPERIMENTAL_SEAMLESS_GATEWAY_PORT: "29991",
      EXPERIMENTAL_SEAMLESS_GATEWAY_STATE_PATH: "/tmp/seamless.json",
    });
    expect(config.experimentalSeamlessWorkEnabled).toBe(true);
    expect(config.experimentalSeamlessGatewayPort).toBe(29991);
    expect(config.experimentalSeamlessGatewayStatePath).toBe("/tmp/seamless.json");
    expect(() => loadConfig({ ...baseEnv, EXPERIMENTAL_SEAMLESS_WORK_ENABLED: "maybe" })).toThrow("EXPERIMENTAL_SEAMLESS_WORK_ENABLED");
    expect(() => loadConfig({ ...baseEnv, EXPERIMENTAL_SEAMLESS_GATEWAY_PORT: "0" })).toThrow("EXPERIMENTAL_SEAMLESS_GATEWAY_PORT");
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
        ALLOWED_USER_IDS: "10",
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
      ALLOWED_USER_IDS: "10",
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
        "ALLOWED_USER_IDS=10, 20",
        "WORKSPACE_ROOT=/tmp/workspaces # trailing comment",
        'CODEX_BIN="custom codex"',
      ].join("\n"));

      const env = loadDotEnvFile(path);
      const config = loadConfig(env);
      expect(config.telegramBotToken).toBe("token");
      expect([...config.allowedUserIds]).toEqual(["10", "20"]);
      expect(config.workspaceRoot).toBe("/tmp/workspaces");
      expect(config.codexBin).toBe("custom codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requires user and optional chat allowlist", () => {
    const config = {
      allowedUserIds: new Set(["1"]),
      allowedConversationIds: new Set(["2"]),
    };
    expect(isAuthorized(config, 1, 2)).toBe(true);
    expect(isAuthorized(config, 1, 3)).toBe(false);
    expect(isAuthorized(config, 9, 2)).toBe(false);
  });
});
