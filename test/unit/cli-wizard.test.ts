import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { WizardCancelledError, type Choice, type TextPromptOptions, type WizardUI } from "../../src/cli/prompts.ts";
import { normalizeAllowlist, runWizard } from "../../src/cli/wizard.ts";
import { loadConfig, type Env } from "../../src/runtime/config.ts";

const token = "123456:abcdefghijklmnopqrstuvwxyz123456789";
const appSecret = "private-lark-secret";

class ScriptedUI implements WizardUI {
  readonly messages: string[] = [];
  readonly textCalls: { prompt: string; options: TextPromptOptions }[] = [];
  readonly confirmations: { prompt: string; defaultValue: boolean | undefined }[] = [];
  readonly choices: { prompt: string; values: string[] }[] = [];
  closed = false;
  cancelAt?: string;
  constructor(
    readonly answers: Record<string, string | string[]> = {
      "Telegram bot token": token,
      "Allowed Telegram user IDs": "123,456",
      "App ID": "cli_example",
      "App Secret": appSecret,
      "Allowed user open_ids": "ou_person",
    },
    readonly selected: Record<string, string> = {},
    readonly confirms: Record<string, boolean> = { "Save this configuration": true },
  ) {}
  write(message: string): void { this.messages.push(message); }
  async text(prompt: string, options: TextPromptOptions = {}): Promise<string> {
    this.textCalls.push({ prompt, options });
    if (this.cancelAt && prompt.startsWith(this.cancelAt)) throw new WizardCancelledError();
    const key = Object.keys(this.answers).find((key) => prompt.startsWith(key));
    const answer = key === undefined ? undefined : this.answers[key];
    if (Array.isArray(answer)) {
      if (!answer.length) throw new Error("No scripted answer left");
      return answer.shift()!;
    }
    return answer ?? options.defaultValue ?? "";
  }
  async confirm(prompt: string, defaultValue?: boolean): Promise<boolean> {
    this.confirmations.push({ prompt, defaultValue });
    if (this.cancelAt && prompt.startsWith(this.cancelAt)) throw new WizardCancelledError();
    const key = Object.keys(this.confirms).find((key) => prompt.startsWith(key));
    return key === undefined ? defaultValue ?? false : this.confirms[key]!;
  }
  async choose<T extends string>(prompt: string, choices: readonly Choice<T>[], defaultValue?: T): Promise<T> {
    this.choices.push({ prompt, values: choices.map((choice) => choice.value) });
    const key = Object.keys(this.selected).find((key) => prompt.startsWith(key));
    const selected = key === undefined ? undefined : this.selected[key];
    return choices.find((choice) => choice.value === selected)?.value ?? defaultValue ?? choices[0]!.value;
  }
  close(): void { this.closed = true; }
}

const detected = async () => ({ found: true, path: join(tmpdir(), "codex"), version: "0.145.0", compatible: true });
const run = (ui: ScriptedUI, initial?: Env) => runWizard({ ui, initial, configPath: join(tmpdir(), "agent-relay-config", "config.json"), cwd: join(tmpdir(), "setup-directory"), detectCodex: detected });

