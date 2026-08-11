import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import type { AgentRelayControlSnapshotEvent } from "../../src/ports/agent.ts";
import { workspaceCallbackToken } from "../../src/relay/ui/callback-data.ts";
import { callbackMessage, cleanupRelayFixtures, relayFixture, textMessage, waitForStreamFlush } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

function experimentalFixture() {
  const result = relayFixture("info", { experimentalRelayWorkEnabled: true });
  const path = join(result.root, "demo");
  mkdirSync(path);
  result.store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
  result.store.bindConversation("1", "demo");
  return { ...result, path };
}

function addWorkspace(fixture: ReturnType<typeof experimentalFixture>, name: string) {
  const path = join(fixture.root, name);
  mkdirSync(path);
  fixture.store.upsertWorkspace({ name, path, createdAt: 2 });
  return path;
}

async function attachSharedScopes(fixture: ReturnType<typeof experimentalFixture>) {
  const { agent, store, path } = fixture;
  store.bindConversation("2", "demo");
  const firstKey = sessionKey("1", "demo");
  const secondKey = sessionKey("2", "demo");
  const first = await agent.start({ conversationId: "1", scopeKey: "1", workspaceName: "demo", workspacePath: path, threadId: "shared-thread" });
  const second = await agent.start({ conversationId: "2", scopeKey: "2", workspaceName: "demo", workspacePath: path, threadId: "shared-thread" });
  store.markSessionStarted(firstKey, "1", "demo", 1, first.threadId, "1");
  store.markSessionStarted(secondKey, "2", "demo", 1, second.threadId, "2");
  return { firstKey, secondKey };
}

function selectWorkspace(name: string, callbackQueryId = `select-${name}`) {
  return callbackMessage(`ar:uh:${workspaceCallbackToken(name)}`, 7, callbackQueryId);
}

