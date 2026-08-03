import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import { chatScopeKey } from "../../src/domain/scope.ts";
import { workspaceCallbackToken } from "../../src/relay/ui/callback-data.ts";
import { callbackMessage, cleanupRelayFixtures, relayFixture as fixture, sentPrompt, textMessage } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

describe("relay controller thread commands", () => {
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

  test("/help sends command usage with a selected workspace", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/help"));

    expect(agent.sent).toEqual([]);
    expect(agent.builtins).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay commands");
    expect(adapter.sent.at(-1)?.text).toContain("/review commit <sha> [title]");
    expect(adapter.sent.at(-1)?.text).toContain("/interrupt all");
    expect(adapter.sent.at(-1)?.options?.entities?.some((entity) => entity.type === "code")).toBe(true);
    expect(adapter.reactions).toEqual([]);
  });

  test("unsupported slash commands are rejected when a workspace is selected", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/codex"));
    await router.handle(textMessage("/status"));
    await router.handle(textMessage("/start"));
    await router.handle(textMessage("/model"));

    expect(agent.sent).toEqual([]);
    expect(agent.builtins).toEqual([]);
    expect(adapter.sent.map((message) => message.text)).toEqual([
      "Unknown command: /codex. Send /help to see supported commands.",
      "Unknown command: /status. Send /help to see supported commands.",
      "Unknown command: /start. Send /help to see supported commands.",
      "Unknown command: /model. Send /help to see supported commands.",
    ]);
    expect(adapter.reactions).toEqual([]);
  });

  test("/review runs immediately and /compact requires confirmation", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/review branch main"));
    await router.handle(textMessage("/compact"));
    const compactCard = adapter.sent.at(-1)!;
    const compactButton = compactCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Compact");

    expect(agent.sent).toEqual([]);
    expect(agent.builtins).toEqual([
      { key: "codex:1:demo", command: { type: "review", target: { type: "baseBranch", branch: "main" } } },
    ]);
    expect(compactCard.text).toContain("Compact chat?");

    await router.handle(callbackMessage(compactButton!.callback_data, 7, "cb-compact", compactCard.messageId));

    expect(agent.builtins.at(-1)).toEqual({ key: "codex:1:demo", command: { type: "compact" } });
    expect(adapter.edited.at(-1)?.text).toContain("Compaction started.");
  });

  test("/archive uses one confirmation while /delete requires two", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/archive"));
    const archiveCard = adapter.sent.at(-1)!;
    const archiveButton = archiveCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Archive");
    expect(agent.archived).toEqual([]);
    await router.handle(callbackMessage(archiveButton!.callback_data, 7, "cb-archive", archiveCard.messageId));
    expect(agent.archived).toEqual(["codex:1:demo"]);
    expect(store.getSession("codex:1:demo")?.thread_id).toBeNull();

    await router.handle(textMessage("/delete"));
    const deleteCard = adapter.sent.at(-1)!;
    const continueButton = deleteCard.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Continue");
    await router.handle(callbackMessage(continueButton!.callback_data, 7, "cb-delete-first", deleteCard.messageId));
    expect(agent.deleted).toEqual([]);
    const finalButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Delete permanently");
    await router.handle(callbackMessage(finalButton!.callback_data, 7, "cb-delete-final", deleteCard.messageId));

    expect(agent.deleted).toEqual(["codex:1:demo"]);
    expect(store.getSession("codex:1:demo")?.thread_id).toBeNull();
    expect(adapter.edited.at(-1)?.text).toContain("Chat deleted.");
  });

  test("expired compact confirmation does not call app-server", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/compact"));
    const card = adapter.sent.at(-1)!;
    const button = card.options?.replyMarkup?.inline_keyboard.flat().find((item) => item.text === "Compact");
    const pending = store.getPendingPrompt("1", card.messageId!)!;
    store.setPendingPrompt({ ...pending, expiresAt: Date.now() - 1 });
    await router.handle(callbackMessage(button!.callback_data, 7, "cb-compact-expired", card.messageId));

    expect(agent.builtins).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
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
    expect(adapter.sent[1]?.text).toContain("Goal updated.");
    expect(adapter.sent[1]?.options?.replyMarkup).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toBe("Goal cleared.");
  });

  test("/goal refuses implicit replacement and /goal edit uses ForceReply", async () => {
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
    expect(adapter.sent.at(-1)?.text).toContain("Use /goal edit");
    expect(agent.goalSets).toEqual([]);

    await router.handle(textMessage("/goal edit"));
    const editPrompt = adapter.sent.at(-1)!;
    expect(editPrompt.text).toContain("Edit goal");
    expect(editPrompt.options?.forceReply).toBe(true);
    await router.handle(textMessage("replacement goal", 7, Number(editPrompt.messageId)));

    expect(agent.goalSets).toEqual([
      { key: "codex:1:demo", goal: { objective: "replacement goal" } },
    ]);
    expect(adapter.sent.at(-1)?.text).toContain("Goal updated.");
    expect(agent.sent).toEqual([]);
    expect(store.getPendingPrompt("1", editPrompt.messageId!)).toBeUndefined();
  });

  test("/goal validates the 4,000 character objective boundary", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    const accepted = "a".repeat(4_000);
    await router.handle(textMessage(`/goal ${accepted}`));
    expect(agent.goalSets.at(-1)?.goal.objective).toBe(accepted);
    await router.handle(textMessage("/goal clear"));
    await router.handle(textMessage(`/goal ${"b".repeat(4_001)}`));

    expect(agent.goalSets).toHaveLength(1);
    expect(adapter.sent.at(-1)?.text).toContain("must not exceed 4,000 characters");
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
    expect(adapter.sent.at(-1)?.text).toContain("Cleared Relay display and started a new chat.");
  });

  test("/new preserves Relay display while /clear removes transcript and pages, and both accept a name", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.appendTranscript({ conversationId: "1", workspaceName: "demo", role: "agent", text: "old output", createdAt: 1 });
    store.setPagedOutput({ token: "page", conversationId: "1", sessionKey: "codex:1:demo", text: "long", createdAt: 1, expiresAt: Date.now() + 60_000 });

    await router.handle(textMessage("/new Fresh work"));

    expect(agent.renames.at(-1)).toEqual({ key: "codex:1:demo", name: "Fresh work" });
    expect(store.latestTranscriptEvent("1", "demo", "agent")?.text).toBe("old output");
    expect(store.getPagedOutput("page")?.text).toBe("long");

    await router.handle(textMessage("/clear Clean work"));

    expect(agent.renames.at(-1)).toEqual({ key: "codex:1:demo", name: "Clean work" });
    expect(store.latestTranscriptEvent("1", "demo", "agent")).toBeUndefined();
    expect(store.getPagedOutput("page")).toBeUndefined();
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

  test("/resume rechecks busy state before switching and never cancels the active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "current-thread" });
    agent.threads = [{ id: "saved-thread", name: "Saved work", cwd: path, updatedAt: 1 }];

    await router.handle(textMessage("/resume"));
    const picker = adapter.sent.at(-1)!;
    const resumeButton = picker.options?.replyMarkup?.inline_keyboard.flat()[0];
    await router.handle(textMessage("work started after picker"));
    await router.handle(callbackMessage(resumeButton!.callback_data, 7, "cb-resume-busy", picker.messageId));

    expect(agent.stopped).toEqual([]);
    expect(agent.getStatus("codex:1:demo")?.threadId).toBe("current-thread");
    expect(store.getTask(1)?.status).toBe("running");
    expect(adapter.edited.at(-1)?.text).toContain("Codex is busy.");
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

  test("/side and /btw run ephemeral side conversations without submitting main tasks", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/side where is config?"));
    await router.handle(textMessage("/btw what changed?"));
    await router.handle(textMessage("/side"));

    expect(agent.sent).toEqual([]);
    expect(agent.sideConversations).toEqual([
      { key: "codex:1:demo", text: "where is config?" },
      { key: "codex:1:demo", text: "what changed?" },
    ]);
    expect(adapter.sent.map((message) => message.text)).toEqual([
      "Side conversation\n\nside: where is config?",
      "Side conversation\n\nside: what changed?",
      "Side question requested.",
    ]);
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    expect(adapter.sent.at(-1)?.options?.forceReplyInstruction).toBe("Reply to this prompt, or send your next message with the side question.");
  });

  test("/side is rejected during a review turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.reviewInProgress = true;

    await router.handle(textMessage("/side explain the review"));

    expect(agent.sideConversations).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Side conversation unavailable.");
    expect(adapter.sent.at(-1)?.text).toContain("review to finish");
  });

  test("/ps lists only Codex background terminals tracked by the driver", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.backgroundTerminals = [
      { commandDisplay: "npm run dev", recentChunks: ["boot", "ready", "listening", "healthy"] },
    ];

    await router.handle(textMessage("/ps"));
    await router.handle(textMessage("/stop"));
    await router.handle(textMessage("/ps"));

    expect(adapter.sent.map((message) => message.text)).toEqual([
      "Background terminals\n\n- npm run dev\n  ready\n  listening\n  healthy",
      "Background terminals stopped.",
      "Background terminals\n\nNo background terminals running.",
    ]);
  });

  test("/ps exposes per-terminal Stop and /clean aliases /stop", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.backgroundTerminals = [{ itemId: "item-1", processId: "process-1", commandDisplay: "bun dev", recentChunks: ["ready"] }];

    await router.handle(textMessage("/ps"));
    const card = adapter.sent.at(-1)!;
    const stopButton = card.options?.replyMarkup?.inline_keyboard.flat()[0];
    expect(stopButton?.text).toContain("Stop bun dev");
    await router.handle(callbackMessage(stopButton!.callback_data, 7, "cb-terminal-stop", card.messageId));

    expect(agent.terminated).toEqual([{ key: "codex:1:demo", processId: "process-1" }]);
    expect(adapter.edited.at(-1)?.text).toContain("Background terminal stopped.");

    agent.backgroundTerminals = [{ itemId: "item-2", processId: "process-2", commandDisplay: "bun watch" }];
    await router.handle(textMessage("/clean"));
    expect(agent.cleaned).toEqual(["codex:1:demo"]);
    expect(agent.backgroundTerminals).toEqual([]);
  });

  test("/plan enters Plan mode and implementing a plan returns to default mode", async () => {
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

  test("empty /plan is idempotent and does not toggle back to Default", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan"));
    await router.handle(textMessage("/plan"));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent).toEqual([]);
    expect(adapter.sent.slice(-2).map((message) => message.text)).toEqual(["Plan mode enabled.", "Plan mode enabled."]);
  });

  test("failed Plan turns do not show Plan-ready and preserve the failure", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({
      type: "turn_completed",
      sessionKey: "codex:1:demo",
      turnId: "turn-1",
      status: "failed",
      error: { message: "planning failed" },
      durationMs: 10,
    });

    expect(store.getTask(1)?.status).toBe("failed");
    expect(adapter.sent.some((message) => message.text.includes("Plan ready."))).toBe(false);
    expect(adapter.sent.at(-1)?.text).toContain("planning failed");
  });

  test("plan ready card stays in the originating Telegram topic", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    const topic = { provider: "telegram" as const, id: "10" };
    const scope = chatScopeKey("1", topic);
    const key = sessionKey(scope, "demo");
    store.bindConversation(scope, "demo", 1, "1");

    await router.handle({ ...textMessage("/plan design this", 7, undefined, "1"), topic });

    expect(agent.sent.at(-1)).toEqual({ key, text: "design this", options: { collaborationMode: "plan" } });
    expect(adapter.chatActions.at(-1)).toEqual({ conversationId: "1", action: "typing", options: { topic } });

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: key, turnId: "turn-1" });
    agent.getStatus(key)!.activeTurnId = undefined;
    const planMessage = adapter.sent.at(-1)!;
    const planButton = planMessage.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Implement");

    expect(planMessage).toMatchObject({
      conversationId: "1",
      options: { topic },
    });
    expect(store.getPendingPrompt(scope, planMessage.messageId!)).toBeDefined();
    expect(store.getPendingPrompt("1", planMessage.messageId!)).toBeUndefined();

    await router.handle(callbackMessage(planButton!.callback_data, 7, "cb-plan-topic", planMessage.messageId, "1"));

    expect(store.getCollaborationMode(key)).toBe("default");
    expect(agent.sent.at(-1)).toEqual({ key, text: "Implement the approved plan.", options: { collaborationMode: "default" } });
  });

  test("plan ready card stays in the originating Lark thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    const topic = { provider: "lark" as const, id: "thread-1", rootMessageId: "root-1" };
    const scope = chatScopeKey("1", topic);
    const key = sessionKey(scope, "demo");
    store.bindConversation(scope, "demo", 1, "1");

    await router.handle({ ...textMessage("/plan design this", 7, undefined, "1"), topic });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: key, turnId: "turn-1" });

    const planMessage = adapter.sent.at(-1)!;
    expect(agent.sent.at(-1)).toEqual({ key, text: "design this", options: { collaborationMode: "plan" } });
    expect(planMessage).toMatchObject({
      conversationId: "1",
      options: { topic },
    });
    expect(store.getPendingPrompt(scope, planMessage.messageId!)).toBeDefined();
    expect(store.getPendingPrompt("1", planMessage.messageId!)).toBeUndefined();
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

  test("new thread resets plan mode before the next prompt", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1", status: "completed" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;

    await router.handle(textMessage("/clear"));
    await router.handle(textMessage("build it"));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent.at(-1)).toEqual(sentPrompt("build it"));
  });

  test("resuming a thread resets plan mode before the next prompt", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.threads = [{ id: "saved-thread", name: "Saved work", cwd: path, updatedAt: 1 }];

    await router.handle(textMessage("/plan design this"));
    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1", status: "completed" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;

    await router.handle(textMessage("/resume saved"));
    const resumeButton = adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat()[0];
    await router.handle(callbackMessage(resumeButton!.callback_data, 7, "cb-resume-plan-reset", adapter.sent.at(-1)?.messageId));
    await router.handle(textMessage("continue work"));

    expect(agent.getStatus("codex:1:demo")?.threadId).toBe("saved-thread");
    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent.at(-1)).toEqual(sentPrompt("continue work"));
  });

  test("forking a thread resets plan mode before the next prompt", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;

    await router.handle(textMessage("/fork"));
    await router.handle(textMessage("continue on fork"));

    expect(agent.forks).toEqual(["codex:1:demo"]);
    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent.at(-1)).toEqual(sentPrompt("continue on fork"));
  });

  test("switching workspace starts the selected workspace in default mode", async () => {
    const { router, store, agent, root } = fixture();
    const demoPath = join(root, "demo");
    const otherPath = join(root, "other");
    mkdirSync(demoPath);
    mkdirSync(otherPath);
    store.upsertWorkspace({ name: "demo", path: demoPath, createdAt: 1 });
    store.upsertWorkspace({ name: "other", path: otherPath, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");

    await router.handle(callbackMessage(`ar:uh:${workspaceCallbackToken("other")}`, 7, "cb-workspace-plan-reset"));
    await router.handle(textMessage("work in other"));

    expect(store.getBinding(1)?.workspaceName).toBe("other");
    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(store.getCollaborationMode("codex:1:other")).toBe("default");
    expect(agent.sent.at(-1)).toEqual({
      key: "codex:1:other",
      text: "work in other",
      options: { collaborationMode: "default" },
    });

    await router.handle(callbackMessage(`ar:uh:${workspaceCallbackToken("demo")}`, 7, "cb-workspace-plan-reset-back"));
    await router.handle(textMessage("back to demo"));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent.at(-1)).toEqual(sentPrompt("back to demo"));
  });

  test("old plan ready implement callback expires after starting a new thread", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;
    const planMessage = adapter.sent.at(-1)!;
    const planButton = planMessage.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Implement");
    const sentCount = agent.sent.length;

    await router.handle(textMessage("/clear"));
    await router.handle(callbackMessage(planButton!.callback_data, 7, "cb-old-plan", planMessage.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(agent.sent).toHaveLength(sentCount);
    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
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

  test("plan implement callback does not submit when original card edit fails", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
    agent.getStatus("codex:1:demo")!.activeTurnId = undefined;
    const planMessage = adapter.sent.at(-1)!;
    const planButton = planMessage.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Implement");
    const sentCount = agent.sent.length;
    adapter.failEditMessage = new Error("edit failed");

    await router.handle(callbackMessage(planButton!.callback_data, 7, "cb-plan-edit-failed", planMessage.messageId));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent).toHaveLength(sentCount);
    expect(store.getPendingPrompt("1", planMessage.messageId!)).toBeDefined();
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-plan-edit-failed", text: "edit failed" });
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

  test("thread/closed fails active work but preserves the thread id for resume", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.markSessionStarted("codex:1:demo", "1", "demo", 1, "thread-closed");
    const task = store.createTask({ conversationId: "1", workspaceName: "demo", text: "running", status: "running" });

    await router.handleAgentOutput({ type: "thread_lifecycle", sessionKey: "codex:1:demo", threadId: "thread-closed", action: "closed" });

    expect(store.getTask(task.id)?.status).toBe("failed");
    expect(store.getSession("codex:1:demo")?.thread_id).toBe("thread-closed");
    expect(adapter.sent.at(-1)?.text).toContain("Chat closed.");
  });

  test("thread/archive clears the persisted thread id idempotently", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.markSessionStarted("codex:1:demo", "1", "demo", 1, "thread-archived");

    await router.handleAgentOutput({ type: "thread_lifecycle", sessionKey: "codex:1:demo", threadId: "thread-archived", action: "archived" });
    await router.handleAgentOutput({ type: "thread_lifecycle", sessionKey: "codex:1:demo", threadId: "thread-archived", action: "archived", initiatedByClient: true });

    expect(store.getSession("codex:1:demo")?.thread_id).toBeNull();
    expect(adapter.sent.filter((message) => message.text.includes("Chat archived externally."))).toHaveLength(1);
  });

  test("/clear rejects while a task is active without cancelling it", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("run task"));
    const task = store.getTask(1)!;
    await router.handle(textMessage("/clear"));

    expect(store.getTask(task.id)?.status).toBe("running");
    expect(agent.stopped).toEqual([]);
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("Codex is busy.");
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

});