describe("setup wizard", () => {
  test("returns valid safe Telegram config without writing or unsolicited verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-wizard-"));
    const configPath = join(dir, "private", "config.json");
    const ui = new ScriptedUI();
    let checks = 0;
    try {
      const env = await runWizard({ ui, configPath, cwd: dir, detectCodex: detected, validateProvider: async () => { checks++; throw new Error("Must not verify"); } });
      expect(env).toMatchObject({
        IM_PROVIDER: "telegram", AGENT_PROVIDER: "codex", TELEGRAM_BOT_TOKEN: token,
        ALLOWED_USER_IDS: "123,456", CODEX_SANDBOX: "workspace-write", CODEX_APPROVAL: "on-request", LOG_LEVEL: "info",
        RELAY_CONTROL_ENABLED: "false", EXPERIMENTAL_RELAY_WORK_ENABLED: "false",
        SQLITE_PATH: join(dir, "private", "state", "agent-relay.sqlite"),
      });
      expect(isAbsolute(env!.WORKSPACE_ROOT!)).toBe(true);
      expect(loadConfig(env).allowedUserIds.size).toBe(2);
      expect(checks).toBe(0);
      expect(existsSync(join(dir, "private"))).toBe(false);
      expect(ui.closed).toBe(true);
      expect(ui.confirmations.every((confirmation) => confirmation.defaultValue === false)).toBe(true);
      expect(ui.textCalls.find((call) => call.prompt === "Telegram bot token")?.options.secret).toBe(true);
      expect(ui.messages.join("\n")).not.toContain(token);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("retries invalid token and IDs without printing rejected values", async () => {
    const ui = new ScriptedUI({
      "Telegram bot token": ["bad-secret-token", token],
      "Allowed Telegram user IDs": ["@not-an-id", "0", "10, 20,10"],
      "Allowed Telegram chat IDs": ["a-private-chat-name", "-100123,20"],
    });
    const env = await run(ui);
    expect(env?.ALLOWED_USER_IDS).toBe("10,20");
    expect(env?.ALLOWED_CONVERSATION_IDS).toBe("-100123,20");
    const output = ui.messages.join("\n");
    expect(output).not.toContain("bad-secret-token");
    expect(output).not.toContain("@not-an-id");
    expect(output).not.toContain("a-private-chat-name");
    expect(ui.textCalls.filter((call) => call.prompt === "Telegram bot token")).toHaveLength(2);
  });

  test("normalizes relative paths independently of the eventual launch cwd", async () => {
    const ui = new ScriptedUI({
      "Telegram bot token": token, "Allowed Telegram user IDs": "10",
      "Workspace root": "projects", "SQLite state file": "state/db.sqlite", "Codex binary": "tools/codex",
    });
    let executable = "";
    const cwd = join(tmpdir(), "setup-root");
    const env = await runWizard({ ui, configPath: "config.json", cwd, detectCodex: async (binary) => { executable = binary; return { found: false }; } });
    expect(env?.WORKSPACE_ROOT).toBe(join(cwd, "projects"));
    expect(env?.SQLITE_PATH).toBe(join(cwd, "state", "db.sqlite"));
    expect(executable).toBe(join(cwd, "tools", "codex"));
    expect(ui.messages.join("\n")).toContain("will not install or sign in");
  });

  test("cancel at a masked credential prompt leaves the original config unchanged", async () => {
    const initial = Object.freeze({ TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "10", EXTRA_SETTING: "keep-me" });
    const ui = new ScriptedUI();
    ui.cancelAt = "Telegram bot token";
    expect(await run(ui, initial)).toBeUndefined();
    expect(initial).toEqual({ TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "10", EXTRA_SETTING: "keep-me" });
    expect(ui.closed).toBe(true);
    expect(ui.messages.join("\n")).toContain("No configuration was saved");
  });

  test("declining final save or cancelling final confirmation returns no config", async () => {
    for (const cancel of [false, true]) {
      const ui = new ScriptedUI(undefined, undefined, {});
      if (cancel) ui.cancelAt = "Save this configuration";
      expect(await run(ui)).toBeUndefined();
      expect(ui.closed).toBe(true);
    }
  });

  test("reconfiguration does not preserve risky defaults and can clear chat restrictions", async () => {
    const ui = new ScriptedUI({ "Allowed Telegram chat IDs": "-" });
    const env = await run(ui, {
      TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "10", ALLOWED_CONVERSATION_IDS: "-100123",
      CODEX_SANDBOX: "danger-full-access", CODEX_APPROVAL: "never", LOG_LEVEL: "debug",
      RELAY_CONTROL_ENABLED: "true", EXPERIMENTAL_RELAY_WORK_ENABLED: "true", EXTRA_SETTING: "keep-me",
    });
    expect(env).toMatchObject({ CODEX_SANDBOX: "workspace-write", CODEX_APPROVAL: "on-request", LOG_LEVEL: "info", ALLOWED_CONVERSATION_IDS: "", EXTRA_SETTING: "keep-me" });
    expect(ui.choices.flatMap((choice) => choice.values)).not.toContain("danger-full-access");
    expect(ui.choices.flatMap((choice) => choice.values)).not.toContain("never");
  });

  test("Lark flow uses region, app-specific IDs, secret masking, and the start-before-console sequence", async () => {
    const ui = new ScriptedUI(undefined, { "Messaging provider": "lark", "App region": "lark" });
    const env = await run(ui, { IM_PROVIDER: "telegram", TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: "old_bot", ALLOWED_USER_IDS: "10" });
    expect(env).toMatchObject({ IM_PROVIDER: "lark", LARK_DOMAIN: "lark", LARK_APP_ID: "cli_example", LARK_APP_SECRET: appSecret, ALLOWED_USER_IDS: "ou_person" });
    expect(env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env?.TELEGRAM_BOT_USERNAME).toBeUndefined();
    expect(ui.textCalls.find((call) => call.prompt === "App Secret")?.options.secret).toBe(true);
    const output = ui.messages.join("\n");
    expect(output).toContain("https://open.larksuite.com/app");
    expect(output).toContain("First save this configuration and start agent-relay");
    expect(output).toContain("im.message.receive_v1");
    expect(output).toContain("card.action.trigger");
    expect(output).toContain("availability scope");
    expect(output).not.toContain(appSecret);
    expect(loadConfig(env).allowedUserIds.has("ou_person")).toBe(true);
  });

  test("provider verification requires informed opt-in and redacts custom validator output", async () => {
    const ui = new ScriptedUI(undefined, undefined, { "Verify now?": true, "Save this configuration": true });
    let approved = false;
    const env = await runWizard({ ui, configPath: join(tmpdir(), "config.json"), detectCodex: detected,
      validateProvider: async (config, options) => {
        approved = options.approved;
        expect(config.TELEGRAM_BOT_TOKEN).toBe(token);
        return { ok: true, message: `reflected ${token}`, warnings: [`token in url ${token}`] };
      },
    });
    expect(env).toBeDefined();
    expect(approved).toBe(true);
    const consent = ui.confirmations.find((item) => item.prompt.startsWith("Verify now?"))?.prompt;
    expect(consent).toContain("https://api.telegram.org");
    expect(consent).toContain("getMe and getWebhookInfo");
    expect(consent).toContain("No user/chat IDs are sent");
    expect(ui.messages.join("\n")).not.toContain(token);
  });

  test("a failed credential check requires explicit save-anyway confirmation", async () => {
    const ui = new ScriptedUI(undefined, undefined, { "Verify now?": true });
    const env = await runWizard({ ui, configPath: join(tmpdir(), "config.json"), detectCodex: detected,
      validateProvider: async () => { throw new Error(`Do not display ${token}`); },
    });
    expect(env).toBeUndefined();
    expect(ui.confirmations.at(-1)?.prompt).toContain("despite the failed credential check");
    expect(ui.messages.join("\n")).not.toContain(token);
  });
});

