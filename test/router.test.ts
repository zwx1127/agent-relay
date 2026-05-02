import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/agent.ts";
import type { AppConfig } from "../src/config.ts";
import { MessageRouter } from "../src/router.ts";
import { Store } from "../src/store.ts";
import { TextLogger, type LogLevel } from "../src/logger.ts";
import type { AgentDriver, AgentSessionStatus, ChatId, EditMessageTextOptions, SendMessageOptions } from "../src/types.ts";

class FakeAdapter {
  sent: Array<{ chatId: ChatId; text: string; options?: SendMessageOptions; messageId?: number }> = [];
  edited: Array<{ chatId: ChatId; text: string; options: EditMessageTextOptions }> = [];
  answered: Array<{ callbackQueryId: string; text?: string }> = [];
  chatActions: Array<{ chatId: ChatId; action?: "typing" }> = [];
  nextMessageId = 100;

  async sendMessage(chatId: ChatId, text: string, options?: SendMessageOptions): Promise<{ messageId?: number }> {
    const messageId = this.nextMessageId++;
    this.sent.push({ chatId, text, options, messageId });
    return { messageId };
  }

  async editMessageText(chatId: ChatId, text: string, options: EditMessageTextOptions): Promise<void> {
    this.edited.push({ chatId, text, options });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answered.push({ callbackQueryId, text });
  }

  async sendChatAction(chatId: ChatId, action?: "typing"): Promise<void> {
    this.chatActions.push({ chatId, action });
  }
}

class FakeAgent implements AgentDriver {
  statuses = new Map<string, AgentSessionStatus>();
  sent: Array<{ key: string; text: string }> = [];
  stopped: string[] = [];
  responses: Array<{ key: string; requestId: string | number; result: unknown }> = [];

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

  async respond(key: string, requestId: string | number, result: unknown): Promise<void> {
    this.responses.push({ key, requestId, result });
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
    await router.handle(callbackMessage("ar:s", 99));
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

  test("non-reserved slash text is forwarded to codex", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/status"));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "/status" });
  });

