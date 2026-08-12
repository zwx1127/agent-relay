import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callbackMessage, cleanupRelayFixtures, relayFixture as fixture, sentPrompt, textMessage, waitForStreamFlush } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

describe("relay controller Codex prompts", () => {
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
    expect(adapter.reactions).toEqual([
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "🤔" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
    const localEditCount = adapter.edited.length;
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: 77,
      result: { answers: { choice: { answers: ["Fast"] } } },
    });
    expect(adapter.edited).toHaveLength(localEditCount);
    expect(adapter.edited.at(-1)?.text).toContain("Answered");
    expect(adapter.edited.at(-1)?.text).toContain("Fast");
    expect(adapter.edited.at(-1)?.text).not.toContain("Codex request resolved");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
  });

  test("codex option question replaces a local choice when another client wins", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: "losing-choice",
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }, { label: "Deep", description: "More detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-losing-fast", prompt.messageId));
    expect(adapter.edited.at(-1)?.text).toBe("Answered: Fast");

    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: "losing-choice",
      result: { answers: { choice: { answers: ["Deep"] } } },
    });

    expect(adapter.edited).toHaveLength(2);
    expect(adapter.edited.at(-1)?.text).toBe("Answered: Deep");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
  });

  test("codex option question keeps pending state when callback card edit fails", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("ask mode"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 771,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    adapter.failEditMessage = new Error("card update failed");

    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast-failed", prompt.messageId));

    expect(agent.responses).toEqual([]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeDefined();
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-fast-failed", text: "card update failed" });

    adapter.failEditMessage = undefined;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast-retry", prompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 771,
      result: { answers: { choice: { answers: ["Fast"] } } },
    }]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("Answered");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
  });

  test("direct text during pending Codex question shows notice instead of starting another turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("ask mode"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 772,
      questions: [{
        id: "phase",
        header: "Phase",
        question: "Pick one.",
        options: [{ label: "brief", description: "Define the brief" }, { label: "game-design", description: "Design the game" }],
      }],
    });
    const prompt = adapter.sent.at(-1)!;

    await router.handle(textMessage("game-design"));

    expect(agent.sent).toEqual([sentPrompt("ask mode")]);
    expect(agent.responses).toEqual([]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeDefined();
    expect(adapter.sent.at(-1)?.text).toContain("Codex is waiting for your answer.");
    expect(adapter.sent.at(-1)?.text).toContain("Direct messages are not submitted as answers");
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
    const localEditCount = adapter.edited.length;
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: 78,
      result: { answers: { choice: { answers: ["Fast"] } } },
    });
    expect(adapter.edited).toHaveLength(localEditCount);
    expect(adapter.edited.at(-1)?.text).toBe("Answered: Fast");
  });

  test("submitting the final Plan answer returns the Activity card to Working", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan design this"));

    await router.handleAgentOutput({
      type: "activity",
      sessionKey: "codex:1:demo",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      activity: { kind: "reasoning", summary: "Comparing implementation options" },
    });
    await waitForStreamFlush();
    const activityMessage = adapter.sent.find((message) => message.text.includes("Codex") && message.text.includes("Working"))!;

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: 780,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });
    expect(adapter.edited.filter((message) => message.options.messageId === activityMessage.messageId).at(-1)?.text).toContain("Waiting for input");

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast-working", prompt.messageId));
    const submit = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Submit")!;
    await router.handle(callbackMessage(submit.callback_data, 7, "cb-submit-working", prompt.messageId));

    expect(agent.responses).toContainEqual({
      key: "codex:1:demo",
      requestId: 780,
      result: { answers: { choice: { answers: ["Fast"] } } },
    });
    expect(agent.getStatus("codex:1:demo")?.waitingForUserInput).toBe(false);
    const latestActivity = adapter.edited.filter((message) => message.options.messageId === activityMessage.messageId).at(-1)!;
    expect(latestActivity.text).toContain("Working");
    expect(latestActivity.text).not.toContain("Waiting for input");
  });

  test("completed Plan turn cannot be stuck or reopened by stale IM waiting state", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan design this"));

    const request = {
      type: "user_input_request" as const,
      sessionKey: "codex:1:demo",
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: 781,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    };
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: request.sessionKey,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: "reasoning-terminal",
      activity: { kind: "reasoning", summary: "Preparing the plan" },
    });
    await waitForStreamFlush();
    const activityMessage = adapter.sent.find((message) => message.text.includes("Codex") && message.text.includes("Working"))!;
    await router.handleAgentOutput(request);

    const prompt = adapter.sent.at(-1)!;
    const fast = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(fast.callback_data, 7, "cb-fast-terminal", prompt.messageId));
    const submit = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "Submit")!;
    await router.handle(callbackMessage(submit.callback_data, 7, "cb-submit-terminal", prompt.messageId));

    const status = agent.getStatus(request.sessionKey)!;
    status.activeTurnId = undefined;
    status.latestTurn = { id: request.turnId, status: "completed", activities: [] };
    await router.handleAgentOutput({
      type: "turn_completed",
      sessionKey: request.sessionKey,
      turnId: request.turnId,
      status: "completed",
    });

    const completedCard = adapter.edited.filter((message) => message.options.messageId === activityMessage.messageId).at(-1)!;
    expect(completedCard.text).toContain("Completed");
    expect(store.getTask(1)?.status).toBe("done");
    expect(store.latestPendingPrompt("1", ["codex_user_input"])).toBeUndefined();

    const sentBeforeLateRequest = adapter.sent.length;
    await router.handleAgentOutput({ ...request, requestId: 782 });
    expect(adapter.sent).toHaveLength(sentBeforeLateRequest);
    expect(adapter.edited.filter((message) => message.options.messageId === activityMessage.messageId).at(-1)?.text).toContain("Completed");

    status.waitingForUserInput = true;
    await router.handle(textMessage("continue working"));
    expect(agent.sent.at(-1)).toEqual(expect.objectContaining({ key: request.sessionKey, text: "continue working" }));
    expect(adapter.sent.at(-1)?.text).not.toContain("Codex is waiting for your answer.");
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
    expect(notePrompt.options?.forceReplyInstruction).toBe("Reply to this prompt with any note to include.");
    expect(notePrompt.options?.replyToMessageId).toBeUndefined();
    expect(notePrompt.text).toBe("Add note");
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
    expect(adapter.edited.at(-1)?.text).toBe("Selected: Other");
    expect(otherPrompt.options?.forceReply).toBe(true);
    expect(otherPrompt.options?.forceReplyInstruction).toBe("Reply to this prompt with the answer to use.");
    expect(otherPrompt.options?.replyToMessageId).toBeUndefined();
    expect(adapter.sent.filter((message) => message.text.includes("Other answer"))).toHaveLength(1);
    await router.handle(textMessage("Use a hybrid approach", 7, otherPrompt.messageId));

    expect(agent.responses).toEqual([{
      key: "codex:1:demo",
      requestId: 81,
      result: { answers: { choice: { answers: ["Use a hybrid approach"] } } },
    }]);
    expect(agent.sent).toEqual([]);
  });

  test("other answer prompt waits until original question card edit succeeds", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("/plan"));

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 82,
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        isOther: true,
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });

    const prompt = adapter.sent.at(-1)!;
    const other = prompt.options!.replyMarkup!.inline_keyboard[1]![0]!;
    adapter.failEditMessage = new Error("edit failed");
    await router.handle(callbackMessage(other.callback_data, 7, "cb-other", prompt.messageId));

    expect(adapter.sent.filter((message) => message.text.includes("Other answer"))).toHaveLength(0);
    expect(adapter.sent.filter((message) => message.text === "Selected: Other")).toHaveLength(0);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeDefined();

    adapter.failEditMessage = undefined;
    await router.handle(callbackMessage(other.callback_data, 7, "cb-other-retry", prompt.messageId));

    expect(adapter.sent.filter((message) => message.text.includes("Other answer"))).toHaveLength(1);
    expect(adapter.edited.at(-1)?.text).toBe("Selected: Other");
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    expect(adapter.sent.at(-1)?.options?.forceReplyInstruction).toBe("Reply to this prompt with the answer to use.");
    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBeUndefined();
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
  });

  test("stale codex user input callback expires without responding", async () => {
    const { router, adapter } = fixture();

    await router.handle(callbackMessage("ar:q:old:0:0"));

    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
    expect(adapter.edited.at(-1)?.text).toContain("Interrupt on the latest activity card");
  });

  test("expired codex question callback tells the user how to recover", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: "req1",
      questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }],
    });
    const prompt = adapter.sent.at(-1)!;
    const pending = store.getPendingPrompt("1", prompt.messageId!)!;
    store.setPendingPrompt({ ...pending, expiresAt: 1 });
    const option = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(option.callback_data, 7, "cb-expired-question", prompt.messageId));

    expect(agent.responses).toEqual([]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
    expect(adapter.edited.at(-1)?.text).toContain("Interrupt on the latest activity card");
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
    const localSentCount = adapter.sent.length;
    const localEditCount = adapter.edited.length;
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: "req1",
      result: { answers: { notes: { answers: ["Use SQLite"] } } },
    });
    expect(adapter.sent).toHaveLength(localSentCount);
    expect(adapter.edited).toHaveLength(localEditCount);
    expect(adapter.sent.filter((message) => message.text === "Answered: Use SQLite")).toHaveLength(1);
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
    expect(adapter.sent.at(-1)?.text).toContain("Interrupt on the latest activity card");
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
    expect(adapter.sent.at(-1)?.text).toContain("Interrupt on the latest activity card");
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
    const localEditCount = adapter.edited.length;
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: 88,
      result: { answers: { first: { answers: ["A"] }, second: { answers: ["B"] } } },
    });
    expect(adapter.edited).toHaveLength(localEditCount);
    expect(adapter.edited.filter((message) => message.options.messageId === first.messageId).at(-1)?.text).toBe("Answered: A");
    expect(adapter.edited.filter((message) => message.options.messageId === second.messageId).at(-1)?.text).toBe("Answered: B");
    expect(adapter.edited.some((message) => message.text.includes("First: A") && message.text.includes("Second: B"))).toBe(false);
  });

  test("a secret answer resolved in another IM scope is shown on the terminal card", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: "secret-answer",
      questions: [{ id: "token", header: "Token", question: "Enter token.", isSecret: true }],
    });
    const prompt = adapter.sent.at(-1)!;

    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: "secret-answer",
      result: { answers: { token: { answers: ["secret-value"] } } },
    });

    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("Answered:");
    expect(adapter.edited.at(-1)?.text).toContain("secret-value");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
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
    expect(adapter.sent.at(-1)?.text).toContain("Question expired.");
    expect(adapter.sent.at(-1)?.text).toContain("Interrupt on the latest activity card");
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
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
      { conversationId: "1", messageId: "1", emoji: "✍" },
      { conversationId: "1", messageId: "1", emoji: "🤔" },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });

  test("deduplicates approval, user-input, and MCP cards by logical request", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("run tests"));

    const approval = {
      type: "approval_request" as const,
      sessionKey: "codex:1:demo",
      requestId: "approval-first",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      method: "item/commandExecution/requestApproval",
      approvalKind: "command" as const,
      title: "Approve command?",
      body: "bun test",
      params: { command: "bun test" },
    };
    const approvalStart = adapter.sent.length;
    await router.handleAgentOutput(approval);
    const approvalCard = adapter.sent.at(-1)!;
    await router.handleAgentOutput({ ...approval, requestId: "approval-copy", body: "changed command", params: { command: "changed command" } });
    expect(adapter.sent.slice(approvalStart)).toHaveLength(1);
    expect(approvalCard.text).toContain("bun test");
    expect(approvalCard.text).not.toContain("changed command");
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: approval.sessionKey,
      requestId: "approval-copy",
      threadId: approval.threadId,
    });
    expect(store.getPendingPrompt("1", approvalCard.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("Codex request resolved.");

    const question = {
      type: "user_input_request" as const,
      sessionKey: "codex:1:demo",
      requestId: "question-first",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "question-1",
      questions: [{
        id: "mode",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Quick" }],
      }],
    };
    const questionStart = adapter.sent.length;
    await router.handleAgentOutput(question);
    const questionCard = adapter.sent.at(-1)!;
    await router.handleAgentOutput({ ...question, requestId: "question-copy" });
    expect(adapter.sent.slice(questionStart)).toHaveLength(1);
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: question.sessionKey,
      requestId: "question-copy",
      threadId: question.threadId,
    });
    expect(store.getPendingPrompt("1", questionCard.messageId!)).toBeUndefined();

    const elicitation = {
      type: "mcp_elicitation_request" as const,
      sessionKey: "codex:1:demo",
      requestId: "mcp-first",
      threadId: "thread-1",
      turnId: "turn-1",
      elicitationId: "elicitation-1",
      serverName: "example",
      mode: "url" as const,
      message: "Complete authentication.",
      url: "https://example.test/auth",
    };
    const mcpStart = adapter.sent.length;
    await router.handleAgentOutput(elicitation);
    const mcpCard = adapter.sent.at(-1)!;
    await router.handleAgentOutput({ ...elicitation, requestId: "mcp-copy" });
    expect(adapter.sent.slice(mcpStart)).toHaveLength(1);
    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: elicitation.sessionKey,
      requestId: "mcp-copy",
      threadId: elicitation.threadId,
      result: { action: "accept", content: null, _meta: null },
    });
    expect(store.getPendingPrompt("1", mcpCard.messageId!)).toBeUndefined();
    expect(adapter.edited.at(-1)?.text).toContain("MCP action completed.");
  });

  test("allows an MCP request to retry after its first card render fails", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const event = {
      type: "mcp_elicitation_request" as const,
      sessionKey: "codex:1:demo",
      requestId: "mcp-retry",
      threadId: "thread-1",
      turnId: "turn-1",
      elicitationId: "elicitation-retry",
      serverName: "example",
      mode: "url" as const,
      message: "Complete authentication.",
      url: "https://example.test/auth",
    };
    adapter.failSendMessage = new Error("send failed");
    await expect(router.handleAgentOutput(event)).rejects.toThrow("send failed");

    adapter.failSendMessage = undefined;
    const beforeRetry = adapter.sent.length;
    await router.handleAgentOutput(event);
    expect(adapter.sent.slice(beforeRetry)).toHaveLength(1);
    expect(store.getPendingPrompt("1", adapter.sent.at(-1)!.messageId!)).toBeDefined();
  });

  test("typed MCP forms validate fields, support Skip, and submit structured content", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "mcp_elicitation_request",
      sessionKey: "codex:1:demo",
      requestId: 501,
      serverName: "example",
      mode: "form",
      message: "Configure",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", minLength: 2, maxLength: 10 },
          notify: { type: "boolean", title: "Notify" },
        },
        required: ["name"],
      },
    });
    const nameCard = adapter.sent.at(-1)!;
    const enterButton = nameCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Enter value");
    expect(nameCard.options?.replyMarkup?.inline_keyboard.flat().some((button) => button.text === "Cancel")).toBe(true);
    await router.handle(callbackMessage(enterButton!.callback_data, 7, "cb-mcp-enter", nameCard.messageId));
    const replyPrompt = adapter.sent.at(-1)!;
    expect(replyPrompt.options?.forceReply).toBe(true);

    await router.handle(textMessage("x", 7, Number(replyPrompt.messageId)));
    expect(adapter.sent.at(-2)?.text).toContain("Invalid MCP field value.");
    const retryPrompt = adapter.sent.at(-1)!;
    await router.handle(textMessage("Ada", 7, Number(retryPrompt.messageId)));
    const booleanCard = adapter.sent.at(-1)!;
    const skipButton = booleanCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Skip");
    await router.handle(callbackMessage(skipButton!.callback_data, 7, "cb-mcp-skip", booleanCard.messageId));
    const submitCard = adapter.sent.at(-1)!;
    const submitButton = submitCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Submit");
    await router.handle(callbackMessage(submitButton!.callback_data, 7, "cb-mcp-submit", submitCard.messageId));

    expect(agent.responses).toContainEqual({
      key: "codex:1:demo",
      requestId: 501,
      result: { action: "accept", content: { name: "Ada" }, _meta: null },
    });
    expect(store.getPendingPrompt("1", submitCard.messageId!)).toBeUndefined();
  });

  test("an approval answered by another connected client clears the local controls", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("run tests"));

    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: "codex:1:demo",
      requestId: "shared-91",
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "Approve command?",
      body: "bun test",
      params: { command: "bun test" },
      turnId: "turn-1",
    });
    const prompt = adapter.sent.at(-1)!;

    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: "shared-91",
      result: { decision: "acceptForSession" },
    });

    expect(agent.responses).toEqual([]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(store.getTask(1)?.status).toBe("running");
    expect(adapter.edited.at(-1)?.text).toContain("Approved for this session.");
    expect(adapter.edited.at(-1)?.text).toContain("Approve command?");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard).toEqual([]);
  });

  test("a remotely resolved prompt falls back to a replacement terminal card when edits fail", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: "shared-edit-failure",
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Low detail" }],
      }],
    });
    const prompt = adapter.sent.at(-1)!;
    adapter.failEditMessage = new Error("edit unavailable");

    await router.handleAgentOutput({
      type: "server_request_resolved",
      sessionKey: "codex:1:demo",
      requestId: "shared-edit-failure",
      result: { answers: { choice: { answers: ["Fast"] } } },
    });

    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toContain("Answered:");
    expect(adapter.sent.at(-1)?.text).toContain("Fast");
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard).toEqual([]);
  });

  test("URL MCP elicitation supports Complete and returns accept without content", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handleAgentOutput({
      type: "mcp_elicitation_request",
      sessionKey: "codex:1:demo",
      requestId: 502,
      serverName: "login",
      mode: "url",
      message: "Authorize access",
      url: "https://example.test/login",
      elicitationId: "elicit-1",
    });
    const card = adapter.sent.at(-1)!;
    const complete = card.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Complete");
    expect(card.text).toContain("https://example.test/login");
    await router.handle(callbackMessage(complete!.callback_data, 7, "cb-mcp-url", card.messageId));

    expect(agent.responses).toContainEqual({ key: "codex:1:demo", requestId: 502, result: { action: "accept", content: null, _meta: null } });
  });

  test("expired codex command approval denies the action and resumes the blocked task", async () => {
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
      body: "Run tests",
      params: { command: "bun test" },
      turnId: "turn-1",
    });
    const prompt = adapter.sent.at(-1)!;
    const pending = store.getPendingPrompt("1", prompt.messageId!)!;
    store.setPendingPrompt({ ...pending, expiresAt: 1 });
    const approve = prompt.options!.replyMarkup!.inline_keyboard[0]![0]!;

    await router.handle(callbackMessage(approve.callback_data, 7, "cb-expired-approval", prompt.messageId));

    expect(agent.responses).toEqual([{ key: "codex:1:demo", requestId: 91, result: { decision: "decline" } }]);
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(store.getTask(1)?.status).toBe("running");
    expect(adapter.edited.at(-1)?.text).toContain("Approval expired.");
    expect(adapter.edited.at(-1)?.text).toContain("denied");
    expect(adapter.reactions.at(-1)).toEqual({ conversationId: "1", messageId: "1", emoji: "✍" });
  });});
