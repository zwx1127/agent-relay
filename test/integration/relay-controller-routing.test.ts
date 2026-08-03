import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import { chatScopeKey } from "../../src/domain/scope.ts";
import { callbackMessage, cleanupRelayFixtures, mediaMessage, relayFixture as fixture, sentPrompt, textMessage, waitForStreamFlush } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

describe("relay controller routing and output", () => {
  test("rejects unauthorized users", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/help", 99));
    expect(adapter.sent.at(-1)?.text).toBe("Unauthorized.");
  });

  test("ignores unmentioned group text before authorization", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle({ ...textMessage("/relay", 99), conversationType: "group", mentionedBot: false });

    expect(adapter.sent).toEqual([]);
    expect(agent.sent).toEqual([]);
  });

  test("handles mentioned group text and strips provider mention before routing", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle({ ...textMessage("hello codex"), conversationType: "group", mentionedBot: true });

    expect(agent.sent).toEqual([sentPrompt("hello codex")]);
  });

  test("ignores unmentioned group media", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle({ ...mediaMessage("inspect"), conversationType: "group", mentionedBot: false });

    expect(adapter.sent).toEqual([]);
    expect(agent.sent).toEqual([]);
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

  test("routes two topics in the same conversation to independent workspaces", async () => {
    const { router, store, agent, adapter, root } = fixture();
    const pathA = join(root, "alpha");
    const pathB = join(root, "beta");
    mkdirSync(pathA);
    mkdirSync(pathB);
    store.upsertWorkspace({ name: "alpha", path: pathA, createdAt: 1 });
    store.upsertWorkspace({ name: "beta", path: pathB, createdAt: 1 });
    const topicA = { provider: "telegram" as const, id: "10" };
    const topicB = { provider: "telegram" as const, id: "20" };
    const scopeA = chatScopeKey("1", topicA);
    const scopeB = chatScopeKey("1", topicB);
    store.bindConversation(scopeA, "alpha", 1, "1");
    store.bindConversation(scopeB, "beta", 1, "1");

    await router.handle({ ...textMessage("work on alpha", 7, undefined, "1"), topic: topicA });
    await router.handle({ ...textMessage("work on beta", 7, undefined, "1"), topic: topicB });
    await router.handleAgentOutput({ sessionKey: sessionKey(scopeA, "alpha"), chunk: "alpha done", turnId: "turn-a" });
    await waitForStreamFlush();

    expect(agent.sent.map((item) => ({ key: item.key, text: item.text }))).toEqual([
      { key: sessionKey(scopeA, "alpha"), text: "work on alpha" },
      { key: sessionKey(scopeB, "beta"), text: "work on beta" },
    ]);
    expect(adapter.sent.at(-1)?.conversationId).toBe("1");
    expect(adapter.sent.at(-1)?.options?.topic).toEqual(topicA);
  });

  test("uses control message mapping to route thread callbacks without provider topic metadata", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    const topic = { provider: "lark" as const, id: "thread-1", rootMessageId: "root-1" };
    const scope = chatScopeKey("1", topic);
    store.bindConversation(scope, "demo", 1, "1");

    await router.handle({ ...textMessage("/relay", 7, undefined, "1"), topic });
    const home = adapter.sent.at(-1)!;
    await router.handle(callbackMessage("ar:status", 7, "cb-thread", home.messageId, "1"));

    expect(adapter.sent.at(-1)?.options?.topic).toEqual(topic);
    expect(adapter.edited.at(-1)?.conversationId).toBe("1");
    expect(store.getHomeStatusMode(scope)).toBe("details");
  });

  test("uses control message mapping before provider topic metadata for callbacks", async () => {
    const { router, store, adapter, root } = fixture();
    const pathA = join(root, "alpha");
    const pathB = join(root, "beta");
    mkdirSync(pathA);
    mkdirSync(pathB);
    store.upsertWorkspace({ name: "alpha", path: pathA, createdAt: 1 });
    store.upsertWorkspace({ name: "beta", path: pathB, createdAt: 1 });
    const topicA = { provider: "lark" as const, id: "thread-a", rootMessageId: "root-a" };
    const topicB = { provider: "lark" as const, id: "thread-b", rootMessageId: "root-b" };
    const scopeA = chatScopeKey("1", topicA);
    const scopeB = chatScopeKey("1", topicB);
    store.bindConversation(scopeA, "alpha", 1, "1");
    store.bindConversation(scopeB, "beta", 1, "1");

    await router.handle({ ...textMessage("/relay", 7, undefined, "1"), topic: topicA });
    const home = adapter.sent.at(-1)!;
    await router.handle({ ...callbackMessage("ar:status", 7, "cb-thread", home.messageId, "1"), topic: topicB });

    expect(adapter.sent.at(-1)?.options?.topic).toEqual(topicA);
    expect(store.getHomeStatusMode(scopeA)).toBe("details");
    expect(store.getHomeStatusMode(scopeB)).toBe("compact");
  });

  test("agent capability can mention a configured peer agent in the active chat", async () => {
    const { router, store, adapter, agent, root } = fixture("info", {
      relayPeerAgents: [{ id: "designer", name: "Designer", telegramUsername: "designer_bot" }],
    });
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    store.markSessionStarted("codex:1:demo", "1", "demo", 1, "thread-1");

    await expect(router.mentionPeerAgent({ peerId: "designer", message: "Please review the UI.", cwd: path }))
      .resolves.toEqual({ peerId: "designer" });

    expect(adapter.sent.at(-1)).toMatchObject({
      conversationId: "1",
      text: "Please review the UI.",
      options: { mentions: [{ label: "Designer", telegramUsername: "designer_bot" }] },
    });
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

  test("unknown slash text sends an unknown-command notice", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/unknown"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toBe("Unknown command: /unknown. Send /help to see supported commands.");
    expect(adapter.reactions).toEqual([]);
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
    await waitForStreamFlush();

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
    await waitForStreamFlush();

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
    await waitForStreamFlush();
    await router.handle(textMessage("follow up"));
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "after", turnId: "turn-1" });
    await waitForStreamFlush();

    expect(adapter.sent.map((message) => message.text)).toEqual(["before", "after"]);
    expect(adapter.edited).toEqual([]);
    expect(adapter.reactions).toEqual([{ conversationId: "1", messageId: "1", emoji: "✍" }]);
    expect(agent.sent.at(-1)).toEqual(sentPrompt("follow up"));
  });

  test("long agent output is paged in one telegram message", async () => {
    const { router, adapter } = fixture();
    const longText = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");

    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: longText, turnId: "turn-1" });
    await waitForStreamFlush();

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
    await waitForStreamFlush();
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
    expect(prompt.options!.replyMarkup!.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "Approve once",
      "Approve session",
      "Deny",
      "Cancel",
    ]);

    await router.handle(callbackMessage(approve.callback_data, 7, "cba", prompt.messageId));
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: "after approval", turnId: "turn-1" });
    await waitForStreamFlush();

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
    await waitForStreamFlush();
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
    await waitForStreamFlush();
    await router.handleAgentOutput({ sessionKey: "codex:1:demo", chunk: " second", turnId: "turn-1" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(adapter.sent.map((message) => message.text)).toEqual(["first"]);
    expect(adapter.edited.map((message) => message.text)).toEqual(["first second"]);
  });

});