  test("console no longer exposes raw tail action", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/relay"));

    const callbackData = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData).not.toContain("ar:t50");
  });

  test("formats realtime agent output as telegram html", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "**Done** `src/app.ts`\n" });
    await sleep(850);

    expect(adapter.sent.at(-1)?.text).toBe("Done src/app.ts\n");
    expect(adapter.sent.at(-1)?.options?.entities?.map((entity) => entity.type)).toEqual(["bold", "code"]);
  });

  test("starts a new telegram message after a completed turn", async () => {
    const { router, adapter } = fixture();

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "first", turnId: "turn-1" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-1" });
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "second", turnId: "turn-2" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-2" });

    expect(adapter.sent.map((message) => message.text)).toEqual(["first", "second"]);
    expect(adapter.edited).toEqual([]);
  });

  test("user steer finalizes the current live output before later deltas", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "before", turnId: "turn-1" });
    await sleep(850);
    await router.handle(textMessage("follow up"));
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "after", turnId: "turn-1" });
    await sleep(850);

    expect(adapter.sent.map((message) => message.text)).toEqual(["before", "after"]);
    expect(adapter.edited).toEqual([]);
    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "follow up" });
  });

  test("long agent output is paged in one telegram message", async () => {
    const { router, adapter } = fixture();
    const longText = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: longText, turnId: "turn-1" });
    await sleep(50);

    const paged = adapter.sent.at(-1)!;
    expect(adapter.sent).toHaveLength(1);
    expect(paged.text).toMatch(/Page \d+\/\d+$/);
    expect(paged.options?.replyMarkup?.inline_keyboard[0]?.[0]?.text).toBe("Previous");

    const previous = paged.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(previous.callback_data, 7, "cb-page", paged.messageId));

    expect(adapter.edited.at(-1)?.options.messageId).toBe(paged.messageId);
    expect(adapter.edited.at(-1)?.text).toMatch(/Page \d+\/\d+$/);
    expect(adapter.sent).toHaveLength(1);
  });

  test("approval boundary prevents follow-up output from editing the previous assistant message", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "before approval", turnId: "turn-1" });
    await sleep(850);
    const firstMessageId = adapter.sent.at(-1)?.messageId;
    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "1:demo",
      requestId: 91,
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "Approve command?",
      body: "bun test",
      params: { command: "bun test" },
      turnId: "turn-1",
      itemId: "approval-1",
    });
    const prompt = adapter.sent.at(-1)!;
    const approve = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "after approval", turnId: "turn-1" });
    await sleep(850);

    expect(agent.responses).toEqual([{ key: "1:demo", requestId: 91, result: { decision: "accept" } }]);
    expect(adapter.edited.some((message) => message.options.messageId === firstMessageId && message.text.includes("after approval"))).toBe(false);
    expect(adapter.sent.map((message) => message.text)).toEqual([
      "before approval",
      "<b>Approve command?</b>\n\nbun test",
      "after approval",
    ]);
  });

  test("/relay sends formatted HTML console", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay"));

    expect(adapter.sent.at(-1)?.text).toContain("<b>Status</b>");
    expect(adapter.sent.at(-1)?.options?.parseMode).toBe("HTML");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data)).toContain("ar:w");
  });

  test("/start opens the same console", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/start"));

    expect(adapter.sent.at(-1)?.text).toContain("<b>Status</b>");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data)).toContain("ar:n");
  });

  test("console escapes dynamic workspace values", async () => {
    const { router, store, adapter } = fixture();
    store.upsertWorkspace({ name: "demo", path: "/tmp/<demo>&", createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/relay"));

    expect(adapter.sent.at(-1)?.text).toContain("/tmp/&lt;demo&gt;&amp;");
    expect(adapter.sent.at(-1)?.options?.parseMode).toBe("HTML");
  });

  test("input without a workspace opens the relay console", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("hello"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("No workspace selected.");
  });

  test("new workspace callback uses ForceReply and reply creates binding", async () => {
    const { router, store, adapter, root } = fixture();

    await router.handle(callbackMessage("ar:n"));
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    const promptId = adapter.sent.length + 99;

    await router.handle(textMessage("demo", 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(adapter.sent.at(-1)?.text).toContain("created and selected");
    expect(existsSync(join(root, "demo", ".git"))).toBe(true);
  });

  test("new workspace prompt selects an existing directory without git init", async () => {
    const { router, store, adapter, root } = fixture();
    const workspaceName = "客户 repo";
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:n"));
    const promptId = adapter.sent.length + 99;
    await router.handle(textMessage(workspaceName, 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(store.getWorkspace(workspaceName)?.path).toBe(join(root, workspaceName));
    expect(adapter.sent.at(-1)?.text).toContain("selected");
    expect(adapter.sent.at(-1)?.text).not.toContain("created and selected");
    expect(existsSync(join(root, workspaceName, ".git"))).toBe(false);
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

    await router.handle(callbackMessage("ar:u:second"));

    expect(store.getBinding(1)?.workspaceName).toBe("second");
    expect(adapter.edited.at(-1)?.text).toContain("<code>second</code>");
    expect(adapter.edited.at(-1)?.options.messageId).toBe(42);
    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: undefined }]);
  });

  test("workspaces callback discovers existing directories and uses short buttons", async () => {
    const { router, store, adapter, root } = fixture();
    const normal = join(root, "demo");
    const longName = `客户 repo ${"a".repeat(60)}`;
    const longPath = join(root, longName);
    mkdirSync(normal);
    mkdirSync(longPath);
    store.upsertWorkspace({ name: "demo", path: normal, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));

    expect(adapter.edited.at(-1)?.text).toContain(`<code>${longName}</code>`);
    expect(store.getWorkspace(longName)?.path).toBe(longPath);
    const callbackData = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData?.filter((data) => data.startsWith("ar:uh:"))).toHaveLength(2);
    expect(callbackData?.every((data) => new TextEncoder().encode(data).length <= 64)).toBe(true);
  });

  test("hashed workspace callback selects long unicode names", async () => {
    const { router, store, adapter, root } = fixture();
    const workspaceName = `客户 repo ${"a".repeat(60)}`;
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:w"));
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((candidate) => candidate.text.includes(workspaceName));
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2"));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(adapter.edited.at(-1)?.text).toContain(`<code>${workspaceName}</code>`);
  });

  test("stop callback requires confirmation before stopping", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:x?"));
    expect(agent.stopped).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Stop Codex session?");

    await router.handle(callbackMessage("ar:x!", 7, "cb2"));
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

  test("codex option question uses inline keyboard and responds with selected label", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "1:demo",
      requestId: 77,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }, { label: "Deep", description: "More detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    expect(prompt.text).toContain("<b>Mode</b>");
    const button = prompt.options?.replyMarkup?.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("Fast");

    await router.handle(callbackMessage(button!.callback_data, 7, "cbq", prompt.messageId ?? 100));

    expect(agent.responses).toEqual([{
      key: "1:demo",
      requestId: 77,
      result: { answers: { choice: { answers: ["Fast"] } } },
    }]);
    expect(adapter.edited.at(-1)?.text).toContain("Answered");
  });

  test("codex free text question uses ForceReply and reply is not forwarded as prompt", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "1:demo",
      requestId: "req1",
      questions: [{ id: "notes", header: "Notes", question: "What should I use?" }],
    });
    const promptId = adapter.sent.at(-1)?.messageId;
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);

    await router.handle(textMessage("Use SQLite", 7, promptId));

    expect(agent.responses).toEqual([{
      key: "1:demo",
      requestId: "req1",
      result: { answers: { notes: { answers: ["Use SQLite"] } } },
    }]);
    expect(agent.sent).toEqual([]);
  });

  test("codex multi-question request waits for all answers", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "1:demo",
      requestId: 88,
      questions: [
        { id: "first", header: "First", question: "A?", options: [{ label: "A", description: "" }] },
        { id: "second", header: "Second", question: "B?", options: [{ label: "B", description: "" }] },
      ],
    });
    const first = adapter.sent.at(-2)!;
    const second = adapter.sent.at(-1)!;

    await router.handle(callbackMessage(first.options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 7, "cb-first", first.messageId));
    expect(agent.responses).toEqual([]);

    await router.handle(callbackMessage(second.options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 7, "cb-second", second.messageId));
    expect(agent.responses.at(-1)?.result).toEqual({
      answers: {
        first: { answers: ["A"] },
        second: { answers: ["B"] },
      },
    });
  });

  test("stale codex question does not forward answer to Codex", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.setPendingPrompt({
      chatId: 1,
      promptMessageId: 501,
      kind: "codex_user_input",
      createdAt: 1,
      sessionKey: "1:demo",
      expiresAt: Date.now() - 1,
      payloadJson: JSON.stringify({ requestId: "old", questionId: "q" }),
    });

    await router.handle(textMessage("late answer", 7, 501));

    expect(agent.responses).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toBe("Question expired.");
  });

  test("codex command approval sends button decision", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "1:demo",
      requestId: 91,
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "Approve command?",
      body: "bun test",
      params: { command: "bun test" },
    });
    const prompt = adapter.sent.at(-1)!;
    const approve = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));

    expect(agent.responses).toEqual([{ key: "1:demo", requestId: 91, result: { decision: "accept" } }]);
    expect(adapter.edited.at(-1)?.text).toContain("Approved");
  });
});

function textMessage(text: string, userId = 7, replyToMessageId?: number) {
  return { kind: "message" as const, id: "1", chatId: 1, userId, text, replyToMessageId };
}

function callbackMessage(data: string, userId = 7, callbackQueryId = "cb1", messageId = 42) {
  return {
    kind: "callback_query" as const,
    id: callbackQueryId,
    chatId: 1,
    userId,
    callbackQueryId,
    messageId,
    data,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