describe("experimental relay work behavior", () => {
  test("keeps Relay Home and the command surface unchanged when the master gate is disabled", async () => {
    const { router, store, adapter, root } = relayFixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation("1", "demo");

    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).not.toContain("/attach");
    await router.handle(textMessage("/relay"));
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().some((button) => button.callback_data === "ar:r")).toBe(false);
    await router.handle(textMessage("/threads"));
    expect(adapter.sent.at(-1)?.text).toContain("Unknown command: /threads");
  });

  test("ordinary messages start fresh instead of attaching active or persisted threads", async () => {
    const { router, store, agent } = experimentalFixture();
    store.markSessionStarted(sessionKey("1", "demo"), "1", "demo", 1, "persisted-thread", "1");
    store.markSessionStopped(sessionKey("1", "demo"), 2);
    agent.threads = [
      { id: "idle-thread", status: "idle" },
      { id: "active-thread", name: "Desktop work", status: "active" },
    ];

    await router.handle(textMessage("continue from IM"));

    expect(agent.sent[0]?.key).toBe(sessionKey("1", "demo"));
    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).not.toBe("active-thread");
    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).not.toBe("persisted-thread");
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("thread-1");
  });

  test("idle workspace selection releases the old session and binds the directory without starting a thread", async () => {
    const fixture = experimentalFixture();
    const { router, store, adapter, agent, path } = fixture;
    addWorkspace(fixture, "other");
    const sourceKey = sessionKey("1", "demo");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "desktop-thread" });
    store.markSessionStarted(sourceKey, "1", "demo", 1, source.threadId, "1");

    await router.handle(selectWorkspace("other"));

    expect(store.getBinding("1")?.workspaceName).toBe("other");
    expect(agent.released).toEqual([sourceKey]);
    expect(agent.stopped).toEqual([]);
    expect(agent.getStatus(sourceKey)).toBeUndefined();
    expect(agent.getStatus(sessionKey("1", "other"))).toBeUndefined();
    expect(store.getSession(sourceKey)?.status).toBe("stopped");
    expect(store.getSession(sourceKey)?.thread_id).toBe("desktop-thread");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: other");
    expect(adapter.edited.at(-1)?.text).toContain("Stopped");
  });

  test("the first ordinary message after a workspace switch starts fresh", async () => {
    const fixture = experimentalFixture();
    const { router, store, agent, path } = fixture;
    const otherPath = addWorkspace(fixture, "other");
    const sourceKey = sessionKey("1", "demo");
    const targetKey = sessionKey("1", "other");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "source-thread" });
    store.markSessionStarted(sourceKey, "1", "demo", 1, source.threadId, "1");
    store.markSessionStarted(targetKey, "1", "other", 1, "persisted-other-thread", "1");
    store.markSessionStopped(targetKey, 2);

    await router.handle(selectWorkspace("other"));
    expect(agent.getStatus(targetKey)).toBeUndefined();

    await router.handle(textMessage("start work in other"));

    expect(agent.sent.at(-1)?.key).toBe(targetKey);
    expect(agent.getStatus(targetKey)?.workspacePath).toBe(otherPath);
    expect(agent.getStatus(targetKey)?.threadId).not.toBe("persisted-other-thread");
    expect(store.getSession(targetKey)?.thread_id).toBe(agent.getStatus(targetKey)?.threadId);
  });

  test("workspace switching rejects every busy state without changing the binding", async () => {
    const scenarios = ["turn", "approval", "user-input", "task"] as const;

    for (const scenario of scenarios) {
      const fixture = experimentalFixture();
      const { router, store, adapter, agent, path } = fixture;
      addWorkspace(fixture, "other");
      const sourceKey = sessionKey("1", "demo");
      const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: `thread-${scenario}` });
      store.markSessionStarted(sourceKey, "1", "demo", 1, source.threadId, "1");
      if (scenario === "turn") source.activeTurnId = "turn-active";
      if (scenario === "approval") source.waitingForApproval = true;
      if (scenario === "user-input") source.waitingForUserInput = true;
      if (scenario === "task") {
        store.createTask({ conversationId: "1", workspaceName: "demo", text: "queued work", status: "queued" });
      }

      await router.handle(selectWorkspace("other", `busy-${scenario}`));

      expect(store.getBinding("1")?.workspaceName).toBe("demo");
      expect(agent.getStatus(sourceKey)?.threadId).toBe(`thread-${scenario}`);
      expect(agent.released).toEqual([]);
      expect(adapter.edited.at(-1)?.text).toContain("Codex is busy.");
    }
  });

  test("selecting the current workspace is a no-op even while its turn is active", async () => {
    const { router, store, agent, path } = experimentalFixture();
    const key = sessionKey("1", "demo");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "same-thread" });
    source.activeTurnId = "active-turn";
    store.markSessionStarted(key, "1", "demo", 1, source.threadId, "1");
    store.setCollaborationMode(key, "plan");

    await router.handle(selectWorkspace("demo"));

    expect(store.getBinding("1")?.workspaceName).toBe("demo");
    expect(agent.getStatus(key)?.threadId).toBe("same-thread");
    expect(agent.getStatus(key)?.activeTurnId).toBe("active-turn");
    expect(store.getCollaborationMode(key)).toBe("plan");
    expect(agent.released).toEqual([]);
    expect(agent.stopped).toEqual([]);
  });

  test("a busy workspace consumes the create prompt without creating or selecting the directory", async () => {
    const { router, store, adapter, agent, root, path } = experimentalFixture();
    const key = sessionKey("1", "demo");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "busy-thread" });
    source.activeTurnId = "active-turn";
    store.markSessionStarted(key, "1", "demo", 1, source.threadId, "1");

    await router.handle(callbackMessage("ar:n", 7, "new-workspace"));
    const prompt = adapter.sent.at(-1)!;
    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeDefined();

    await router.handle(textMessage("other", 7, Number(prompt.messageId)));

    expect(store.getPendingPrompt("1", prompt.messageId!)).toBeUndefined();
    expect(existsSync(join(root, "other"))).toBe(false);
    expect(store.getBinding("1")?.workspaceName).toBe("demo");
    expect(agent.released).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Codex is busy.");
  });

  test("late events from the released workspace cannot update IM or transcript state", async () => {
    const fixture = experimentalFixture();
    const { router, store, adapter, agent, logLines, path } = fixture;
    addWorkspace(fixture, "other");
    const sourceKey = sessionKey("1", "demo");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "source-thread" });
    store.markSessionStarted(sourceKey, "1", "demo", 1, source.threadId, "1");
    await router.handle(selectWorkspace("other"));
    const sentCount = adapter.sent.length;
    const editedCount = adapter.edited.length;

    await router.handleAgentOutput({ type: "message", sessionKey: sourceKey, chunk: "late output" });
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: sourceKey,
      threadId: "source-thread",
      turnId: "late-turn",
      activity: { kind: "plan", steps: [{ step: "late", status: "inProgress" }] },
    });
    await router.handleAgentOutput({
      type: "user_input_request",
      sessionKey: sourceKey,
      turnId: "late-turn",
      requestId: "late-question",
      questions: [{
        id: "choice",
        header: "Choice",
        question: "Continue?",
        options: [{ label: "Yes", description: "Continue" }],
      }],
    });
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: sourceKey,
      threadId: "source-thread",
      itemId: "late-user",
      input: { text: "late shared input" },
    });
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: sourceKey, turnId: "late-turn" });

    expect(adapter.sent).toHaveLength(sentCount);
    expect(adapter.edited).toHaveLength(editedCount);
    expect(store.latestTranscriptEvent("1", "demo", "agent")).toBeUndefined();
    expect(store.latestTranscriptEvent("1", "demo", "user")).toBeUndefined();
    expect(store.latestPendingPrompt("1", ["codex_user_input"])).toBeUndefined();
    expect(logLines.join("\n")).toContain("router.agent_event_inactive_workspace");
  });

  test("a failure after release restores the source thread and collaboration mode", async () => {
    const fixture = experimentalFixture();
    const { router, store, agent, path } = fixture;
    addWorkspace(fixture, "other");
    const sourceKey = sessionKey("1", "demo");
    const source = await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path, threadId: "source-thread" });
    store.markSessionStarted(sourceKey, "1", "demo", 1, source.threadId, "1");
    store.setCollaborationMode(sourceKey, "plan");
    const bindConversation = store.bindConversation.bind(store);
    store.bindConversation = ((scopeKey, workspaceName, updatedAt, conversationId) => {
      if (workspaceName === "other") throw new Error("bind failed");
      bindConversation(scopeKey, workspaceName, updatedAt, conversationId);
    }) as typeof store.bindConversation;

    await router.handle(selectWorkspace("other", "rollback"));

    expect(agent.released).toEqual([sourceKey]);
    expect(store.getBinding("1")?.workspaceName).toBe("demo");
    expect(agent.getStatus(sourceKey)?.threadId).toBe("source-thread");
    expect(store.getSession(sourceKey)?.status).toBe("running");
    expect(store.getCollaborationMode(sourceKey)).toBe("plan");
  });

  test("Relay Home does not expose a Resume button when Relay Work is enabled", async () => {
    const { router, adapter } = experimentalFixture();
    await router.handle(textMessage("/relay"));
    const home = adapter.sent.at(-1)!;
    const buttons = home.options?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.some((button) => button.callback_data === "ar:r")).toBe(false);
    expect(buttons.some((button) => button.callback_data === "ar:stop")).toBe(true);
  });

  test("allows two IM scopes to resume the same thread", async () => {
    const { router, store, adapter, agent } = experimentalFixture();
    store.bindConversation("2", "demo");
    agent.threads = [{ id: "shared-thread", name: "Shared", status: "active" }];

    for (const conversationId of ["1", "2"]) {
      await router.handle(textMessage("/resume", 7, undefined, conversationId));
      const picker = adapter.sent.at(-1)!;
      const button = picker.options?.replyMarkup?.inline_keyboard.flat().find((candidate) => candidate.callback_data.startsWith("ar:cmd:resume:"));
      expect(button).toBeDefined();
      await router.handle(callbackMessage(button!.callback_data, 7, `cb-${conversationId}`, picker.messageId, conversationId));
    }

    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).toBe("shared-thread");
    expect(agent.getStatus(sessionKey("2", "demo"))?.threadId).toBe("shared-thread");
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("shared-thread");
    expect(store.getSession(sessionKey("2", "demo"))?.thread_id).toBe("shared-thread");
  });

  test("renders shared-thread user messages and records them as user transcript entries", async () => {
    const { router, store, adapter, agent, path } = experimentalFixture();
    const key = sessionKey("1", "demo");
    const status = await agent.start({ conversationId: "1", scopeKey: "1", workspaceName: "demo", workspacePath: path, threadId: "shared-thread" });
    store.markSessionStarted(key, "1", "demo", 1, status.threadId, "1");

    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: key,
      threadId: "shared-thread",
      turnId: "external-turn",
      itemId: "external-user",
      input: {
        text: "message from Codex Desktop",
        attachments: [
          { type: "localImage", path: "C:/tmp/screenshot.png" },
          { type: "audio", url: "https://example.test/audio.wav" },
        ],
      },
    });

    expect(adapter.sent.at(-1)?.text).toContain("User \u00b7 shared thread");
    expect(adapter.sent.at(-1)?.text).toContain("message from Codex Desktop");
    expect(adapter.sent.at(-1)?.text).toContain("[1 image, 1 audio attached]");
    expect(store.latestTranscriptEvent("1", "demo", "user")).toMatchObject({
      conversationId: "1",
      workspaceName: "demo",
      role: "user",
      text: "message from Codex Desktop\n[1 image, 1 audio attached]\n",
    });
  });

  test("mirrors IM formatting and user reply chains without the shared-thread title", async () => {
    const fixture = experimentalFixture();
    const { router, adapter, agent } = fixture;
    const { firstKey, secondKey } = await attachSharedScopes(fixture);

    await router.handle({
      kind: "message",
      id: "11",
      messageId: "11",
      conversationId: "1",
      userId: "7",
      text: "Bold and code",
      textPresentation: {
        format: "plain",
        entities: [
          { type: "bold", offset: 0, length: 4 },
          { type: "code", offset: 9, length: 4 },
        ],
      },
    });
    const firstClientId = agent.sent.at(-1)?.options?.clientUserMessageId;
    expect(firstClientId).toMatch(/^agent-relay:/);
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: secondKey,
      threadId: "shared-thread",
      turnId: "turn-one",
      itemId: "item-one",
      clientUserMessageId: firstClientId,
      input: { text: "Bold and code" },
    });
    const firstCopy = adapter.sent.at(-1)!;
    expect(firstCopy.conversationId).toBe("2");
    expect(firstCopy.text).toBe("Bold and code");
    expect(firstCopy.text).not.toContain("User · shared thread");
    expect(firstCopy.options?.entities).toEqual([
      { type: "bold", offset: 0, length: 4 },
      { type: "code", offset: 9, length: 4 },
    ]);

    await router.handle({
      kind: "message",
      id: "12",
      messageId: "12",
      conversationId: "1",
      userId: "7",
      text: "follow up",
      replyToMessageId: "11",
    });
    const replyClientId = agent.sent.at(-1)?.options?.clientUserMessageId;
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: secondKey,
      threadId: "shared-thread",
      turnId: "turn-two",
      itemId: "item-two",
      clientUserMessageId: replyClientId,
      input: { text: "follow up" },
    });
    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBe(firstCopy.messageId);

    await router.handle({
      kind: "message",
      id: "21",
      messageId: "21",
      conversationId: "2",
      userId: "7",
      text: "reply from the mirror",
      replyToMessageId: firstCopy.messageId,
    });
    const reverseClientId = agent.sent.at(-1)?.options?.clientUserMessageId;
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: firstKey,
      threadId: "shared-thread",
      turnId: "turn-three",
      itemId: "item-three",
      clientUserMessageId: reverseClientId,
      input: { text: "reply from the mirror" },
    });
    expect(adapter.sent.at(-1)?.conversationId).toBe("1");
    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBe("11");
  });

  test("summarizes IM attachments as text without copying their payloads", async () => {
    const fixture = experimentalFixture();
    const { router, adapter, agent } = fixture;
    const { secondKey } = await attachSharedScopes(fixture);

    await router.handle({
      kind: "file",
      id: "41",
      messageId: "41",
      conversationId: "1",
      userId: "7",
      caption: "inspect this",
      file: { fileId: "file-41", fileName: "report.pdf", mimeType: "application/pdf", fileSize: 12 },
    });
    const sent = agent.sent.at(-1)!;
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: secondKey,
      threadId: "shared-thread",
      turnId: "file-turn",
      itemId: "file-item",
      clientUserMessageId: sent.options?.clientUserMessageId,
      input: { text: sent.text, attachments: sent.options?.attachments },
    });

    expect(adapter.sent.at(-1)?.text).toBe("inspect this\n[1 file attached]");
    expect(adapter.photos).toHaveLength(0);
    expect(adapter.files).toHaveLength(0);
  });

  test("maps assistant replies across scopes and makes mirrored input the local reply target", async () => {
    const fixture = experimentalFixture();
    const { router, adapter, agent } = fixture;
    const { firstKey, secondKey } = await attachSharedScopes(fixture);

    await router.handle({ kind: "message", id: "31", messageId: "31", conversationId: "1", userId: "7", text: "start" });
    const clientUserMessageId = agent.sent.at(-1)?.options?.clientUserMessageId;
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: secondKey,
      threadId: "shared-thread",
      turnId: "answer-turn",
      itemId: "start-item",
      clientUserMessageId,
      input: { text: "start" },
    });
    const mirroredUserMessageId = adapter.sent.at(-1)?.messageId;

    await router.handleAgentOutput({ type: "message", sessionKey: firstKey, chunk: "answer", turnId: "answer-turn", itemId: "answer-item" });
    await router.handleAgentOutput({ type: "message", sessionKey: secondKey, chunk: "answer", turnId: "answer-turn", itemId: "answer-item" });
    await waitForStreamFlush();
    const firstAnswer = adapter.sent.find((message) => message.conversationId === "1" && message.text === "answer");
    const secondAnswer = adapter.sent.find((message) => message.conversationId === "2" && message.text === "answer");
    expect(firstAnswer?.options?.replyToMessageId).toBe("31");
    expect(secondAnswer?.options?.replyToMessageId).toBe(mirroredUserMessageId);

    await router.handle({
      kind: "message",
      id: "32",
      messageId: "32",
      conversationId: "1",
      userId: "7",
      text: "about that answer",
      replyToMessageId: firstAnswer?.messageId,
    });
    const replyClientId = agent.sent.at(-1)?.options?.clientUserMessageId;
    await router.handleAgentOutput({
      type: "user_message",
      sessionKey: secondKey,
      threadId: "shared-thread",
      turnId: "next-turn",
      itemId: "reply-item",
      clientUserMessageId: replyClientId,
      input: { text: "about that answer" },
    });
    expect(adapter.sent.at(-1)?.options?.replyToMessageId).toBe(secondAnswer?.messageId);
  });

  test("applies shared Relay thread mode without changing the transcript", async () => {
    const { router, store, agent, path } = experimentalFixture();
    const key = sessionKey("1", "demo");
    const status = await agent.start({ conversationId: "1", scopeKey: "1", workspaceName: "demo", workspacePath: path, threadId: "shared-thread" });
    store.markSessionStarted(key, "1", "demo", 1, status.threadId, "1");

    await router.handleAgentOutput({
      type: "relay_thread_state",
      sessionKey: key,
      gatewayEpoch: "epoch-1",
      threadRevision: 1,
      threadId: "shared-thread",
      collaborationMode: "plan",
      collaborationModeApplied: false,
      revision: 1,
      updatedAt: 10,
    });
    expect(store.getCollaborationMode(key)).toBe("plan");
    expect(store.getPendingCollaborationMode(key)).toBe("plan");

    expect(store.latestTranscriptEvent("1", "demo", "user")).toBeUndefined();
    expect(store.latestTranscriptEvent("1", "demo", "agent")).toBeUndefined();
  });

  test("renders an in-memory Relay control snapshot as one summary card", async () => {
    const { router, store, adapter, agent, path } = experimentalFixture();
    const key = sessionKey("1", "demo");
    const status = await agent.start({ conversationId: "1", scopeKey: "1", workspaceName: "demo", workspacePath: path, threadId: "shared-thread" });
    store.markSessionStarted(key, "1", "demo", 1, status.threadId, "1");

    const snapshot = {
      type: "relay_control_snapshot",
      sessionKey: key,
      threadId: "shared-thread",
      gatewayEpoch: "epoch-1",
      revision: 3,
      consistency: "live",
      threadState: {
        threadId: "shared-thread",
        collaborationMode: "plan",
        collaborationModeApplied: true,
        revision: 2,
        updatedAt: 20,
      },
      commands: [{
        commandId: "review-1",
        threadId: "shared-thread",
        kind: "review",
        phase: "completed",
        source: "codex",
        revision: 3,
        createdAt: 10,
        updatedAt: 30,
      }],
    } satisfies AgentRelayControlSnapshotEvent;
    await router.handleAgentOutput(snapshot);
    const sentAfterFirstSnapshot = adapter.sent.length;
    await router.handleAgentOutput(snapshot);

    expect(store.getCollaborationMode(key)).toBe("plan");
    expect(adapter.sent.at(-1)?.text).toContain("Shared Relay state");
    expect(adapter.sent.at(-1)?.text).toContain("/review: Completed");
    expect(adapter.sent).toHaveLength(sentAfterFirstSnapshot);
  });

  test("removes the legacy thread commands even when Relay Work is enabled", async () => {
    const { router, adapter } = experimentalFixture();

    for (const command of ["/threads", "/attach shared-thread", "/detach"]) {
      await router.handle(textMessage(command));
      expect(adapter.sent.at(-1)?.text).toContain(`Unknown command: ${command.split(" ")[0]}`);
    }

    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).not.toContain("/threads");
    expect(adapter.sent.at(-1)?.text).not.toContain("/attach");
    expect(adapter.sent.at(-1)?.text).not.toContain("/detach");
  });
});
