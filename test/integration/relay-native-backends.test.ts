import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callbackMessage, cleanupRelayFixtures, relayFixture, textMessage, waitForStreamFlush } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

function nativeFixture(provider: "claude" | "dsh" = "claude") {
  const fixture = relayFixture("info", { agentProvider: provider });
  const { store, root, agent } = fixture;
  const path = join(root, "demo");
  mkdirSync(path);
  store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
  store.bindConversation(1, "demo");
  agent.displayName = provider === "claude" ? "Claude Code" : "DeepSeek Harness";
  const commands: string[] = [];
  Object.assign(agent, {
    listNativeCommands: async () => [{ command: "/plan", description: "Native plan mode" }],
    runNativeCommand: async (_key: string, text: string) => { commands.push(text); return { message: "Native command accepted." }; },
  });
  return { ...fixture, commands };
}

describe("backend-native Relay integration", () => {
  test("native slash commands cannot accidentally execute Codex semantics", async () => {
    const { router, commands, agent, store } = nativeFixture();
    await router.handle(textMessage("/plan native arguments"));
    expect(commands).toEqual(["/plan native arguments"]);
    expect(agent.sent).toEqual([]);
    expect(store.getCollaborationMode("claude:1:demo")).toBe("default");
    await router.handle(textMessage("/stop@relay_bot"));
    expect(commands).toEqual(["/plan native arguments", "/stop"]);
    expect(agent.cleaned).toEqual([]);
    await router.handle(textMessage("/custom@relay_bot  exact input\n\n"));
    expect(commands.at(-1)).toBe("/custom  exact input\n\n");
  });

  test("provider switching isolates saved native thread identities and instructions", async () => {
    const { router, store, agent } = nativeFixture();
    store.markSessionStarted("codex:1:demo", 1, "demo", 1, "codex-thread");
    store.setCollaborationMode("codex:1:demo", "plan");
    await router.handle(textMessage("hello Claude"));
    expect(agent.sent).toEqual([{ key: "claude:1:demo", text: "hello Claude" }]);
    expect(agent.getStatus("claude:1:demo")?.threadId).not.toBe("codex-thread");
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("codex-thread");
    expect(store.getSession("claude:1:demo")?.thread_id).toBeDefined();
  });

  test("help discovers native commands and /relay remains the existing Home entry", async () => {
    const { router, adapter, agent, commands } = nativeFixture("dsh");
    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).toContain("DeepSeek Harness commands");
    expect(adapter.sent.at(-1)?.text).not.toContain("AGENTS.md");
    expect(adapter.sent.at(-1)?.text).not.toMatch(/\/relay (help|new|resume|interrupt)/);
    const threadId = agent.getStatus("dsh:1:demo")?.threadId;
    for (const suffix of ["", " help", " new", " resume", " interrupt"]) {
      await router.handle(textMessage(`/relay${suffix}`));
      expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    }
    expect(agent.getStatus("dsh:1:demo")?.threadId).toBe(threadId);
    expect(agent.stopped).toEqual([]);
    expect(agent.interrupted).toEqual([]);
    expect(agent.threadLists).toEqual([]);
    expect(agent.sent).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("DSH /new and /resume use session APIs without invented registry commands", async () => {
    const { router, adapter, agent, store, commands } = nativeFixture("dsh");
    agent.threads = [{ id: "saved-session", name: "Saved session", cwd: "/unused" }];
    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).toContain("/new");
    expect(adapter.sent.at(-1)?.text).toContain("/resume [search]");
    expect(adapter.sent.at(-1)?.text).toContain("Relay shortcut to the native session API");
    await router.handle(textMessage("/resume@relay_bot Saved"));
    expect(agent.threadLists.at(-1)?.searchTerm).toBe("Saved");
    const picker = adapter.sent.at(-1)!;
    const data = JSON.parse(store.getPendingPrompt(1, picker.messageId!)!.payloadJson!);
    await router.handle(callbackMessage(`ar:cmd:resume:${data.token}:0`, 7, "resume", picker.messageId));
    expect(agent.getStatus("dsh:1:demo")?.threadId).toBe("saved-session");
    await router.handle(textMessage("/resume"));
    const oldPicker = adapter.sent.at(-1)!;
    const oldData = JSON.parse(store.getPendingPrompt(1, oldPicker.messageId!)!.payloadJson!);
    const stops = agent.stopped.length;
    await router.handle(textMessage("/new@relay_bot"));
    const newThreadId = agent.getStatus("dsh:1:demo")?.threadId;
    expect(newThreadId).not.toBe("saved-session");
    expect(agent.stopped).toHaveLength(stops + 1);
    await router.handle(callbackMessage(`ar:cmd:resume:${oldData.token}:0`, 7, "stale", oldPicker.messageId));
    expect(agent.getStatus("dsh:1:demo")?.threadId).toBe(newThreadId);
    expect(agent.stopped).toHaveLength(stops + 1);
    await router.handle(textMessage("/relay"));
    const home = adapter.sent.at(-1)!;
    expect(home.options!.replyMarkup!.inline_keyboard.flat().some(button => ["New session", "Sessions"].includes(button.text))).toBe(false);
    await router.handle(callbackMessage("ar:session:new:obsolete", 7, "old-button", home.messageId));
    expect(agent.stopped).toHaveLength(stops + 1);
    expect(agent.sent).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("DSH /new rejects unsupported arguments before changing the session", async () => {
    const { router, adapter, agent, commands } = nativeFixture("dsh");
    await router.handle(textMessage("/help"));
    const threadId = agent.getStatus("dsh:1:demo")?.threadId;
    await router.handle(textMessage("/new unexpected-name"));
    expect(adapter.sent.at(-1)?.text).toContain("Use /new without arguments");
    expect(agent.getStatus("dsh:1:demo")?.threadId).toBe(threadId);
    expect(agent.stopped).toEqual([]);
    expect(commands).toEqual([]);
  });

  test("DSH session search reaches older sessions and rejects answers after session replacement", async () => {
    const { router, adapter, agent, store } = nativeFixture("dsh");
    agent.threads = Array.from({ length: 12 }, (_, index) => ({ id: `saved-${index}`, name: `Session ${index}` }));
    agent.listThreads = async options => {
      agent.threadLists.push(options);
      return agent.threads.filter(thread => !options.searchTerm || thread.id === options.searchTerm).slice(0, options.limit);
    };
    await router.handle(textMessage("/help"));
    const openSearch = async () => {
      await router.handle(textMessage("/resume"));
      const picker = adapter.sent.at(-1)!;
      const search = picker.options!.replyMarkup!.inline_keyboard.flat().find(button => button.text === "Search sessions")!;
      await router.handle(callbackMessage(search.callback_data, 7, "search", picker.messageId));
      return adapter.sent.at(-1)!.messageId!;
    };
    const searchPrompt = await openSearch();
    await router.handle({ ...textMessage("saved-11"), replyToMessageId: searchPrompt });
    expect(agent.threadLists.at(-1)?.searchTerm).toBe("saved-11");
    const result = adapter.sent.at(-1)!;
    expect(result.text).toContain("Session 11");
    const data = JSON.parse(store.getPendingPrompt(1, result.messageId!)!.payloadJson!);
    await router.handle(callbackMessage(`ar:cmd:resume:${data.token}:0`, 7, "select", result.messageId));
    expect(agent.getStatus("dsh:1:demo")?.threadId).toBe("saved-11");
    const oldSearch = await openSearch();
    const listCalls = agent.threadLists.length;
    agent.getStatus("dsh:1:demo")!.threadId = "replacement";
    await router.handle({ ...textMessage("saved-10"), replyToMessageId: oldSearch });
    expect(agent.threadLists).toHaveLength(listCalls);
    expect(adapter.sent.at(-1)?.text).toContain("Session search expired");
    expect(agent.sent).toEqual([]);
  });

  test("DSH /new cannot turn a late search reply into a model prompt", async () => {
    const { router, adapter, agent, store } = nativeFixture("dsh");
    agent.threads = [{ id: "saved-session", name: "Saved" }];
    await router.handle(textMessage("/new"));
    await router.handle(textMessage("/resume"));
    const picker = adapter.sent.at(-1)!;
    const search = picker.options!.replyMarkup!.inline_keyboard.flat().find(button => button.text === "Search sessions")!;
    await router.handle(callbackMessage(search.callback_data, 7, "search", picker.messageId));
    const searchPrompt = adapter.sent.at(-1)!.messageId!;
    expect(store.getPendingPrompt(1, searchPrompt)).toBeDefined();
    await router.handle(textMessage("/new"));
    expect(store.getPendingPrompt(1, searchPrompt)).toBeUndefined();
    await router.handle({ ...textMessage("saved-session"), replyToMessageId: searchPrompt });
    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Session search expired");
    await router.handle(textMessage("ordinary task"));
    expect(agent.sent.map(message => message.text)).toEqual(["ordinary task"]);
  });

  test("DSH /new and /resume do not replace a busy native session", async () => {
    const { router, agent } = nativeFixture("dsh");
    await router.handle(textMessage("working"));
    for (const command of ["/new", "/resume", "/resume older-session"]) {
      await router.handle(textMessage(command));
    }
    expect(agent.stopped).toEqual([]);
    expect(agent.threadLists).toEqual([]);
    expect(agent.sent).toHaveLength(1);
  });

  test("Claude keeps native clear and resume syntax without DSH UI actions", async () => {
    const { router, adapter, agent, commands } = nativeFixture();
    await router.handle(textMessage("/new"));
    await router.handle(textMessage("/clear"));
    await router.handle(textMessage("/resume 12345678-1234-4234-8234-123456789abc"));
    expect(commands).toEqual(["/new", "/clear", "/resume 12345678-1234-4234-8234-123456789abc"]);
    await router.handle(textMessage("/relay"));
    const home = adapter.sent.at(-1)!;
    expect(home.options!.replyMarkup!.inline_keyboard.flat().some(button => button.callback_data.startsWith("ar:session:"))).toBe(false);
    await router.handle(callbackMessage("ar:session:new:forged", 7, "forged", home.messageId));
    expect(agent.stopped).toEqual([]);
  });

  for (const provider of ["claude", "dsh"] as const) {
    test(`${provider} keeps native interruption on the activity card`, async () => {
      const { router, agent, adapter } = nativeFixture(provider);
      const key = `${provider}:1:demo`;
      await router.handle(textMessage("work"));
      const status = agent.getStatus(key)!;
      await router.handleAgentOutput({ type: "activity", sessionKey: key, threadId: status.threadId,
        turnId: status.activeTurnId!, activity: { kind: "reasoning", summary: "Working" } });
      await waitForStreamFlush();
      const card = adapter.sent.findLast(message => message.options?.replyMarkup?.inline_keyboard.flat().some(button => button.text === "Interrupt"))!;
      const button = card.options!.replyMarkup!.inline_keyboard.flat().find(button => button.text === "Interrupt")!;
      await router.handle(callbackMessage(button.callback_data, 7, "interrupt", card.messageId));
      expect(agent.interrupted).toEqual([{ key, turnId: "turn-1" }]);
    });
  }

  test("a non-steerable backend rejects new busy input without a local queue", async () => {
    const { router, agent, adapter, store } = nativeFixture();
    await router.handle(textMessage("first"));
    agent.getStatus("claude:1:demo")!.canAcceptDirectInput = false;
    await router.handle(textMessage("second"));
    expect(agent.sent.map((entry) => entry.text)).toEqual(["first"]);
    expect(adapter.sent.at(-1)?.text).toContain("Wait for this turn");
    expect(store.countTasks(1, "demo", ["queued", "waiting"])).toBe(0);
  });

  test("native multi-select keeps separate answers and waits for submit", async () => {
    const { router, agent, adapter, store } = nativeFixture();
    await router.handle(textMessage("first"));
    await router.handleAgentOutput({ type: "user_input_request", sessionKey: "claude:1:demo", requestId: "q1", questions: [{
      id: "features", header: "Features", question: "Choose features", multiSelect: true,
      options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
    }] });
    const messageId = adapter.sent.at(-1)!.messageId!;
    const data = JSON.parse(store.getPendingPrompt(1, messageId)!.payloadJson!);
    await router.handle(callbackMessage(`ar:q:${data.token}:0`, 7, "a", messageId));
    await router.handle(callbackMessage(`ar:q:${data.token}:1`, 7, "b", messageId));
    expect(agent.responses).toEqual([]);
    await router.handle(callbackMessage(`ar:q:${data.token}:multi_submit`, 7, "submit", messageId));
    expect(agent.responses.at(-1)?.result).toEqual({ answers: { features: { answers: ["A", "B"] } } });
  });

  test("native approval cards offer only backend choices and encode opaque selections", async () => {
    const { router, agent, adapter, store } = nativeFixture("dsh");
    await router.handle(textMessage("first"));
    await router.handleAgentOutput({ type: "approval_request", sessionKey: "dsh:1:demo", requestId: "permission1", method: "approval/request", approvalKind: "native_tool", title: "Run command?", body: "git status", params: { choices: [{ action: "once", label: "Allow once" }, { action: "decline", label: "Reject" }] } });
    const messageId = adapter.sent.at(-1)!.messageId!;
    const data = JSON.parse(store.getPendingPrompt(1, messageId)!.payloadJson!);
    await router.handle(callbackMessage(`ar:a:${data.token}:session`, 7, "invalid", messageId));
    expect(agent.responses).toEqual([]);
    await router.handle(callbackMessage(`ar:a:${data.token}:once`, 7, "valid", messageId));
    expect(agent.responses.at(-1)?.result).toEqual({ action: "once" });
  });

  test("native model picker calls the selector API and rejects stale thread callbacks", async () => {
    const { router, agent, adapter, store, commands } = nativeFixture("dsh");
    const selected: string[] = [];
    agent.models = [{ id: '["provider","model-a"]', displayName: "Native A" }, { id: '["provider","model-b"]', displayName: "Native B" }];
    Object.assign(agent, { setModel: async (_key: string, id: string) => { selected.push(id); } });
    await router.handle(textMessage("/model"));
    const picker = adapter.sent.at(-1)!;
    const data = JSON.parse(store.getPendingPrompt(1, picker.messageId!)!.payloadJson!);
    await router.handle(callbackMessage(`ar:cmd:model:${data.token}:i1`, 7, "pick", picker.messageId));
    expect(selected).toEqual(['["provider","model-b"]']);
    expect(agent.sent).toEqual([]);
    expect(commands).toEqual([]);
    await router.handle(textMessage("/model"));
    const stale = adapter.sent.at(-1)!;
    const staleData = JSON.parse(store.getPendingPrompt(1, stale.messageId!)!.payloadJson!);
    agent.getStatus("dsh:1:demo")!.threadId = "a-different-session";
    await router.handle(callbackMessage(`ar:cmd:model:${staleData.token}:i0`, 7, "stale", stale.messageId));
    expect(selected).toHaveLength(1);
  });

  test("delivery-time thread fencing drops native output queued before session replacement", async () => {
    const { router, agent, adapter, store } = nativeFixture("dsh");
    await router.handle(textMessage("first"));
    const oldThread = agent.getStatus("dsh:1:demo")!.threadId;
    agent.getStatus("dsh:1:demo")!.threadId = "replacement-thread";
    const before = adapter.sent.length;
    await router.handleAgentOutput({ type: "message", sessionKey: "dsh:1:demo", threadId: oldThread, chunk: "Stale text" });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "dsh:1:demo", threadId: oldThread, status: "failed", error: { message: "Stale error" } });
    expect(adapter.sent).toHaveLength(before);
    expect(store.latestTranscriptEvent(1, "demo", "agent")).toBeUndefined();
  });
});