describe("setup allowlists", () => {
  test("requires positive user IDs and accepts negative group IDs", () => {
    expect(normalizeAllowlist("1, 2,1", "telegram-user")).toBe("1,2");
    expect(normalizeAllowlist("-100123,2", "telegram-chat")).toBe("-100123,2");
    for (const value of ["", "*", "@alice", "-1", "0", "1.5", "1e3", "9007199254740993", "1,"]) {
      expect(normalizeAllowlist(value, "telegram-user")).toBeUndefined();
    }
    expect(normalizeAllowlist("", "telegram-chat", true)).toBe("");
  });
  test("requires provider-specific Lark user and chat IDs", () => {
    expect(normalizeAllowlist("ou_a,ou_b", "lark-user")).toBe("ou_a,ou_b");
    expect(normalizeAllowlist("oc_a", "lark-chat", true)).toBe("oc_a");
    for (const value of ["123", "on_union_id", "oc_chat", "ou_", "*"]) expect(normalizeAllowlist(value, "lark-user")).toBeUndefined();
    expect(normalizeAllowlist("ou_user", "lark-chat", true)).toBeUndefined();
  });
});

describe("native backend setup selection", () => {
  test("switching backends defaults to separate state without replaying old queued work", async () => {
    const configPath = join(tmpdir(), "native-state-config", "config.json");
    const oldState = join(tmpdir(), "custom-codex.sqlite");
    const initial = { AGENT_PROVIDER: "codex", SQLITE_PATH: oldState, TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "10", CODEX_BIN: "/native/codex" };
    const ui = new ScriptedUI(undefined, { "Agent backend": "claude" });
    const env = await runWizard({ ui, initial, configPath, detectAgent: async () => ({ found: false }) });
    expect(env?.SQLITE_PATH).toBe(join(tmpdir(), "native-state-config", "state", "agent-relay-claude.sqlite"));
    expect(initial.SQLITE_PATH).toBe(oldState);
    expect(env?.CODEX_BIN).toBe("/native/codex");
    expect(ui.messages.join("\n")).toContain("never replayed through another agent");
    const repeat = await runWizard({ ui: new ScriptedUI(), initial: { ...env, SQLITE_PATH: "/custom/claude-state.sqlite" }, configPath, detectAgent: async () => ({ found: false }) });
    expect(repeat?.SQLITE_PATH).toBe("/custom/claude-state.sqlite");
  });
  test("asks for backend first and offers only the selected backend's settings", async () => {
    for (const provider of ["claude", "dsh"] as const) {
      const label = provider === "claude" ? "Claude Code" : "DeepSeek Harness";
      const key = provider === "claude" ? "CLAUDE_BIN" : "DSH_BIN";
      const ui = new ScriptedUI({ "Telegram bot token": token, "Allowed Telegram user IDs": "10", [`${label} binary`]: `native tools/${provider}` }, { "Agent backend": provider });
      let selected: string | undefined;
      let executable: string | undefined;
      const cwd = join(tmpdir(), "native setup");
      const env = await runWizard({ ui, configPath: "config.json", cwd, initial: {
        CODEX_BIN: "existing-codex", CODEX_SANDBOX: "read-only", CODEX_APPROVAL: "untrusted",
        CODEX_MODEL_INSTRUCTIONS_FILE: "/missing/codex-only.md", EXPERIMENTAL_RELAY_WORK_ENABLED: "true", RELAY_CONTROL_ENABLED: "true",
      }, detectAgent: async (agent, binary) => { selected = agent; executable = binary; return { found: true, path: binary, version: "2.1.280" }; },
        detectCodex: async () => { throw new Error("Must not detect unrelated Codex"); },
      });
      expect(selected).toBe(provider);
      expect(executable).toBe(join(cwd, "native tools", provider));
      expect(env).toMatchObject({ AGENT_PROVIDER: provider, [key]: executable, EXPERIMENTAL_RELAY_WORK_ENABLED: "false", CODEX_BIN: "existing-codex", CODEX_SANDBOX: "read-only", CODEX_APPROVAL: "untrusted" });
      expect(loadConfig(env).agentProvider).toBe(provider);
      expect(ui.choices[0]?.prompt).toBe("Agent backend");
      expect(ui.choices.some((choice) => choice.prompt.startsWith("Codex"))).toBe(false);
      expect(ui.textCalls.some((call) => call.prompt.startsWith("Codex"))).toBe(false);
      expect(ui.confirmations.some((call) => call.prompt.startsWith("Enable the experimental Gateway"))).toBe(false);
      expect(ui.messages.join("\n")).toContain("Version detection does not verify protocol compatibility or authentication");
      expect(ui.messages.join("\n")).toContain(`Agent backend: ${label}`);
      if (provider === "dsh") {
        expect(env?.RELAY_CONTROL_ENABLED).toBe("false");
        expect(ui.confirmations.some((call) => call.prompt.startsWith("Enable the optional localhost helper"))).toBe(false);
        expect(ui.messages.join("\n")).toContain("helper is unavailable for the verified DeepSeek Harness Web profile");
      } else {
        expect(ui.confirmations.some((call) => call.prompt.startsWith("Enable the optional localhost helper"))).toBe(true);
      }
    }
  });

  test("reconfiguration defaults to the saved backend and preserves its executable", async () => {
    for (const provider of ["claude", "dsh"] as const) {
      const key = provider === "claude" ? "CLAUDE_BIN" : "DSH_BIN";
      const binary = join(tmpdir(), "saved native tools", provider);
      const initial = Object.freeze({ AGENT_PROVIDER: provider, [key]: binary, TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "10" });
      const ui = new ScriptedUI();
      const env = await runWizard({ ui, initial, configPath: join(tmpdir(), "config.json"), detectAgent: async (selected, executable) => {
        expect(selected).toBe(provider); expect(executable).toBe(binary); return { found: false };
      } });
      expect(env?.AGENT_PROVIDER).toBe(provider);
      expect(env?.[key]).toBe(binary);
      expect(ui.messages.join("\n")).toContain("Setup will not install or sign in for you");
      expect(initial[key]).toBe(binary);
    }
  });
});
