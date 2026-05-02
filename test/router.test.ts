import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/agent.ts";
import type { AppConfig } from "../src/config.ts";
import { MessageRouter } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { TextLogger, type LogLevel } from "../src/logger.ts";
import type { AgentDriver, AgentSessionStatus, ChatId, EditMessageTextOptions, SendMessageOptions } from "../src/types.ts";

class FakeAdapter {
  sent: Array<{ chatId: ChatId; text: string; options?: SendMessageOptions }> = [];
  edited: Array<{ chatId: ChatId; text: string; options: EditMessageTextOptions }> = [];
  answered: Array<{ callbackQueryId: string; text?: string }> = [];

  async sendMessage(chatId: ChatId, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ chatId, text, options });
  }

  async editMessageText(chatId: ChatId, text: string, options: EditMessageTextOptions): Promise<void> {
    this.edited.push({ chatId, text, options });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answered.push({ callbackQueryId, text });
  }
}

class FakeAgent implements AgentDriver {
  statuses = new Map<string, AgentSessionStatus>();
  sent: Array<{ key: string; text: string }> = [];
  stopped: string[] = [];

  async start(options: { chatId: ChatId; workspaceName: string; workspacePath: string }): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const status = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: 1,
    };
    this.statuses.set(key, status);
    return status;
  }

  async send(key: string, text: string): Promise<void> {
    this.sent.push({ key, text });
  }

  async stop(key: string): Promise<void> {
    this.stopped.push(key);
    this.statuses.delete(key);
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.statuses.get(key);
  }
}

let dirs: string[] = [];

function fixture(logLevel: LogLevel = "info"): { router: MessageRouter; store: Store; adapter: FakeAdapter; agent: FakeAgent; root: string; logLines: string[] } {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-router-root-"));
  const data = mkdtempSync(join(tmpdir(), "agent-relay-router-data-"));
  dirs.push(root, data);
  const store = new Store(join(data, "db.sqlite"));
  const adapter = new FakeAdapter();
  const agent = new FakeAgent();
  const logLines: string[] = [];
  const logger = new TextLogger(logLevel, (line) => logLines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
  const config: AppConfig = {
    telegramBotToken: "token",
    telegramAllowedUserIds: new Set([7]),
    workspaceRoot: root,
    sqlitePath: join(data, "db.sqlite"),
    codexBin: "codex",
    codexSandbox: "workspace-write",
    codexApproval: "on-request",
    logLevel,
  };
  return { router: new MessageRouter({ config, store, adapter, agent, logger }), store, adapter, agent, root, logLines };
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("router", () => {
  test("rejects unauthorized users", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/help", 99));
    expect(adapter.sent.at(-1)?.text).toBe("Unauthorized.");
  });

  test("rejects unauthorized callbacks with callback answer only", async () => {
    const { router, adapter } = fixture();
    await router.handle(callbackMessage("ar:status", 99));
    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unauthorized." }]);
    expect(adapter.sent).toEqual([]);
    expect(adapter.edited).toEqual([]);
  });

  test("uses existing workspace and auto-starts session for text", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("hello codex"));

    expect(agent.sent).toEqual([{ key: "1:demo", text: "hello codex" }]);
    expect(agent.getStatus("1:demo")?.running).toBe(true);
  });

  test("info logs message metadata without raw text", async () => {
    const { router, store, root, logLines } = fixture("info");
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("secret prompt"));

    const logs = logLines.join("\n");
    expect(logs).toContain("router.message_received");
    expect(logs).toContain("text_len=13");
    expect(logs).not.toContain("secret prompt");
  });

  test("debug logs raw message text", async () => {
    const { router, store, root, logLines } = fixture("debug");
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("secret prompt"));

    expect(logLines.join("\n")).toContain('message_text="secret prompt"');
  });

  test("/send forwards command-like text", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/send /status"));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "/status" });
  });

  test("/tail returns agent transcript", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.appendTranscript({ chatId: 1, workspaceName: "demo", role: "agent", text: "one\n", createdAt: 1 });

    await router.handle(textMessage("/tail"));

    expect(adapter.sent.at(-1)?.text).toBe("one\n");
    expect(adapter.sent.at(-1)?.options?.parseMode).toBeUndefined();
  });

  test("/exit stops current session", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });

    await router.handle(textMessage("/exit"));

    expect(agent.stopped).toEqual(["1:demo"]);
  });

  test("/help sends formatted HTML menu", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/help"));

    expect(adapter.sent.at(-1)?.text).toContain("<b>Agent Relay</b>");
    expect(adapter.sent.at(-1)?.options?.parseMode).toBe("HTML");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data)).toContain("ar:workspaces");
  });

  test("/status escapes dynamic workspace values", async () => {
    const { router, store, adapter } = fixture();
    store.upsertWorkspace({ name: "demo", path: "/tmp/<demo>&", createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/status"));

    expect(adapter.sent.at(-1)?.text).toContain("/tmp/&lt;demo&gt;&amp;");
    expect(adapter.sent.at(-1)?.options?.parseMode).toBe("HTML");
  });

  test("workspace callback switches binding and edits status", async () => {
    const { router, store, adapter, root } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    store.upsertWorkspace({ name: "first", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "second", path: second, createdAt: 1 });
    store.bindChat(1, "first");

    await router.handle(callbackMessage("ar:use:second"));

    expect(store.getBinding(1)?.workspaceName).toBe("second");
    expect(adapter.edited.at(-1)?.text).toContain("<code>second</code>");
    expect(adapter.edited.at(-1)?.options.messageId).toBe(42);
    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: undefined }]);
  });

  test("workspaces callback renders safe buttons and text fallback for long names", async () => {
    const { router, store, adapter, root } = fixture();
    const normal = join(root, "demo");
    const longName = "a".repeat(60);
    const longPath = join(root, longName);
    mkdirSync(normal);
    mkdirSync(longPath);
    store.upsertWorkspace({ name: "demo", path: normal, createdAt: 1 });
    store.upsertWorkspace({ name: longName, path: longPath, createdAt: 1 });

    await router.handle(callbackMessage("ar:workspaces"));

    expect(adapter.edited.at(-1)?.text).toContain(`<code>${longName}</code>`);
    const callbackData = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData).toContain("ar:use:demo");
    expect(callbackData).not.toContain(`ar:use:${longName}`);
  });

  test("stop callback requires confirmation before stopping", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:exit:confirm"));
    expect(agent.stopped).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Stop Codex session?");

    await router.handle(callbackMessage("ar:exit:run", 7, "cb2"));
    expect(agent.stopped).toEqual(["1:demo"]);
    expect(adapter.edited.at(-1)?.text).toContain("Codex session stopped.");
  });

  test("unknown callback answers and renders formatted error", async () => {
    const { router, adapter } = fixture();
    await router.handle(callbackMessage("ar:nope"));

    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unknown callback." }]);
    expect(adapter.edited.at(-1)?.text).toContain("<b>Error:</b> Unknown callback.");
    expect(adapter.edited.at(-1)?.options.parseMode).toBe("HTML");
  });
});

function textMessage(text: string, userId = 7) {
  return { kind: "message" as const, id: "1", chatId: 1, userId, text };
}

function callbackMessage(data: string, userId = 7, callbackQueryId = "cb1") {
  return {
    kind: "callback_query" as const,
    id: callbackQueryId,
    chatId: 1,
    userId,
    callbackQueryId,
    messageId: 42,
    data,
  };
}
