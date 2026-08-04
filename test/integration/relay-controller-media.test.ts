import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import { estimateImRows } from "../../src/relay/activity-streamer.ts";
import { MEDIA_GROUP_QUIET_MS } from "../../src/relay/ui/constants.ts";
import { sleep } from "../support/fakes.ts";
import { audioMessage, callbackMessage, cleanupRelayFixtures, fileMessage, mediaMessage, relayFixture as fixture, sentPrompt, textMessage, waitForStreamFlush } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

describe("relay controller tasks and media", () => {
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

  test("/help without a workspace sends command usage instead of Relay Home", async () => {
    const { router, adapter, agent } = fixture();

    await router.handle(textMessage("/help"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay commands");
    expect(adapter.sent.at(-1)?.text).toContain("/relay");
    expect(adapter.sent.at(-1)?.text).not.toContain("workspace: none");
  });

  test("new workspace callback uses ForceReply and reply creates binding", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(callbackMessage("ar:n"));
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    expect(adapter.sent.at(-1)?.options?.forceReplyInstruction).toBe("Reply to this prompt, or send your next message with the workspace name.");
    expect(adapter.sent.at(-1)?.options?.inputFieldPlaceholder).toBe("repo name under WORKSPACE_ROOT");
    expect(adapter.sent.at(-1)?.text).toBe("Existing directories under WORKSPACE_ROOT are selected; missing names are created.");
    const promptId = adapter.sent.length + 99;

    await router.handle(textMessage("demo", 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("created and selected");
    expect(adapter.sent.at(-1)?.text).not.toContain("Relay Home");
    expect(adapter.sent.at(-1)?.options?.replyMarkup).toBeUndefined();
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
    expect(adapter.sent.at(-1)?.text).not.toContain("Relay Home");
    expect(adapter.sent.at(-1)?.options?.replyMarkup).toBeUndefined();
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
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
      { conversationId: "1", messageId: "1", emoji: "✍" },
    ]);
  });

  test("/add is rejected as an unknown command while a turn is active", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("/add include tests"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toBe("Unknown command: /add. Send /help to see supported commands.");
    expect(store.getTask(1)).toBeUndefined();
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
    expect(adapter.reactions).toEqual([]);
  });

  test("/help during an active turn sends usage without steering Codex", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.activeTurnId = "turn-1";

    await router.handle(textMessage("/help"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Relay commands");
    expect(store.getTask(1)).toBeUndefined();
    expect(store.listTasks(1, "demo", ["queued"])).toHaveLength(0);
    expect(adapter.reactions).toEqual([]);
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
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
      { conversationId: "1", messageId: "1", emoji: "😱" },
    ]);
  });

  test("/interrupt marks the active turn task interrupted while keeping the session selected", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("long task"));
    await router.handle(textMessage("/interrupt"));

    expect(agent.interrupted).toEqual([{ key: "codex:1:demo", turnId: "turn-1" }]);
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
    expect(agent.getStatus("codex:1:demo")?.activeTurnId).toBeUndefined();
    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(store.getTask(1)?.status).toBe("interrupted");
    expect(adapter.reactions.at(-1)).toEqual({ conversationId: "1", messageId: "1", emoji: "🤨" });
    expect(adapter.sent.at(-1)?.text).toContain("Interrupted current turn.");
  });

  test("/interrupt recovers stale Codex active turn without recording a Relay Home error", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("long task"));
    agent.staleInterrupt = true;
    await router.handle(textMessage("/interrupt"));

    expect(agent.interrupted).toEqual([{ key: "codex:1:demo", turnId: "turn-1" }]);
    expect(agent.getStatus("codex:1:demo")?.activeTurnId).toBeUndefined();
    expect(store.getTask(1)?.status).toBe("interrupted");
    expect(store.latestTranscriptEvent("1", "demo", "system")).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toContain("No active Codex turn remained.");
    expect(adapter.sent.at(-1)?.text).not.toContain("Error:");

    await router.handle(textMessage("/relay"));

    expect(adapter.sent.at(-1)?.text).toContain("Relay Home");
    expect(adapter.sent.at(-1)?.text).not.toContain("Error:");
  });

  test("/interrupt does not start a session when no turn is active", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/interrupt"));

    expect(agent.interrupted).toEqual([]);
    expect(agent.getStatus("codex:1:demo")).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toContain("No active Codex turn to interrupt.");
  });

  test("/interrupt all marks active and queued tasks interrupted", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("long task"));
    await (router as any).submitTask(1, "queued work", 88, "queue");
    await router.handle(textMessage("/interrupt all"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(agent.interrupted).toEqual([{ key: "codex:1:demo", turnId: "turn-1" }]);
    expect(agent.sent).toHaveLength(1);
    expect(store.getTask(1)?.status).toBe("interrupted");
    expect(store.getTask(2)?.status).toBe("interrupted");
    expect(adapter.reactions).toContainEqual({ conversationId: "1", messageId: "1", emoji: "🤨" });
    expect(adapter.reactions).toContainEqual({ conversationId: "1", messageId: "88", emoji: "🤨" });
    expect(adapter.sent.at(-1)?.text).toContain("Interrupted current turn and queued tasks.");
  });

  test("/interrupt suppresses plan ready for the interrupted plan turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/plan design this"));
    await router.handle(textMessage("/interrupt"));
    const sentCount = adapter.sent.length;
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(agent.interrupted).toEqual([{ key: "codex:1:demo", turnId: "turn-1" }]);
    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(store.getTask(1)?.status).toBe("interrupted");
    expect(adapter.reactions.at(-1)).toEqual({ conversationId: "1", messageId: "1", emoji: "🤨" });
    expect(adapter.sent).toHaveLength(sentCount);
    expect(adapter.sent.some((message) => message.text.includes("Plan ready."))).toBe(false);
  });

  test("/interrupt expires pending Codex question callbacks for the interrupted session", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("question task"));
    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 900,
      turnId: "turn-1",
      questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }],
    });
    const questionMessage = adapter.sent.at(-1)!;
    const optionButton = questionMessage.options?.replyMarkup?.inline_keyboard.flat()[0];
    expect(store.getPendingPrompt("1", questionMessage.messageId!)).toBeDefined();

    await router.handle(textMessage("/interrupt"));

    expect(store.getPendingPrompt("1", questionMessage.messageId!)).toBeUndefined();
    await router.handle(callbackMessage(optionButton!.callback_data, 7, "cb-question", questionMessage.messageId));

    expect(agent.responses).toEqual([]);
    expect(adapter.edited.at(-1)?.text).toContain("Question expired.");
  });

  test("/interrupt clears stale waiting approval state without an active turn", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    const status = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });
    status.waitingForApproval = true;
    const task = store.createTask({ conversationId: 1, workspaceName: "demo", text: "run tests", status: "blocked", userMessageId: 88 });
    store.setPendingPrompt({
      conversationId: "1",
      promptMessageId: 101,
      kind: "codex_approval",
      createdAt: 1,
      sessionKey: "codex:1:demo",
      payloadJson: JSON.stringify({ token: "tok", requestId: 91, approvalKind: "command" }),
      expiresAt: 1,
    });

    await router.handle(textMessage("/interrupt"));

    expect(agent.interrupted).toEqual([{ key: "codex:1:demo" }]);
    expect(agent.getStatus("codex:1:demo")?.waitingForApproval).toBe(false);
    expect(store.getPendingPrompt("1", 101)).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("interrupted");
    expect(adapter.sent.at(-1)?.text).toContain("Cleared stale Relay state.");
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
    expect(adapter.reactions).toEqual([{ conversationId: "1", messageId: 88, emoji: "🫡", options: { isBig: true } }]);
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
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
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
      { conversationId: "1", messageId: "1", emoji: "🫡", options: { isBig: true } },
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
    const image = agent.sent[0]?.options?.attachments?.[0];
    expect(image?.type).toBe("localImage");
    const imagePath = image?.type === "localImage" ? image.path : undefined;
    expect(imagePath).toContain(join(path, ".agent-relay", "media", "incoming"));
    expect(existsSync(imagePath!)).toBe(true);
    expect(readFileSync(join(path, ".agent-relay", ".gitignore"), "utf8")).toBe("*\n");
    expect(image?.type === "localImage" ? image.caption : undefined).toBe("inspect this");
  });

  test("photo captions can start the first Plan turn immediately", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.downloads.set("photo-large", new Uint8Array([1, 2, 3]).buffer);

    await router.handle(mediaMessage("/plan inspect this layout"));

    expect(store.getCollaborationMode("codex:1:demo")).toBe("plan");
    expect(agent.sent[0]?.text).toBe("inspect this layout");
    expect(agent.sent[0]?.options?.collaborationMode).toBe("plan");
    expect(agent.sent[0]?.options?.attachments).toHaveLength(1);
    expect(agent.sent[0]?.options?.attachments?.[0]?.type).toBe("localImage");
  });

  test("photo prompt without caption is saved and asks how to handle it", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(mediaMessage());

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toBe("Received an image.");
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    expect(adapter.sent.at(-1)?.options?.forceReplyInstruction).toBe("Reply to this prompt, or send your next message with what you want Codex to do.");
    expect(adapter.sent.at(-1)?.options?.inputFieldPlaceholder).toBe("What should Codex do?");
    const promptId = adapter.sent.at(-1)?.messageId!;
    const pending = store.getPendingPrompt("1", promptId);
    expect(pending?.kind).toBe("media_action");
    const payload = JSON.parse(pending!.payloadJson!);
    expect(payload.kind).toBe("image");
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].path).toContain(join(path, ".agent-relay", "media", "incoming"));
    expect(existsSync(payload.images[0].path)).toBe(true);
    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBeUndefined();

    await router.handle(textMessage("extract the text", 7, promptId));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.text).toBe("extract the text");
    expect(agent.sent[0]?.options?.attachments?.[0]).toMatchObject({ type: "localImage", path: payload.images[0].path });
    expect(store.getPendingPrompt("1", promptId)).toBeUndefined();
  });

  test("photo prompt without caption accepts the next normal message in the same scope", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(mediaMessage());
    const promptId = adapter.sent.at(-1)?.messageId!;
    const payload = JSON.parse(store.getPendingPrompt("1", promptId)!.payloadJson!);

    await router.handle(textMessage("extract the text"));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.text).toBe("extract the text");
    expect(agent.sent[0]?.options?.attachments?.[0]).toMatchObject({ type: "localImage", path: payload.images[0].path });
    expect(store.getPendingPrompt("1", promptId)).toBeUndefined();
  });

  test("managed prompt replies with Lark reply roots route back to the original base scope", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(mediaMessage());
    const promptId = adapter.sent.at(-1)?.messageId!;
    const payload = JSON.parse(store.getPendingPrompt("1", promptId)!.payloadJson!);

    await router.handle({ ...textMessage("describe it", 7, undefined, "1"), replyRootMessageId: promptId });

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.key).toBe("codex:1:demo");
    expect(agent.sent[0]?.options?.attachments?.[0]).toMatchObject({ type: "localImage", path: payload.images[0].path });
    expect(store.getPendingPrompt("1", promptId)).toBeUndefined();
  });

  test("media group without caption asks once and submits all images after reply", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle({ ...mediaMessage(), id: "1", messageId: "1", mediaGroupId: "album-1" });
    await router.handle({ ...mediaMessage(), id: "2", messageId: "2", mediaGroupId: "album-1" });
    await sleep(MEDIA_GROUP_QUIET_MS + 50);

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Received 2 images.");
    const promptId = adapter.sent.at(-1)?.messageId!;
    const pending = store.getPendingPrompt("1", promptId);
    const payload = JSON.parse(pending!.payloadJson!);
    expect(payload.images).toHaveLength(2);

    await router.handle(textMessage("compare these screenshots", 7, promptId));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.text).toBe("compare these screenshots");
    expect(agent.sent[0]?.options?.attachments).toHaveLength(2);
    expect(agent.sent[0]?.options?.attachments?.every((attachment) => attachment.type === "localImage")).toBe(true);
  });

  test("file prompt is saved under relay files and sent as a structured mention", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.downloads.set("file-doc", new TextEncoder().encode("hello").buffer);

    await router.handle(fileMessage("inspect file"));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.key).toBe("codex:1:demo");
    expect(agent.sent[0]?.text).toBe("inspect file");
    const mention = agent.sent[0]?.options?.attachments?.[0];
    expect(mention?.type).toBe("mention");
    expect(mention?.type === "mention" ? mention.name : undefined).toBe("file.txt");
    expect(mention?.type === "mention" ? mention.path : undefined).toContain(join(path, ".agent-relay", "files", "incoming"));
    expect(existsSync(join(path, ".agent-relay", ".gitignore"))).toBe(true);
    const incomingDayDirs = readdirSync(join(path, ".agent-relay", "files", "incoming"));
    expect(incomingDayDirs).toHaveLength(1);
  });

  test("file prompt without caption is saved and asks how to handle it", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.downloads.set("file-doc", new TextEncoder().encode("hello").buffer);

    await router.handle(fileMessage());

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Received file: file.txt");
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
    const promptId = adapter.sent.at(-1)?.messageId!;
    const pending = store.getPendingPrompt("1", promptId);
    expect(pending?.kind).toBe("media_action");
    const payload = JSON.parse(pending!.payloadJson!);
    expect(payload.kind).toBe("file");
    expect(payload.path).toContain(join(path, ".agent-relay", "files", "incoming"));
    expect(existsSync(payload.path)).toBe(true);

    await router.handle(textMessage("summarize this file", 7, promptId));

    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.text).toBe("summarize this file");
    expect(agent.sent[0]?.options?.attachments?.[0]).toEqual({ type: "mention", name: "file.txt", path: payload.path });
    expect(store.getPendingPrompt("1", promptId)).toBeUndefined();
  });

  test("audio is downloaded and sent as localAudio, with ForceReply when caption is absent", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    adapter.downloads.set("voice-1", new Uint8Array([1, 2, 3]).buffer);

    await router.handle(audioMessage("transcribe this"));
    expect(agent.sent[0]?.text).toBe("transcribe this");
    const audio = agent.sent[0]?.options?.attachments?.[0];
    expect(audio?.type).toBe("localAudio");
    expect(audio?.type === "localAudio" ? audio.path : undefined).toContain(join(path, ".agent-relay", "files", "incoming"));

    agent.statuses.get("codex:1:demo")!.activeTurnId = undefined;
    await router.handle({ ...audioMessage(), id: "2", messageId: "2" });
    expect(adapter.sent.at(-1)?.text).toContain("Received audio:");
    expect(adapter.sent.at(-1)?.options?.forceReply).toBe(true);
  });

  test("/skills pages choices and submits the selected structured skill", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.skills = Array.from({ length: 10 }, (_, index) => ({ name: `skill-${index}`, path: join(root, `skill-${index}`, "SKILL.md"), description: `Description ${index}`, enabled: true }));

    await router.handle(textMessage("/skills"));
    const picker = adapter.sent.at(-1)!;
    const next = picker.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Next")!;
    await router.handle(callbackMessage(next.callback_data, 7, "skill-page", picker.messageId));
    const select = adapter.edited.at(-1)!.options.replyMarkup!.inline_keyboard.flat().find((button) => button.text === "skill-8")!;
    await router.handle(callbackMessage(select.callback_data, 7, "skill-select", picker.messageId));
    const taskPrompt = adapter.sent.at(-1)!;
    expect(taskPrompt.options?.forceReply).toBe(true);
    await router.handle(textMessage("use it", 7, taskPrompt.messageId));

    expect(agent.sent.at(-1)?.options?.attachments).toEqual([{ type: "skill", name: "skill-8", path: join(root, "skill-8", "SKILL.md") }]);
  });

  test("/mention uses fuzzy search and rejects results outside the workspace", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    const readme = join(path, "README.md");
    writeFileSync(readme, "hello");
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.fileSearchResults = [
      { root: path, path: "README.md", fileName: "README.md", score: 10 },
      { root, path: "outside.txt", fileName: "outside.txt", score: 9 },
    ];

    await router.handle(textMessage("/mention read"));
    expect(agent.fileSearches[0]).toMatchObject({ workspacePath: path, query: "read" });
    const picker = adapter.sent.at(-1)!;
    expect(picker.options?.replyMarkup?.inline_keyboard.flat().some((button) => button.text.includes("outside"))).toBe(false);
    const select = picker.options?.replyMarkup?.inline_keyboard[0]![0]!;
    await router.handle(callbackMessage(select.callback_data, 7, "mention-select", picker.messageId));
    const taskPrompt = adapter.sent.at(-1)!;
    await router.handle(textMessage("summarize", 7, taskPrompt.messageId));

    expect(agent.sent.at(-1)?.options?.attachments).toEqual([{ type: "mention", name: "README.md", path: readme }]);
  });

  test("activity mirrors the Codex TUI hierarchy in one editable card", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.capabilities = { threadGoals: true };
    agent.goal = { threadId: "thread-1", objective: "Ship safely", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    await router.handle(textMessage("/plan work"));
    const key = "codex:1:demo";
    expect(agent.goalGets).toEqual([key]);
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: "r1", activity: { kind: "reasoning", summary: "Earlier reasoning", sectionIndex: 0 } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: "r1", activity: { kind: "reasoning", summary: `Current reasoning ${"r".repeat(500)}`, sectionIndex: 1 } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "plan", steps: Array.from({ length: 8 }, (_, index) => ({ step: `Step ${index} ${"x".repeat(180)}`, status: index === 2 ? "inProgress" as const : index < 2 ? "completed" as const : "pending" as const })) } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "diff", diff: "diff --git a/a b/a\n+changed" } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "settings", changes: { model: "old" } } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "settings", changes: { model: "new" } } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "notice", level: "warning", title: "Hidden warning" } });
    for (let index = 0; index < 7; index++) {
      await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: `item-${index}`, activity: { kind: "item", category: "fileChange", label: `Changed ${index} ${"y".repeat(180)}`, status: "completed", files: [{ path: join(path, `${"long-".repeat(25)}${index}.ts`), kind: "update" }] } });
    }
    await waitForStreamFlush();

    const cards = adapter.sent.filter((message) => message.text.startsWith("● Codex"));
    expect(cards).toHaveLength(1);
    const card = adapter.edited.at(-1) ?? cards[0]!;
    expect(card.text.length).toBeLessThanOrEqual(3000);
    expect(estimateImRows(card.text)).toBeLessThanOrEqual(18);
    expect(card.text).toContain("Mode Plan · ");
    expect(card.text).toContain("Goal Active · Ship safely");
    expect(card.text).toContain("Current reasoning");
    expect(card.text).not.toContain("Earlier reasoning");
    expect(card.text).toContain("Plan 2/8 · showing 1–5");
    for (let index = 0; index < 5; index++) expect(card.text).toContain(`Step ${index}`);
    expect(card.text).not.toContain("Step 5");
    expect(card.text).toContain("Recent activity · 7");
    expect(card.text).toContain("File changes (7)");
    expect(card.text).not.toContain("Files");
    expect(card.text).not.toContain("long-long-");
    expect(card.text).not.toContain("model: new");
    expect(card.text).not.toContain("Hidden warning");
    expect(card.text).not.toContain("+changed");
    expect(card.options?.replyMarkup).toEqual({ inline_keyboard: [] });
    const boldLabels = (card.options?.entities ?? [])
      .filter((entity) => entity.type === "bold")
      .map((entity) => card.text.slice(entity.offset, entity.offset + entity.length));
    expect(boldLabels).toEqual(["● Codex · Working", "Reasoning", "Plan 2/8 · showing 1–5", "Recent activity · 7"]);

    await router.handle(textMessage("/goal pause"));
    expect(adapter.edited.at(-1)?.text).toContain("Goal Paused · Ship safely");

    await router.handleAgentOutput({ type: "turn_completed", sessionKey: key, turnId: "turn-1", status: "completed", durationMs: 20 });
    expect(adapter.edited.at(-1)?.text.startsWith("✓ Codex · Completed")).toBe(true);
    expect(adapter.edited.at(-1)?.text).toContain("Mode Plan · 0s");
    expect(adapter.edited.at(-1)?.options.replyMarkup).toEqual({ inline_keyboard: [] });
    expect(store.latestTranscriptEvent("1", "demo", "system")?.text).toContain("[Activity done:");

    await router.handle(textMessage("/relay"));
    const home = adapter.sent.at(-1)!;
    expect(home.text).toContain("Relay Home");
    expect(home.text).not.toContain("Error:");
  });

  test("activity edit failures create one button-free replacement card", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("work"));
    const key = "codex:1:demo";
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: "command-1", activity: { kind: "item", category: "command", label: "Run tests", status: "completed" } });
    await waitForStreamFlush();
    const first = adapter.sent.find((message) => message.text.startsWith("● Codex"))!;
    expect(first.options?.replyMarkup).toEqual({ inline_keyboard: [] });
    adapter.failEditMessage = new Error("cannot edit");
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: "command-1", activity: { kind: "item", category: "command", label: "Run tests", status: "failed", detail: "Exit 1" } });
    const cards = adapter.sent.filter((message) => message.text.startsWith("● Codex"));
    expect(cards).toHaveLength(2);
    expect(cards.at(-1)?.text).toContain("× Run tests · Exit 1");
    expect(cards.at(-1)?.options?.replyMarkup).toEqual({ inline_keyboard: [] });

    await router.handleAgentOutput({ type: "thread_lifecycle", sessionKey: key, threadId: "thread-1", action: "closed" });
    expect(adapter.sent.filter((message) => message.text.startsWith("● Codex"))).toHaveLength(2);
  });

  test("activity keeps a current-centered plan window within the IM row budget", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("work"));
    const key = "codex:1:demo";
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "plan", steps: Array.from({ length: 31 }, (_, index) => ({ step: `Step ${index} ${"x".repeat(400)}`, status: index === 3 ? "inProgress" as const : index < 3 ? "completed" as const : "pending" as const })) } });
    await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: "reasoning", activity: { kind: "reasoning", summary: "r".repeat(800), sectionIndex: 0 } });
    for (let index = 0; index < 12; index++) {
      await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", itemId: `activity-${index}`, activity: { kind: "item", category: "command", label: `Activity ${index} ${"y".repeat(400)}`, status: "completed" } });
    }
    await waitForStreamFlush();

    const card = adapter.edited.at(-1) ?? adapter.sent.find((message) => message.text.startsWith("● Codex"))!;
    expect(card.text.length).toBeLessThanOrEqual(3000);
    expect(estimateImRows(card.text)).toBeLessThanOrEqual(18);
    expect(card.text).toContain("Plan 3/31 · showing 2–6");
    for (let index = 1; index <= 5; index++) expect(card.text).toContain(`Step ${index}`);
    expect(card.text).not.toContain("Step 0");
    expect(card.text).not.toContain("Step 6");
    expect(card.text).toContain("Recent activity · 12");
    expect(card.options?.replyMarkup).toEqual({ inline_keyboard: [] });
  });

  test("activity derives Goal mode, exposes waiting phases, and keeps CJK and emoji content bounded", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    agent.capabilities = { threadGoals: true };
    await router.handle(textMessage("work"));
    const key = "codex:1:demo";
    agent.goal = { threadId: "thread-1", objective: `安全发布🚀${"界".repeat(80)}`, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    await agent.getThreadGoal(key);
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: key,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning",
      activity: { kind: "reasoning", summary: `正在检查线程生命周期🧭${"状态".repeat(100)}` },
    });
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: key,
      threadId: "thread-1",
      turnId: "turn-1",
      activity: { kind: "plan", steps: Array.from({ length: 31 }, (_, index) => ({ step: `步骤${index} 🔧 ${"修复".repeat(40)}`, status: index === 15 ? "inProgress" as const : index < 15 ? "completed" as const : "pending" as const })) },
    });
    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: key,
      turnId: "turn-1",
      requestId: "question",
      questions: [{ id: "choice", header: "选择", question: "继续吗？", options: [{ label: "继续", description: "继续工作" }] }],
    });

    let activityCard = adapter.edited.filter((message) => message.text.includes("Codex ·")).at(-1)!;
    expect(activityCard.text).toContain("Codex · Waiting for input");
    expect(activityCard.text).toContain("Mode Goal");
    expect(activityCard.text).toContain("Reasoning");
    expect(activityCard.text).toContain("Plan 15/31");
    expect(activityCard.text.length).toBeLessThanOrEqual(3000);
    expect(estimateImRows(activityCard.text)).toBeLessThanOrEqual(18);

    await router.handleAgentOutput({
      type: "approval_request",
      sessionKey: key,
      turnId: "turn-1",
      requestId: "approval",
      method: "item/commandExecution/requestApproval",
      approvalKind: "command",
      title: "执行命令",
      body: "需要批准",
      params: {},
    });
    activityCard = adapter.edited.filter((message) => message.text.includes("Codex ·")).at(-1)!;
    expect(activityCard.text).toContain("Codex · Waiting for approval");
    expect(estimateImRows(activityCard.text)).toBeLessThanOrEqual(18);

    await router.handleAgentOutput({
      type: "turn_completed",
      sessionKey: key,
      turnId: "turn-1",
      status: "failed",
      error: { message: `执行失败⚠️${"错误详情".repeat(100)}` },
      durationMs: 64_000,
    });
    activityCard = adapter.edited.filter((message) => message.text.includes("Codex ·")).at(-1)!;
    expect(activityCard.text).toContain("× Codex · Failed");
    expect(activityCard.text).toContain("1m 04s");
    expect(activityCard.text).toContain("Error · 执行失败");
    expect(estimateImRows(activityCard.text)).toBeLessThanOrEqual(18);
  });

  test("activity falls back to plan progress and the current step when step structure cannot fit", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("work"));
    const key = "codex:1:demo";
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: key,
      turnId: "turn-1",
      activity: { kind: "plan", steps: Array.from({ length: 900 }, (_, index) => ({ step: `Current step ${index}`, status: index === 450 ? "inProgress" as const : index < 450 ? "completed" as const : "pending" as const })) },
    });
    await waitForStreamFlush();

    const card = adapter.sent.find((message) => message.text.startsWith("● Codex"))!;
    expect(card.text.length).toBeLessThanOrEqual(3000);
    expect(card.text).toContain("Plan 450/900");
    expect(card.text).toContain("→ Current step 450");
    expect(card.text).not.toContain("Current step 899");
  });

  for (const scenario of [
    { status: "interrupted" as const, header: "■ Codex · Interrupted" },
    { status: "failed" as const, header: "× Codex · Failed", error: "Command failed safely" },
  ]) {
    test(`activity renders the ${scenario.status} TUI status without details controls`, async () => {
      const { router, store, adapter, agent, root } = fixture();
      const path = join(root, "demo");
      mkdirSync(path);
      store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
      store.bindConversation(1, "demo");
      agent.capabilities = { threadGoals: true };
      await router.handle(textMessage("work"));
      const key = "codex:1:demo";
      await router.handleAgentOutput({ type: "activity", sessionKey: key, turnId: "turn-1", activity: { kind: "plan", steps: [{ step: "Inspect state", status: "inProgress" }] } });
      await waitForStreamFlush();
      await router.handleAgentOutput({
        type: "turn_completed",
        sessionKey: key,
        turnId: "turn-1",
        status: scenario.status,
        durationMs: 1250,
        ...(scenario.error ? { error: { message: scenario.error } } : {}),
      });

      const final = adapter.edited.at(-1)!;
      expect(final.text.startsWith(scenario.header)).toBe(true);
      expect(final.text).toContain("Mode Default · 1s");
      expect(final.text).toContain("Goal None");
      if (scenario.error) expect(final.text).toContain(`Error · ${scenario.error}`);
      else expect(final.text).not.toContain("Error ·");
      expect(final.options.replyMarkup).toEqual({ inline_keyboard: [] });

      await router.handle(textMessage("/relay"));
      const home = adapter.sent.at(-1)!;
      expect(home.text).toContain("Relay Home");
      if (scenario.error) {
        expect(home.text).toContain(`Error: ${scenario.error}`);
        expect(home.text).not.toContain("Error: Error:");
      } else {
        expect(home.text).not.toContain("Error:");
      }
    });
  }

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

  test("send_image capability resolves relative screenshot paths from cwd", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("debug h5"));
    writeFileSync(join(path, "screen.png"), new Uint8Array([1, 2, 3]));

    const result = await router.sendDebugImage({ path: "screen.png", cwd: path, caption: "home screen" });

    expect(result.path).toContain(join(path, ".agent-relay", "media", "outgoing"));
    expect(adapter.photos).toHaveLength(1);
    expect(adapter.photos[0]?.options).toEqual({ caption: "home screen", replyToMessageId: "1" });
  });

  test("send_file capability sends workspace file", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("make report"));
    const report = join(path, "report.txt");
    writeFileSync(report, "hello");

    const result = await router.sendDebugFile({ path: report, cwd: path, caption: "report" });

    expect(result.path).toContain(join(path, ".agent-relay", "files", "outgoing"));
    expect(adapter.files).toHaveLength(1);
    expect(adapter.files[0]?.options).toEqual({ filename: result.path.split(/[\\/]/).at(-1), caption: "report", replyToMessageId: "1" });
  });

  test("send_file capability resolves relative file paths from cwd", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("make report"));
    writeFileSync(join(path, "report.txt"), "hello");

    const result = await router.sendDebugFile({ path: "report.txt", cwd: path, caption: "report" });

    expect(result.path).toContain(join(path, ".agent-relay", "files", "outgoing"));
    expect(adapter.files).toHaveLength(1);
    expect(adapter.files[0]?.options).toEqual({ filename: result.path.split(/[\\/]/).at(-1), caption: "report", replyToMessageId: "1" });
  });

  test("send_file capability rejects paths outside workspace", async () => {
    const { router, store, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("make report"));
    const report = join(root, "outside.txt");
    writeFileSync(report, "hello");

    await expect(router.sendDebugFile({ path: report, cwd: path })).rejects.toThrow("inside the selected workspace");
  });

  test("send_image capability rejects relative paths escaping the workspace", async () => {
    const { router, store, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await router.handle(textMessage("debug h5"));
    writeFileSync(join(root, "outside.png"), new Uint8Array([1, 2, 3]));

    await expect(router.sendDebugImage({ path: "..\\outside.png", cwd: path })).rejects.toThrow("inside the selected workspace");
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

});
