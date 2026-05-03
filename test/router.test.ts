import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/agent.ts";
import type { AppConfig } from "../src/config.ts";
import { MessageRouter } from "../src/router/message-router.ts";
import { Store } from "../src/storage/store.ts";
import { TextLogger, type LogLevel } from "../src/logger.ts";
import type { AgentBuiltinCommand, AgentBuiltinResult, AgentDriver, AgentModelSummary, AgentSessionStatus, AgentThreadListOptions, AgentThreadSummary, ChatId, EditMessageTextOptions, SendMessageOptions } from "../src/types.ts";

class FakeAdapter {
  sent: Array<{ chatId: ChatId; text: string; options?: SendMessageOptions; messageId?: number }> = [];
  edited: Array<{ chatId: ChatId; text: string; options: EditMessageTextOptions }> = [];
  answered: Array<{ callbackQueryId: string; text?: string }> = [];
  chatActions: Array<{ chatId: ChatId; action?: "typing" }> = [];
  nextMessageId = 100;
  sendMessageDelayMs = 0;

  async sendMessage(chatId: ChatId, text: string, options?: SendMessageOptions): Promise<{ messageId?: number }> {
    if (this.sendMessageDelayMs > 0) await sleep(this.sendMessageDelayMs);
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
  builtins: Array<{ key: string; command: AgentBuiltinCommand }> = [];
  threadLists: AgentThreadListOptions[] = [];
  threads: AgentThreadSummary[] = [];
  models: AgentModelSummary[] = [];

  async start(options: { chatId: ChatId; workspaceName: string; workspacePath: string; threadId?: string }): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const status = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: 1,
      threadId: options.threadId ?? `thread-${this.statuses.size + 1}`,
    };
    this.statuses.set(key, status);
    return status;
  }

  async send(key: string, text: string): Promise<{ turnId?: string }> {
    this.sent.push({ key, text });
    const status = this.statuses.get(key);
    if (status?.activeTurnId) return { turnId: status.activeTurnId };
    const turnId = `turn-${this.sent.length}`;
    if (status) status.activeTurnId = turnId;
    return { turnId };
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

  async runBuiltinCommand(key: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult> {
    this.builtins.push({ key, command });
    return { message: command === "review" ? "Review started." : "Compaction started." };
  }

  async listThreads(options: AgentThreadListOptions): Promise<AgentThreadSummary[]> {
    this.threadLists.push(options);
    return this.threads;
  }

  async listModels(): Promise<AgentModelSummary[]> {
    return this.models;
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
    telegramPollTimeoutSeconds: 30,
    telegramRequestRetryMaxAttempts: 3,
    telegramRetryInitialDelayMs: 500,
    telegramRetryMaxDelayMs: 10000,
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

  test("unknown slash text is forwarded as a Codex prompt", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/unknown"));

    expect(agent.sent).toEqual([{ key: "1:demo", text: "/unknown" }]);
    expect(adapter.sent).toEqual([]);
  });

  test("console no longer exposes raw tail action", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/start"));

    const callbackData = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData).not.toContain("ar:t50");
  });

  test("formats realtime agent output as telegram entities", async () => {
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

  test("assistant output replies to the triggering user message", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle({ ...textMessage("hello"), messageId: 44, id: "44" });
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "answer", turnId: "turn-1" });
    await sleep(850);

    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBe(44);
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
    expect(paged.options?.replyMarkup?.inline_keyboard[0]?.map((button) => button.text)).toEqual(["⏮", "◀", "▶", "⏭"]);

    const previous = paged.options!.replyMarkup!.inline_keyboard[0]!.find((button) => button.text === "◀")!;
    await router.handle(callbackMessage(previous.callback_data, 7, "cb-page", paged.messageId));

    expect(adapter.edited.at(-1)?.options.messageId).toBe(paged.messageId);
    expect(adapter.edited.at(-1)?.text).toMatch(/Page \d+\/\d+$/);
    expect(adapter.sent).toHaveLength(1);

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-1" });
    expect(adapter.edited.at(-1)?.text).toContain("line 0");
    expect(adapter.edited.at(-1)?.text).toMatch(/Page 1\/\d+$/);
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
    expect(prompt.options!.replyMarkup!.inline_keyboard[0]!.map((button) => button.text)).toEqual(["✅", "❌"]);

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "after approval", turnId: "turn-1" });
    await sleep(850);

    expect(agent.responses).toEqual([{ key: "1:demo", requestId: 91, result: { decision: "accept" } }]);
    expect(adapter.edited.some((message) => message.options.messageId === firstMessageId && message.text.includes("after approval"))).toBe(false);
    expect(adapter.sent.map((message) => message.text)).toEqual([
      "before approval",
      "Approve command?\n\nbun test",
      "after approval",
    ]);
  });

  test("approval boundary waits for an in-flight stream flush instead of duplicating it", async () => {
    const { router, adapter } = fixture();
    adapter.sendMessageDelayMs = 80;

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "before approval", turnId: "turn-1" });
    await sleep(820);
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

    expect(adapter.sent.map((message) => message.text)).toEqual([
      "before approval",
      "Approve command?\n\nbun test",
    ]);
  });

  test("turn completion preserves deltas that arrive during an in-flight stream flush", async () => {
    const { router, adapter } = fixture();
    adapter.sendMessageDelayMs = 80;

    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: "first", turnId: "turn-1" });
    await sleep(820);
    await router.handleAgentOutput({ sessionKey: "1:demo", chunk: " second", turnId: "turn-1" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-1" });

    expect(adapter.sent.map((message) => message.text)).toEqual(["first"]);
    expect(adapter.edited.map((message) => message.text)).toEqual(["first second"]);
  });

  test("/start sends formatted Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/start"));

    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("cwd: none");
    expect(adapter.sent.at(-1)?.options?.entities?.[0]?.type).toBe("bold");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["📂 cwd", "➕ cwd", "↻"]);
  });

  test("/start opens Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/start"));

    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data)).toContain("ar:n");
  });

  test("slash commands are forwarded as Codex prompts when a workspace is selected", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/help"));
    await router.handle(textMessage("/relay"));
    await router.handle(textMessage("/codex"));
    await router.handle(textMessage("/status"));
    await router.handle(textMessage("/review"));
    await router.handle(textMessage("/compact"));
    await router.handle(textMessage("/model"));

    expect(agent.sent.map((message) => message.text)).toEqual([
      "/help",
      "/relay",
      "/codex",
      "/status",
      "/review",
      "/compact",
      "/model",
    ]);
    expect(agent.builtins).toEqual([]);
    expect(adapter.sent).toEqual([]);
  });

  test("/init is forwarded literally for Codex to interpret", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/init"));

    expect(agent.sent).toEqual([{ key: "1:demo", text: "/init" }]);
  });

  test("/clear is forwarded literally instead of replacing the thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.markSessionStarted("1:demo", 1, "demo", 1, "old-thread");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path, threadId: "old-thread" });

    await router.handle(textMessage("/clear"));

    expect(agent.stopped).toEqual([]);
    expect(store.getSession("1:demo")?.thread_id).toBe("old-thread");
    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "/clear" });
    expect(adapter.sent).toEqual([]);
  });

  test("clear callback requires confirmation before replacing the thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.markSessionStarted("1:demo", 1, "demo", 1, "old-thread");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path, threadId: "old-thread" });

    await router.handle(callbackMessage("ar:clear?"));
    expect(agent.stopped).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Start a new Codex session?");

    await router.handle(callbackMessage("ar:clear!", 7, "cb-clear", adapter.edited.at(-1)?.options.messageId));

    expect(agent.stopped).toEqual(["1:demo"]);
    expect(store.getSession("1:demo")?.thread_id).not.toBe("old-thread");
    expect(adapter.edited.at(-1)?.text).toContain("Started a new Codex thread.");
  });

  test("resume callback lists workspace threads and resumes selected thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path, threadId: "current-thread" });
    agent.threads = [{ id: "saved-thread", name: "Saved work", cwd: path, updatedAt: 1 }];

    await router.handle(callbackMessage("ar:rl:0"));

    expect(agent.threadLists).toEqual([{ workspacePath: path, limit: 10 }]);
    const button = adapter.edited.at(-1)?.options?.replyMarkup?.inline_keyboard[0]?.[0];
    expect(button?.callback_data).toMatch(/^ar:r:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "resume-cb", adapter.edited.at(-1)?.options.messageId));

    expect(agent.stopped).toEqual(["1:demo"]);
    expect(agent.getStatus("1:demo")?.threadId).toBe("saved-thread");
    expect(store.getSession("1:demo")?.thread_id).toBe("saved-thread");
    expect(adapter.edited.at(-1)?.text).toContain("Resumed thread");
  });

  test("console details render dynamic workspace values as code entities", async () => {
    const { router, store, adapter } = fixture();
    store.upsertWorkspace({ name: "demo", path: "/tmp/<demo>&", createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("/start"));
    await router.handle(callbackMessage("ar:d", 7, "cb-details", adapter.sent.at(-1)?.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("/tmp/<demo>&");
    expect(adapter.edited.at(-1)?.options.entities?.some((entity) => entity.type === "code")).toBe(true);
  });

  test("input without a workspace opens Relay Home", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("hello"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("cwd: none");
  });

  test("/relay without a workspace opens Relay Home instead of forwarding", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("/relay"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("cwd: none");
  });

  test("new workspace callback uses ForceReply and reply creates binding", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(callbackMessage("ar:n"));
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    const promptId = adapter.sent.length + 99;

    await router.handle(textMessage("demo", 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(agent.getStatus("1:demo")?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("created and selected");
    expect(existsSync(join(root, "demo", ".git"))).toBe(true);
  });

  test("new workspace prompt selects an existing directory without git init", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const workspaceName = "客户 repo";
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:n"));
    const promptId = adapter.sent.length + 99;
    await router.handle(textMessage(workspaceName, 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(store.getWorkspace(workspaceName)?.path).toBe(join(root, workspaceName));
    expect(agent.getStatus(`1:${workspaceName}`)?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("selected");
    expect(adapter.sent.at(-1)?.text).not.toContain("created and selected");
    expect(existsSync(join(root, workspaceName, ".git"))).toBe(false);
  });

  test("quick task button uses ForceReply and forwards the reply", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(callbackMessage("ar:i"));
    const prompt = adapter.sent.at(-1)!;

    expect(prompt.text).toContain("Prompt Codex");
    expect(prompt.options?.forceReply).toBe(true);

    await router.handle(textMessage("build the feature", 7, prompt.messageId));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "build the feature" });
  });

  test("quick task button becomes add context during an active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    const status = await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(callbackMessage("ar:i"));
    const prompt = adapter.sent.at(-1)!;

    expect(prompt.text).toContain("Add to current turn");

    await router.handle(textMessage("also cover tests", 7, prompt.messageId));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "also cover tests" });
  });

  test("ordinary text adds to the active turn while Codex is busy", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    const status = await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("new task while busy"));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "new task while busy" });
    expect(adapter.sent).toEqual([]);
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
  });

  test("/add is forwarded literally and steers the active turn", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    const status = await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("/add include tests"));

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "/add include tests" });
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
  });

  test("completed prompt card returns to Relay Home", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle(textMessage("run task"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-1" });

    const buttons = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.text);
    expect(buttons).toContain("↻ Home");
  });

  test("backlog card returns to Relay Home", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.createTask({ chatId: 1, workspaceName: "demo", text: "queued work", status: "queued" });

    await router.handle(callbackMessage("ar:queue"));

    const buttons = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text);
    expect(buttons).toContain("↻ Home");
  });

  test("relay reuses the latest console message when possible", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/start"));
    const firstMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(textMessage("/start"));

    expect(store.getConsoleMessageId(1)).toBe(firstMessageId);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.edited.at(-1)?.options.messageId).toBe(firstMessageId);
  });

  test("workspace callback switches binding, auto-starts, and edits status", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    store.upsertWorkspace({ name: "first", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "second", path: second, createdAt: 1 });
    store.bindChat(1, "first");

    await router.handle(callbackMessage("ar:u:second"));

    expect(store.getBinding(1)?.workspaceName).toBe("second");
    expect(agent.getStatus("1:second")?.running).toBe(true);
    expect(adapter.edited.at(-1)?.text).toContain("cwd: second");
    expect(adapter.edited.at(-1)?.options.entities?.some((entity) => entity.type === "code")).toBe(true);
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

    expect(adapter.edited.at(-1)?.text).toContain(longName);
    expect(store.getWorkspace(longName)?.path).toBe(longPath);
    const callbackData = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData?.filter((data) => data.startsWith("ar:uh:"))).toHaveLength(2);
    expect(callbackData?.every((data) => new TextEncoder().encode(data).length <= 64)).toBe(true);
  });

  test("/cd without a workspace opens Relay Home instead of creating cwd directly", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(textMessage("/cd demo"));

    expect(store.getBinding(1)).toBeUndefined();
    expect(agent.getStatus("1:demo")).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("cwd: none");
    expect(existsSync(join(root, "demo"))).toBe(false);
  });

  test("hashed workspace callback selects long unicode names", async () => {
    const { router, store, adapter, root } = fixture();
    const workspaceName = `客户 repo ${"a".repeat(60)}`;
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:w"));
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((candidate) => candidate.text.startsWith("○ 客户 repo"));
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2"));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(adapter.edited.at(-1)?.text).toContain("客户 repo");
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
    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
    expect(adapter.edited.at(-1)?.options.entities?.[0]?.type).toBe("bold");
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
    expect(prompt.text).toContain("Mode");
    expect(prompt.options?.entities?.[0]?.type).toBe("bold");
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

  test("ordinary text is not forwarded while Codex waits for user input", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    const status = await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });
    status.waitingForUserInput = true;

    await router.handle(textMessage("not a reply"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Codex is waiting for your answer.");
  });

  test("ordinary text is not forwarded while Codex waits for approval", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    const status = await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });
    status.waitingForApproval = true;

    await router.handle(textMessage("keep going"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Codex is waiting for approval.");
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
    const first = adapter.sent.at(-1)!;

    await router.handle(callbackMessage(first.options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 7, "cb-first", first.messageId));
    expect(agent.responses).toEqual([]);
    const second = adapter.sent.at(-1)!;
    expect(second.text).toContain("Second");

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
  return { kind: "message" as const, id: "1", messageId: 1, chatId: 1, userId, text, replyToMessageId };
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
