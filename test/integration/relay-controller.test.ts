import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import type { AppConfig } from "../../src/runtime/config.ts";
import { RelayController } from "../../src/relay/controller.ts";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";
import { TextLogger, type LogLevel } from "../../src/domain/logger.ts";
import type { MessageId } from "../../src/domain/ids.ts";
import { FakeAgent, FakeImAdapter, sleep } from "../support/fakes.ts";


let dirs: string[] = [];

function fixture(logLevel: LogLevel = "info"): { router: RelayController; store: SQLiteStore; adapter: FakeImAdapter; agent: FakeAgent; root: string; logLines: string[] } {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-controller-root-"));
  const data = mkdtempSync(join(tmpdir(), "agent-relay-controller-data-"));
  dirs.push(root, data);
  const store = new SQLiteStore(join(data, "db.sqlite"));
  const adapter = new FakeImAdapter();
  const agent = new FakeAgent();
  const logLines: string[] = [];
  const logger = new TextLogger(logLevel, (line) => logLines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
  const config: AppConfig = {
    imProvider: "telegram",
    agentProvider: "codex",
    telegramBotToken: "token",
    allowedUserIds: new Set(["7"]),
    mediaMaxBytes: 20 * 1024 * 1024,
    telegramPollTimeoutSeconds: 30,
    telegramRequestRetryMaxAttempts: 3,
    telegramRetryInitialDelayMs: 500,
    telegramRetryMaxDelayMs: 10000,
    workspaceRoot: root,
    sqlitePath: join(data, "db.sqlite"),
    codexBin: "codex",
    codexSandbox: "workspace-write",
    codexApproval: "on-request",
    relayControlEnabled: false,
    relayControlPort: 0,
    logLevel,
  };
  return { router: new RelayController({ config, store, adapter, agent, logger }), store, adapter, agent, root, logLines };
}

function sentPrompt(text: string, collaborationMode: "default" | "plan" = "default"): { key: string; text: string; options: { collaborationMode: "default" | "plan" } } {
  return { key: "codex:1:demo", text, options: { collaborationMode } };
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("relay controller", () => {
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
    store.bindConversation(1, "demo");

    await router.handle(textMessage("hello codex"));

    expect(agent.sent).toEqual([sentPrompt("hello codex")]);
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
  });

  test("info logs message metadata without raw text", async () => {
    const { router, store, root, logLines } = fixture("info");
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

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
    store.bindConversation(1, "demo");

    await router.handle(textMessage("secret prompt"));

    expect(logLines.join("\n")).toContain('message_text="secret prompt"');
  });

  test("unknown slash text is forwarded as a Codex prompt", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/unknown"));

    expect(agent.sent).toEqual([sentPrompt("/unknown")]);
    expect(adapter.sent).toEqual([]);
    expect(adapter.reactions).toEqual([{ conversationId: "1", messageId: "1", emoji: "✍" }]);
  });

  test("console no longer exposes raw tail action", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/relay"));

    const callbackData = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData).not.toContain("ar:t50");
  });

  test("formats realtime agent output as telegram entities", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "**Done** `src/app.ts`\n" });
    await sleep(850);

    expect(adapter.sent.at(-1)?.text).toBe("Done src/app.ts\n");
    expect(adapter.sent.at(-1)?.options?.entities?.map((entity) => entity.type)).toEqual(["bold", "code"]);
  });

  test("assistant output replies to the triggering user message", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle({ ...textMessage("hello"), messageId: 44, id: "44" });
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "answer", turnId: "turn-1" });
    await sleep(850);

    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBe("44");
  });

  test("starts a new telegram message after a completed turn", async () => {
    const { router, adapter } = fixture();

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "first", turnId: "turn-1" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "second", turnId: "turn-2" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-2" });

    expect(adapter.sent.map((message) => message.text)).toEqual(["first", "second"]);
    expect(adapter.edited).toEqual([]);
  });

  test("user steer finalizes the current live output before later deltas", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "before", turnId: "turn-1" });
    await sleep(850);
    await router.handle(textMessage("follow up"));
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "after", turnId: "turn-1" });
    await sleep(850);

    expect(adapter.sent.map((message) => message.text)).toEqual(["before", "after"]);
    expect(adapter.edited).toEqual([]);
    expect(adapter.reactions).toEqual([{ conversationId: "1", messageId: "1", emoji: "✍" }]);
    expect(agent.sent.at(-1)).toEqual(sentPrompt("follow up"));
  });

  test("long agent output is paged in one telegram message", async () => {
    const { router, adapter } = fixture();
    const longText = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: longText, turnId: "turn-1" });
    await sleep(50);

    const paged = adapter.sent.at(-1)!;
    expect(adapter.sent).toHaveLength(1);
    expect(paged.text).toMatch(/Page \d+\/\d+$/);
    expect(paged.options?.replyMarkup?.inline_keyboard[0]?.map((button) => button.text)).toEqual(["First", "Prev", "Next", "Last"]);

    const previous = paged.options!.replyMarkup!.inline_keyboard[0]!.find((button) => button.text === "Prev")!;
    await router.handle(callbackMessage(previous.callback_data, 7, "cb-page", paged.messageId));

    expect(adapter.edited.at(-1)?.options.messageId).toBe(paged.messageId);
    expect(adapter.edited.at(-1)?.text).toMatch(/Page \d+\/\d+$/);
    expect(adapter.sent).toHaveLength(1);

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    expect(adapter.edited.at(-1)?.text).toContain("line 0");
    expect(adapter.edited.at(-1)?.text).toMatch(/Page 1\/\d+$/);
  });

  test("approval boundary prevents follow-up output from editing the previous assistant message", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "before approval", turnId: "turn-1" });
    await sleep(850);
    const firstMessageId = adapter.sent.at(-1)?.messageId;
    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "codex:1:demo",
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
    expect(prompt.options!.replyMarkup!.inline_keyboard[0]!.map((button) => button.text)).toEqual(["Approve", "Deny"]);

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "after approval", turnId: "turn-1" });
    await sleep(850);

    expect(agent.responses).toEqual([{ key: "codex:1:demo", requestId: 91, result: { decision: "accept" } }]);
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

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "before approval", turnId: "turn-1" });
    await sleep(820);
    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "codex:1:demo",
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

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "first", turnId: "turn-1" });
    await sleep(820);
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: " second", turnId: "turn-1" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(adapter.sent.map((message) => message.text)).toEqual(["first"]);
    expect(adapter.edited.map((message) => message.text)).toEqual(["first second"]);
  });

  test("/relay sends formatted Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay"));

    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("workspace: none");
    expect(adapter.sent.at(-1)?.text).toContain("Waiting: none");
    expect(adapter.sent.at(-1)?.options?.entities?.[0]?.type).toBe("bold");
    expect(adapter.sent.at(-1)?.text).toContain("⚪ Stopped");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Workspaces", "Details", "Refresh"]);
  });

  test("/relay opens Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay"));

    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data)).toEqual(["ar:w", "ar:status", "ar:s"]);
  });

  test("unsupported slash commands are forwarded as Codex prompts when a workspace is selected", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/help"));
    await router.handle(textMessage("/codex"));
    await router.handle(textMessage("/status"));
    await router.handle(textMessage("/start"));
    await router.handle(textMessage("/model"));

    expect(agent.sent.map((message) => message.text)).toEqual([
      "/help",
      "/codex",
      "/status",
      "/start",
      "/model",
    ]);
    expect(agent.builtins).toEqual([]);
    expect(adapter.sent).toEqual([]);
    expect(adapter.reactions.map((reaction) => reaction.emoji)).toEqual(["✍", "🫡", "✍", "🫡", "✍", "🫡", "✍", "🫡", "✍"]);
  });

  test("/review and /compact run Codex built-ins", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/review branch main"));
    await router.handle(textMessage("/compact"));

    expect(agent.sent).toEqual([]);
    expect(agent.builtins).toEqual([
      { key: "codex:1:demo", command: { type: "review", target: { type: "baseBranch", branch: "main" } } },
      { key: "codex:1:demo", command: { type: "compact" } },
    ]);
    expect(adapter.sent.map((message) => message.text)).toEqual(["Review started.", "Compaction started."]);
  });

  test("/goal shows, sets, updates, and clears thread goals", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/goal"));
    await router.handle(textMessage("/goal ship feature"));
    await router.handle(textMessage("/goal pause"));
    await router.handle(textMessage("/goal resume"));
    await router.handle(textMessage("/goal clear"));

    expect(agent.goalGets).toEqual(["codex:1:demo", "codex:1:demo"]);
    expect(agent.goalSets).toEqual([
      { key: "codex:1:demo", goal: { objective: "ship feature", status: "active", tokenBudget: null } },
      { key: "codex:1:demo", goal: { status: "paused" } },
      { key: "codex:1:demo", goal: { status: "active" } },
    ]);
    expect(agent.goalClears).toEqual(["codex:1:demo"]);
    expect(adapter.sent[0]?.text).toContain("No goal is currently set.");
    expect(adapter.sent.at(-1)?.text).toBe("Goal cleared.");
  });

  test("/goal confirms before replacing an existing goal", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.goal = {
      threadId: "thread-1",
      objective: "Existing goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    await router.handle(textMessage("/goal replacement goal"));
    const button = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().find((item) => item.text === "Replace");
    expect(adapter.sent.at(-1)?.text).toContain("Replace goal?");
    expect(button?.callback_data).toMatch(/^ar:cmd:goal:/);
    expect(agent.goalSets).toEqual([]);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb-goal", adapter.sent.at(-1)?.messageId));

    expect(agent.goalSets).toEqual([
      { key: "codex:1:demo", goal: { objective: "replacement goal", status: "active", tokenBudget: null } },
    ]);
    expect(adapter.edited.at(-1)?.text).toContain("Goal updated.");
  });

  test("/goal can run while a Codex turn is active", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: 1, workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-active";

    await router.handle(textMessage("/goal pause"));

    expect(agent.goalSets).toEqual([{ key: "codex:1:demo", goal: { status: "paused" } }]);
    expect(adapter.sent.at(-1)?.text).not.toContain("Codex is busy.");
  });

  test("/init starts the AGENTS.md generation prompt", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/init"));

    expect(agent.sent).toEqual([sentPrompt("Generate a file named AGENTS.md that serves as a contributor guide for this repository.")]);
  });

  test("/init does not steer while a turn is active", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("run task"));
    const sentCount = agent.sent.length;
    await router.handle(textMessage("/init"));

    expect(agent.sent).toHaveLength(sentCount);
    expect(adapter.sent.at(-1)?.text).toContain("Codex is busy.");
  });

  test("/clear starts a fresh thread while keeping the workspace selected", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.markSessionStarted("codex:1:demo", 1, "demo", 1, "old-thread");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "old-thread" });

    await router.handle(textMessage("/clear"));

    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("thread-1");
    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Started a new chat.");
  });

  test("clear callback is no longer supported", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.markSessionStarted("codex:1:demo", 1, "demo", 1, "old-thread");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "old-thread" });

    await router.handle(callbackMessage("ar:clear?"));

    expect(agent.stopped).toEqual([]);
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("old-thread");
    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
  });

  test("auto-resume falls back to a fresh thread when the saved Codex thread is missing", async () => {
    const { router, store, agent, root, logLines } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.markSessionStarted("codex:1:demo", 1, "demo", 1, "missing-thread");
    store.markSessionStopped("codex:1:demo", 2);
    agent.failStartForThreadIds.set("missing-thread", new Error("Codex thread/resume failed: no rollout found for thread id missing-thread"));

    await router.handle(textMessage("hello after restart"));

    expect(agent.getStatus("codex:1:demo")?.threadId).toBe("thread-1");
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("thread-1");
    expect(agent.sent).toEqual([sentPrompt("hello after restart")]);
    expect(logLines.join("\n")).toContain("router.session_auto_resume_failed_starting_fresh");
  });

  test("/resume renders a picker and switches to the selected thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "current-thread" });
    agent.threads = [{ id: "saved-thread", name: "Saved work", cwd: path, updatedAt: 1 }];

    await router.handle(textMessage("/resume saved"));
    const resumeButton = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat()[0];

    expect(agent.threadLists).toEqual([{ workspacePath: path, limit: 8, searchTerm: "saved" }]);
    expect(resumeButton?.callback_data).toMatch(/^ar:cmd:resume:/);

    await router.handle(callbackMessage(resumeButton!.callback_data, 7, "cb-resume", adapter.sent.at(-1)?.messageId));

    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(agent.getStatus("codex:1:demo")?.threadId).toBe("saved-thread");
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("saved-thread");
    expect(adapter.edited.at(-1)?.text).toContain("Resumed chat.");
  });

  test("/fork, /rename, and /stop call functional driver APIs", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/fork"));
    await router.handle(textMessage("/rename Ship it"));
    await router.handle(textMessage("/stop"));

    expect(agent.forks).toEqual(["codex:1:demo"]);
    expect(agent.renames).toEqual([{ key: "codex:1:demo", name: "Ship it" }]);
    expect(agent.cleaned).toEqual(["codex:1:demo"]);
    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(adapter.sent.map((message) => message.text)).toEqual(["Forked chat.\n\nThread: Forked", "Renamed chat.\n\nShip it", "Background terminals stopped."]);
  });

  test("/ps lists only Codex background terminals tracked by the driver", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.backgroundTerminals = [
      { commandDisplay: "npm run dev", recentChunks: ["ready", "listening"] },
    ];

    await router.handle(textMessage("/ps"));
    await router.handle(textMessage("/stop"));
    await router.handle(textMessage("/ps"));

    expect(adapter.sent.map((message) => message.text)).toEqual([
      "Background terminals\n\n- npm run dev\n  ready\n  listening",
      "Background terminals stopped.",
      "Background terminals\n\nNo background terminals running.",
    ]);
  });

  test("/plan toggles plan mode and implementing a plan returns to default mode", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));

    expect(agent.sent.at(-1)).toEqual(sentPrompt("design this", "plan"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;
    const planButton = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Implement");
    expect(planButton?.callback_data).toMatch(/^ar:cmd:plan:/);

    await router.handle(callbackMessage(planButton!.callback_data, 7, "cb-plan", adapter.sent.at(-1)?.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent.at(-1)).toEqual(sentPrompt("Implement the approved plan."));
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "😎" },
      { conversationId: "1", messageId: "100", emoji: "✍" },
    ]);

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-2" });

    expect(store.getTask(2)?.status).toBe("done");
    expect(adapter.reactions.at(-1)).toEqual({ conversationId: "1", messageId: "100", emoji: "😎" });
  });

  test("plan continue callback deletes the plan ready prompt without sending text", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    const planMessage = adapter.sent.at(-1)!;
    const continueButton = planMessage.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Continue");
    const sentCount = agent.sent.length;

    await router.handle(callbackMessage(continueButton!.callback_data, 7, "cb-plan-continue", planMessage.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent).toHaveLength(sentCount);
    expect(store.getPendingPrompt("1", planMessage.messageId!)).toBeUndefined();
    expect(adapter.deleted).toEqual([{ conversationId: "1", messageId: planMessage.messageId! }]);
    expect(adapter.edited.map((message) => message.text)).not.toContain("Continuing in Plan mode.");
    expect(adapter.edited.map((message) => message.text)).not.toContain("Plan ready.");
  });

  test("plan continue callback clears buttons without continuing text when delete fails", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.failDeleteMessage = new Error("delete failed");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    const planMessage = adapter.sent.at(-1)!;
    const continueButton = planMessage.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Continue");
    const sentCount = agent.sent.length;

    await router.handle(callbackMessage(continueButton!.callback_data, 7, "cb-plan-continue", planMessage.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent).toHaveLength(sentCount);
    expect(store.getPendingPrompt("1", planMessage.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toBe("");
    expect(adapter.edited.at(-1)?.options.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(adapter.edited.at(-1)?.text).not.toContain("Continuing in Plan mode.");
    expect(adapter.edited.at(-1)?.text).not.toContain("Plan ready.");
  });

  test("plan implement callback expires instead of steering into an active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    const planButton = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Implement");
    const sentCount = agent.sent.length;

    await router.handle(callbackMessage(planButton!.callback_data, 7, "cb-plan", adapter.sent.at(-1)?.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent).toHaveLength(sentCount);
    expect(adapter.edited.at(-1)?.text).toContain("Plan action expired.");
  });

  test("turn completion marks every active task for the turn done", async () => {
    const { router, store, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const first = store.createTask({ conversationId: 1, workspaceName: "demo", text: "first", status: "running" });
    const second = store.createTask({ conversationId: 1, workspaceName: "demo", text: "second", status: "running" });
    store.updateTask(first.id, { turnId: "turn-shared" });
    store.updateTask(second.id, { turnId: "turn-shared" });

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-shared" });

    expect(store.getTask(first.id)?.status).toBe("done");
    expect(store.getTask(second.id)?.status).toBe("done");
  });

  test("turn blocking and resume update every active task for the turn", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const first = store.createTask({ conversationId: 1, workspaceName: "demo", text: "first", status: "running", userMessageId: 11 });
    const second = store.createTask({ conversationId: 1, workspaceName: "demo", text: "second", status: "running", userMessageId: 12 });
    store.updateTask(first.id, { turnId: "turn-shared" });
    store.updateTask(second.id, { turnId: "turn-shared" });

    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "codex:1:demo",
      requestId: 91,
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "Approve command?",
      body: "Run tests",
      params: { command: "bun test" },
      turnId: "turn-shared",
    });

    expect(store.getTask(first.id)?.status).toBe("blocked");
    expect(store.getTask(second.id)?.status).toBe("blocked");

    const approve = adapter.sent.at(-1)!.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(approve.callback_data, 7, "cb-approval", adapter.sent.at(-1)!.messageId));

    expect(store.getTask(first.id)?.status).toBe("running");
    expect(store.getTask(second.id)?.status).toBe("running");
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "11", emoji: "🤔" },
      { conversationId: "1", messageId: "12", emoji: "🤔" },
      { conversationId: "1", messageId: "11", emoji: "✍" },
      { conversationId: "1", messageId: "12", emoji: "✍" },
    ]);
  });

  test("agent exit marks active tasks failed", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const running = store.createTask({ conversationId: 1, workspaceName: "demo", text: "running", status: "running", userMessageId: 11 });
    const waiting = store.createTask({ conversationId: 1, workspaceName: "demo", text: "waiting", status: "waiting", userMessageId: 12 });

    await router.handleAgentExit("codex:1:demo", "Agent exited.");

    expect(store.getTask(running.id)?.status).toBe("failed");
    expect(store.getTask(waiting.id)?.status).toBe("failed");
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "11", emoji: "😱" },
      { conversationId: "1", messageId: "12", emoji: "😱" },
    ]);
  });

  test("/clear cancels active tasks before starting a fresh thread", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("run task"));
    const task = store.getTask(1)!;
    await router.handle(textMessage("/clear"));

    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
  });

  test("resume callback is no longer supported", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "current-thread" });
    agent.threads = [{ id: "saved-thread", name: "Saved work", cwd: path, updatedAt: 1 }];

    await router.handle(callbackMessage("ar:rl:0"));

    expect(agent.threadLists).toEqual([]);
    expect(agent.stopped).toEqual([]);
    expect(agent.getStatus("codex:1:demo")?.threadId).toBe("current-thread");
    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
  });

  test("status toggle renders details and persists by chat", async () => {
    const { router, store, adapter } = fixture();
    store.upsertWorkspace({ name: "demo", path: "/tmp/<demo>&", createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/relay"));
    await router.handle(callbackMessage("ar:status", 7, "cb-details", adapter.sent.at(-1)?.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("/tmp/<demo>&");
    expect(adapter.edited.at(-1)?.options.entities?.some((entity) => entity.type === "code")).toBe(true);
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Workspaces", "Compact", "Refresh", "Stop"]);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-details", text: undefined });

    await router.handle(textMessage("/relay"));
    expect(adapter.edited.at(-1)?.text).toContain("/tmp/<demo>&");
  });

  test("input without a workspace opens Relay Home", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("hello"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("workspace: none");
  });

  test("/relay without a workspace opens Relay Home instead of forwarding", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("/relay"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("workspace: none");
  });

  test("new workspace callback uses ForceReply and reply creates binding", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(callbackMessage("ar:n"));
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    expect(adapter.sent.at(-1)?.options?.inputFieldPlaceholder).toBe("repo name under WORKSPACE_ROOT");
    const promptId = adapter.sent.length + 99;

    await router.handle(textMessage("demo", 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
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
    expect(agent.getStatus(sessionKey(1, workspaceName))?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("selected");
    expect(adapter.sent.at(-1)?.text).not.toContain("created and selected");
    expect(existsSync(join(root, workspaceName, ".git"))).toBe(false);
  });

  test("prompt callback is no longer supported", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(callbackMessage("ar:i"));

    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
    expect(agent.sent).toEqual([]);
  });

  test("prompt callback stays unsupported during an active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(callbackMessage("ar:i"));

    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
    expect(agent.sent).toEqual([]);
  });

  test("ordinary text adds to the active turn while Codex is busy", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("new task while busy"));

    expect(agent.sent.at(-1)).toEqual(sentPrompt("new task while busy"));
    expect(adapter.sent).toEqual([]);
    expect(store.getTask(1)?.status).toBe("running");
    expect(store.getTask(1)?.turnId).toBe("turn-1");
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
    expect(store.listTasks(1, "demo", ["waiting"])).toHaveLength(0);
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "🫡" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });

  test("/add is forwarded literally and steers the active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("/add include tests"));

    expect(agent.sent.at(-1)).toEqual(sentPrompt("/add include tests"));
    expect(store.getTask(1)?.status).toBe("running");
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "🫡" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });

  test("busy prompt failure updates the waiting message reaction", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";
    agent.failSend = new Error("steer exploded");

    await router.handle(textMessage("new task while busy"));

    expect(store.getTask(1)?.status).toBe("failed");
    expect(adapter.sent.at(-1)?.text).toContain("Error:");
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "🫡" },
      { conversationId: "1", messageId: "1", emoji: "😱" },
    ]);
  });

  test("queued prompt updates the user message reaction", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await (router as any).submitTask(1, "queued work", 88, "queue");

    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(1);
    expect(adapter.sent).toEqual([]);
    expect(adapter.reactions).toEqual([{ conversationId: "1", messageId: "88", emoji: "🫡" }]);
  });

  test("prompt without a user message id does not send a status card or reaction", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await (router as any).submitTask(1, "run without id", undefined, "immediate");

    expect(agent.sent).toEqual([sentPrompt("run without id")]);
    expect(adapter.sent).toEqual([]);
    expect(adapter.reactions).toEqual([]);
  });

  test("reaction failures do not fall back to a status card", async () => {
    const { router, store, adapter, agent, root, logLines } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.failReaction = new Error("reaction unavailable");

    await router.handle(textMessage("run task"));

    expect(agent.sent).toEqual([sentPrompt("run task")]);
    expect(adapter.sent).toEqual([]);
    expect(adapter.reactions).toEqual([]);
    expect(logLines.join("\n")).toContain("router.task_reaction_failed");
  });

  test("completed prompt updates the user message reaction", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("run task"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(adapter.sent).toEqual([]);
    expect(adapter.edited).toEqual([]);
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "😎" },
    ]);
  });

  test("failed prompt updates the user message reaction", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.failSend = new Error("send exploded");

    await router.handle(textMessage("run task"));

    expect(store.getTask(1)?.status).toBe("failed");
    expect(adapter.sent.at(-1)?.text).toContain("Error:");
    expect(adapter.edited).toEqual([]);
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "😱" },
    ]);
  });

  test("photo prompt is saved under relay media and sent to agent", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.downloads.set("photo-large", new Uint8Array([1, 2, 3]).buffer);

    await router.handle(mediaMessage("inspect this"));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.key).toBe("codex:1:demo");
    expect(agent.sent[0]?.text).toBe("inspect this");
    const imagePath = agent.sent[0]?.options?.images?.[0]?.path;
    expect(imagePath).toContain(join(path, ".agent-relay", "media", "incoming"));
    expect(existsSync(imagePath!)).toBe(true);
    expect(readFileSync(join(path, ".agent-relay", ".gitignore"), "utf8")).toBe("*\n");
    expect(agent.sent[0]?.options?.images?.[0]?.caption).toBe("inspect this");
  });

  test("photo prompt without caption uses default image prompt", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(mediaMessage());

    expect(agent.sent[0]?.text).toBe("Please inspect the attached image(s).");
    expect(agent.sent[0]?.options?.images).toHaveLength(1);
  });

  test("codex image output is sent as photo and copied to outgoing media", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("make image"));
    const generated = join(path, "generated.png");
    writeFileSync(generated, new Uint8Array([1, 2, 3]));

    await router.handleAgentOutput({ type: "image", sessionKey: "codex:1:demo", path: generated, caption: "result" });

    expect(adapter.photos).toHaveLength(1);
    const outgoingDayDirs = readdirSync(join(path, ".agent-relay", "media", "outgoing"));
    expect(outgoingDayDirs).toHaveLength(1);
    expect(readFileSync(join(path, ".agent-relay", ".gitignore"), "utf8")).toBe("*\n");
  });

  test("send_image capability sends workspace screenshot", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("debug h5"));
    const screenshot = join(path, "screen.png");
    writeFileSync(screenshot, new Uint8Array([1, 2, 3]));

    const result = await router.sendDebugImage({ path: screenshot, cwd: path, caption: "home screen" });

    expect(result.path).toContain(join(path, ".agent-relay", "media", "outgoing"));
    expect(adapter.photos).toHaveLength(1);
    expect(adapter.photos[0]?.options).toEqual({ caption: "home screen", replyToMessageId: "1" });
  });

  test("send_image capability rejects paths outside workspace", async () => {
    const { router, store, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("debug h5"));
    const screenshot = join(root, "outside.png");
    writeFileSync(screenshot, new Uint8Array([1, 2, 3]));

    await expect(router.sendDebugImage({ path: screenshot, cwd: path })).rejects.toThrow("inside the selected workspace");
  });

  test("send_image capability rejects oversized images", async () => {
    const { router, store, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("debug h5"));
    const screenshot = join(path, "screen.png");
    writeFileSync(screenshot, new Uint8Array(20 * 1024 * 1024 + 1));

    await expect(router.sendDebugImage({ path: screenshot, cwd: path })).rejects.toThrow("Image is too large");
  });

  test("send_image capability asks for session key when cwd matches multiple sessions", async () => {
    const { router, store, agent, root } = fixture();
    const first = join(root, "demo");
    const second = join(first, "nested");
    mkdirSync(second, { recursive: true });
    store.upsertWorkspace({ name: "demo", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "nested", path: second, createdAt: 1 });
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: first });
    await agent.start({ conversationId: 2, workspaceName: "nested", workspacePath: second });
    store.markSessionStarted("codex:1:demo", 1, "demo", 1, "thread-1");
    store.markSessionStarted("codex:2:nested", 2, "nested", 1, "thread-2");
    const screenshot = join(second, "screen.png");
    writeFileSync(screenshot, new Uint8Array([1, 2, 3]));

    await expect(router.sendDebugImage({ path: screenshot, cwd: second })).rejects.toThrow("pass --session-key");
  });

  test("backlog callback is no longer supported", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.createTask({ conversationId: "1", workspaceName: "demo", text: "queued work", status: "queued" });

    await router.handle(callbackMessage("ar:queue"));

    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
  });

  test("/relay sends a fresh Relay Home message every time", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    const firstMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(textMessage("/relay"));
    const secondMessageId = adapter.sent.at(-1)?.messageId;

    expect(secondMessageId).not.toBe(firstMessageId);
    expect(store.getConsoleMessageId(1)).toBe(String(secondMessageId));
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.edited).toHaveLength(0);
  });

  test("Relay Home refresh callback edits the current home message", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    await router.handle(textMessage("/relay"));
    const currentMessageId = adapter.sent.at(-1)?.messageId;

    await router.handle(callbackMessage("ar:s", 7, "cb-refresh", currentMessageId));

    expect(store.getConsoleMessageId(1)).toBe(String(currentMessageId));
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.edited.at(-1)?.options.messageId).toBe(currentMessageId);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-refresh", text: undefined });
  });

  test("workspace callback switches binding, auto-starts, and edits status", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    store.upsertWorkspace({ name: "first", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "second", path: second, createdAt: 1 });
    store.bindConversation(1, "first");
    store.markSessionStarted("codex:1:second", 1, "second", 1, "old-second-thread");

    await router.handle(callbackMessage("ar:w"));
    expect(adapter.edited.at(-1)?.text).toContain("✅ first");
    expect(adapter.edited.at(-1)?.text).toContain("⬜ second");
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "second")?.at(1);
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2", adapter.edited.at(-1)?.options.messageId));

    expect(store.getBinding(1)?.workspaceName).toBe("second");
    expect(agent.getStatus("codex:1:second")?.running).toBe(true);
    expect(agent.getStatus("codex:1:second")?.threadId).toBe("thread-1");
    expect(store.getSession("codex:1:second")?.thread_id).toBe("thread-1");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: second");
    expect(adapter.edited.at(-1)?.options.entities?.some((entity) => entity.type === "code")).toBe(true);
    expect(adapter.edited.at(-1)?.options.messageId).toBe(42);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb2", text: undefined });
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
    expect(adapter.edited.at(-1)?.text).toContain("⬜ demo");
    expect(adapter.edited.at(-1)?.text).toContain(`⬜ ${longName}`);
    expect(store.getWorkspace(longName)?.path).toBe(longPath);
    const demoRow = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "demo");
    expect(demoRow?.map((button) => button.text)).toEqual(["demo", "Select", "Delete"]);
    expect(demoRow?.at(0)?.callback_data.startsWith("ar:wi:0:")).toBe(true);
    expect(demoRow?.at(1)?.callback_data.startsWith("ar:uh:")).toBe(true);
    expect(demoRow?.at(2)?.callback_data.startsWith("ar:wd?:")).toBe(true);
    const callbackData = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    const createButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:n");
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");
    const refreshButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:w");
    const footer = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.at(-1)?.map((button) => button.text);
    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(backButton?.text).toBe("Back");
    expect(createButton?.text).toBe("New");
    expect(refreshButton?.text).toBe("Refresh");
    expect(footer).toEqual(["Back", "New", "Refresh"]);
    expect(callbackData?.filter((data) => data.startsWith("ar:uh:"))).toHaveLength(2);
    expect(callbackData?.filter((data) => data.startsWith("ar:wi:0:"))).toHaveLength(2);
    expect(callbackData?.every((data) => new TextEncoder().encode(data).length <= 64)).toBe(true);
  });

  test("workspace name button opens README intro and returns to workspace list", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    writeFileSync(join(path, "README.md"), "# Demo\n\nProject summary from README.\n\nMore details.");
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));
    const introButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wi:0:"));
    expect(introButton?.text).toBe("demo");

    await router.handle(callbackMessage(introButton!.callback_data, 7, "cb-intro", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Workspace");
    expect(adapter.edited.at(-1)?.text).toContain("demo");
    expect(adapter.edited.at(-1)?.text).toContain(path);
    expect(adapter.edited.at(-1)?.text).toContain("Project summary from README.");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Back", "Select", "Delete"]);

    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:wl:0");
    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-intro-back", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "demo")?.map((button) => button.text)).toEqual(["demo", "Select", "Delete"]);
  });

  test("workspace intro shows fallback when README is missing", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));
    const introButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wi:0:"));

    await router.handle(callbackMessage(introButton!.callback_data, 7, "cb-intro", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("No README found.");
  });

  test("workspace management back returns to Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;

    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces", homeMessageId));
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");
    expect(backButton?.text).toBe("Back");

    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-back", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Relay Home");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: none");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Workspaces", "Details", "Refresh"]);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-back", text: undefined });
  });

  test("workspace delete requires confirmation and removes directory and binding", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:w"));
    const deleteButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd?:"));
    expect(deleteButton?.text).toBe("Delete");

    await router.handle(callbackMessage(deleteButton!.callback_data, 7, "cb-delete?", adapter.edited.at(-1)?.options.messageId));
    expect(existsSync(path)).toBe(true);
    expect(adapter.edited.at(-1)?.text).toContain("Delete workspace?");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Delete", "Back"]);

    const confirmButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd!:"));
    await router.handle(callbackMessage(confirmButton!.callback_data, 7, "cb-delete!", adapter.edited.at(-1)?.options.messageId));

    expect(existsSync(path)).toBe(false);
    expect(store.getWorkspace("demo")).toBeUndefined();
    expect(store.getBinding(1)).toBeUndefined();
    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(adapter.edited.at(-1)?.text).toContain("No workspace directories found.");
  });

  test("workspace delete confirmation back returns to Relay Home", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces", homeMessageId));
    const deleteButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd?:"));
    await router.handle(callbackMessage(deleteButton!.callback_data, 7, "cb-delete?", adapter.edited.at(-1)?.options.messageId));
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");

    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-back", adapter.edited.at(-1)?.options.messageId));

    expect(existsSync(path)).toBe(true);
    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(adapter.edited.at(-1)?.text).toContain("Relay Home");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: demo");
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-back", text: undefined });
  });

  test("/cd without a workspace opens Relay Home instead of creating a workspace directly", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(textMessage("/cd demo"));

    expect(store.getBinding(1)).toBeUndefined();
    expect(agent.getStatus("codex:1:demo")).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).toContain("workspace: none");
    expect(existsSync(join(root, "demo"))).toBe(false);
  });

  test("hashed workspace callback selects long unicode names", async () => {
    const { router, store, adapter, root } = fixture();
    const workspaceName = `客户 repo ${"a".repeat(60)}`;
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:w"));
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text.startsWith("客户 repo"))?.at(1);
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2"));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(adapter.edited.at(-1)?.text).toContain("客户 repo");
  });

  test("stop callback stops current workspace and clears selection", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:stop"));

    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(store.getBinding(1)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("workspace: none");
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb1", text: undefined });
  });

  test("unknown callback answers and renders formatted error", async () => {
    const { router, adapter } = fixture();
    await router.handle(callbackMessage("ar:nope"));

    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unknown callback." }]);
    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
    expect(adapter.edited.at(-1)?.options.entities?.[0]?.type).toBe("bold");
  });

  test("callback error notices are best effort when Telegram send fails", async () => {
    const { router, adapter, logLines } = fixture();
    adapter.failEditMessage = new Error("edit failed");
    adapter.failSendMessage = new Error("unknown certificate verification error");

    await expect(router.handle(callbackMessage("ar:nope"))).resolves.toBeUndefined();

    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unknown callback." }]);
    expect(logLines.join("\n")).toContain("router.callback_failed");
    expect(logLines.join("\n")).toContain("router.callback_error_notice_failed");
  });

  test("codex option question uses inline buttons and responds with selected answer", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("ask mode"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
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
    expect(prompt.options?.forceReply).toBeUndefined();
    expect(prompt.options?.replyMarkup?.inline_keyboard.map((row) => row[0]?.text)).toEqual(["Fast", "Deep"]);
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast", prompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 77,
      result: { answers: { choice: { answers: ["Fast"] } } },
    }]);
    expect(adapter.edited.at(-1)?.text).toContain("Answered");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "🤔" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });

  test("plan option question confirms selected answer before responding", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 78,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }, { label: "Deep", description: "More detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast", prompt.messageId));

    expect(agent.responses).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Selected:");
    const submit = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Submit")!;
    await router.handle(callbackMessage(submit.callback_data, 7, "cb-submit", prompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 78,
      result: { answers: { choice: { answers: ["Fast"] } } },
    }]);
  });

  test("plan option question can add a note to the selected answer", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 79,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast", prompt.messageId));
    const note = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Add note")!;
    await router.handle(callbackMessage(note.callback_data, 7, "cb-note", prompt.messageId));

    expect(adapter.edited.at(-1)?.text).toBe("Selected: Fast");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
    const notePrompt = adapter.sent.at(-1)!;
    expect(notePrompt.options?.forceReply).toBe(true);
    expect(notePrompt.options?.replyToMessageId).toBe(String(prompt.messageId));
    expect(notePrompt.text).toBe("Add note\n\nReply with the extra details to include.");
    expect(notePrompt.text).not.toContain("Selected:");
    await router.handle(textMessage("Prefer minimal changes", 7, notePrompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 79,
      result: { answers: { choice: { answers: ["Fast", "Prefer minimal changes"] } } },
    }]);
    expect(agent.sent).toEqual([]);
  });

  test("plan option question can change the selected answer", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 80,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }, { label: "Deep", description: "More detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    await router.handle(callbackMessage(prompt.options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 7, "cb-fast", prompt.messageId));
    const change = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Change")!;
    await router.handle(callbackMessage(change.callback_data, 7, "cb-change", prompt.messageId));

    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.map((row) => row[0]?.text)).toEqual(["Fast", "Deep"]);
    const deep = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard[1]![0]!;
    await router.handle(callbackMessage(deep.callback_data, 7, "cb-deep", prompt.messageId));
    const submit = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Submit")!;
    await router.handle(callbackMessage(submit.callback_data, 7, "cb-submit", prompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 80,
      result: { answers: { choice: { answers: ["Deep"] } } },
    }]);
  });

  test("plan option question supports Other as a free text answer", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 81,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        isOther: true,
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    expect(prompt.options?.replyMarkup?.inline_keyboard.map((row) => row[0]?.text)).toEqual(["Fast", "Other"]);
    const other = prompt.options!.replyMarkup!.inline_keyboard[1]![0]!;
    await router.handle(callbackMessage(other.callback_data, 7, "cb-other", prompt.messageId));

    const otherPrompt = adapter.sent.at(-1)!;
    expect(otherPrompt.options?.forceReply).toBe(true);
    await router.handle(textMessage("Use a hybrid approach", 7, otherPrompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 81,
      result: { answers: { choice: { answers: ["Use a hybrid approach"] } } },
    }]);
    expect(agent.sent).toEqual([]);
  });

  test("stale codex user input callback expires without responding", async () => {
    const { router, adapter } = fixture();

    await router.handle(callbackMessage("ar:q:old:0:0"));

    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
  });

  test("codex free text question uses ForceReply and reply is not forwarded as prompt", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: "req1",
      questions: [{ id: "notes", header: "Notes", question: "What should I use?" }],
    });
    const promptId = adapter.sent.at(-1)?.messageId;
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);

    await router.handle(textMessage("Use SQLite", 7, promptId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
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
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
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
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
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
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 88,
      questions: [
        { id: "first", header: "First", question: "A?", options: [{ label: "A", description: "" }] },
        { id: "second", header: "Second", question: "B?", options: [{ label: "B", description: "" }] },
      ],
    });
    const first = adapter.sent.at(-1)!;

    expect(first.options?.replyMarkup?.inline_keyboard[0]?.[0]?.text).toBe("A");
    await router.handle(callbackMessage(first.options!.replyMarkup!.inline_keyboard[0]![0]!.callback_data, 7, "cb-first", first.messageId));
    expect(agent.responses).toEqual([]);
    const second = adapter.sent.at(-1)!;
    expect(second.text).toContain("Second");
    expect(adapter.edited.at(-1)?.text).toContain("Answered:");
    expect(adapter.edited.at(-1)?.text).not.toContain("Next question sent.");

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
    store.bindConversation(1, "demo");
    store.setPendingPrompt({
      conversationId: "1",
      promptMessageId: 501,
      kind: "codex_user_input",
      createdAt: 1,
      sessionKey: "codex:1:demo",
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
    store.bindConversation(1, "demo");
    await router.handle(textMessage("run tests"));

    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "codex:1:demo",
      requestId: 91,
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "Approve command?",
      body: "Run tests\ncwd: /tmp/demo\nbun test",
      params: { command: "bun test" },
    });
    const prompt = adapter.sent.at(-1)!;
    expect(prompt.text).toContain("workspace: /tmp/demo");
    expect(prompt.text).not.toContain("cwd: /tmp/demo");
    const approve = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));

    expect(agent.responses).toEqual([{ key: "codex:1:demo", requestId: 91, result: { decision: "accept" } }]);
    expect(adapter.edited.at(-1)?.text).toContain("Approved");
    expect(adapter.edited.at(-1)?.text).toContain("Approve command?");
    expect(adapter.edited.at(-1)?.text).toContain("Run tests");
    expect(adapter.edited.at(-1)?.text).toContain("/tmp/demo");
    expect(adapter.edited.at(-1)?.text).toContain("bun test");
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "🤔" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });
});

function textMessage(text: string, userId = 7, replyToMessageId?: number) {
  return { kind: "message" as const, id: "1", messageId: "1", conversationId: "1", userId, text, replyToMessageId };
}

function mediaMessage(caption?: string, userId = 7) {
  return {
    kind: "media" as const,
    id: "1",
    messageId: "1",
    conversationId: "1",
    userId,
    ...(caption ? { caption } : {}),
    photos: [
      { fileId: "photo-small", width: 10, height: 10, fileSize: 10 },
      { fileId: "photo-large", fileUniqueId: "unique-large", width: 100, height: 100, fileSize: 100 },
    ],
  };
}

function callbackMessage(data: string, userId = 7, callbackQueryId = "cb1", messageId: MessageId = 42) {
  return {
    kind: "callback_query" as const,
    id: callbackQueryId,
    conversationId: "1",
    userId,
    callbackQueryId,
    messageId,
    data,
  };
}
