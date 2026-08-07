import { describe, expect, test } from "bun:test";
import { noopLogger } from "../../src/domain/logger.ts";
import { MessageDeliveryUnknownError, type SendMessageOptions } from "../../src/ports/im.ts";
import { renderTelegramText } from "../../src/presentation/telegram/text.ts";
import { ActivityStreamer, type ActivitySessionContext } from "../../src/relay/activity-streamer.ts";
import { sleep } from "../support/fakes.ts";

describe("activity streamer lifecycle", () => {
  test("resume snapshots flush immediately and active snapshots keep the same card for live updates", async () => {
    const sent: string[] = [];
    const edited: string[] = [];
    const context: ActivitySessionContext = {
      threadId: "thread-a",
      threadName: "Saved work",
      collaborationMode: "default",
      goal: null,
      activeTurnId: "turn-a",
    };
    const streamer = activityStreamer(context, sent, edited, { quietMs: 10_000, minEditMs: 10_000, maxMs: 20_000 });

    await streamer.bootstrapResume({
      sessionKey: "codex:1:demo",
      conversationId: "1",
      workspaceName: "demo",
      workspacePath: "/demo",
      running: true,
      startedAt: 1,
      threadId: "thread-a",
      activeTurnId: "turn-a",
      latestTurn: {
        id: "turn-a",
        status: "inProgress",
        activities: [{ itemId: "command", activity: { kind: "item", category: "command", label: "Existing work", status: "inProgress" } }],
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Working");
    expect(sent[0]).toContain("Saved work");
    expect(sent[0]).toContain("Existing work");
    expect(sent[0]).not.toContain("Latest turn snapshot");

    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "Continue live", status: "inProgress" }] } });

    expect(sent).toHaveLength(1);
    expect(edited.at(-1)).toContain("Continue live");
  });

  test("resume snapshots render terminal, waiting, and empty-thread phases immediately", async () => {
    const cases = [
      { status: "completed" as const, expected: "Completed" },
      { status: "interrupted" as const, expected: "Interrupted" },
      { status: "failed" as const, expected: "Failed", error: { message: "resume boom" } },
    ];
    for (const entry of cases) {
      const sent: string[] = [];
      const context: ActivitySessionContext = { threadId: `thread-${entry.status}`, collaborationMode: "default", goal: null };
      const streamer = activityStreamer(context, sent, [], { quietMs: 10_000, minEditMs: 10_000, maxMs: 20_000 });
      await streamer.bootstrapResume({
        sessionKey: `codex:1:${entry.status}`,
        conversationId: "1",
        workspaceName: entry.status,
        workspacePath: "/demo",
        running: true,
        startedAt: 1,
        threadId: context.threadId,
        latestTurn: { id: `turn-${entry.status}`, status: entry.status, activities: [], durationMs: 2500, ...(entry.error ? { error: entry.error } : {}) },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(entry.expected);
      expect(sent[0]).not.toContain("Latest turn snapshot");
      if (entry.error) expect(sent[0]).toContain("resume boom");
    }

    for (const waitingCase of [
      { flag: "waitingForApproval" as const, expected: "Waiting for approval" },
      { flag: "waitingForUserInput" as const, expected: "Waiting for input" },
    ]) {
      const waitingSent: string[] = [];
      const waitingContext: ActivitySessionContext = { threadId: `thread-${waitingCase.flag}`, collaborationMode: "default", goal: null, activeTurnId: `turn-${waitingCase.flag}` };
      const waiting = activityStreamer(waitingContext, waitingSent, [], { quietMs: 10_000, minEditMs: 10_000, maxMs: 20_000 });
      await waiting.bootstrapResume({
        sessionKey: `codex:1:${waitingCase.flag}`,
        conversationId: "1",
        workspaceName: waitingCase.flag,
        workspacePath: "/demo",
        running: true,
        startedAt: 1,
        threadId: waitingContext.threadId,
        activeTurnId: waitingContext.activeTurnId,
        [waitingCase.flag]: true,
        latestTurn: { id: waitingContext.activeTurnId!, status: "inProgress", activities: [] },
      });
      expect(waitingSent[0]).toContain(waitingCase.expected);
      expect(waitingSent[0]).not.toContain("Latest turn snapshot");
    }

    const idleSent: string[] = [];
    const idleContext: ActivitySessionContext = { threadId: "thread-idle", collaborationMode: "default", goal: null };
    const idle = activityStreamer(idleContext, idleSent, [], { quietMs: 10_000, minEditMs: 10_000, maxMs: 20_000 });
    await idle.bootstrapResume({
      sessionKey: "codex:1:idle",
      conversationId: "1",
      workspaceName: "idle",
      workspacePath: "/demo",
      running: true,
      startedAt: 1,
      threadId: "thread-idle",
    });
    expect(idleSent).toHaveLength(1);
    expect(idleSent[0]).toContain("Idle");
    expect(idleSent[0]).toContain("No turns yet");
    expect(idleSent[0]).not.toContain("Latest turn snapshot");
  });

  test("no-turn metadata cannot create a card", async () => {
    const sent: string[] = [];
    const context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: null,
    };
    const streamer = activityStreamer(context, sent, []);

    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", activity: { kind: "goal", goal: null } });
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", activity: { kind: "item", category: "model", label: "Model rerouted", status: "completed" } });
    await sleep(10);

    expect(sent).toEqual([]);
  });

  test("routine edits are coalesced behind the minimum edit interval", async () => {
    const sent: string[] = [];
    const edited: string[] = [];
    const context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: null,
      activeTurnId: "turn-a",
    };
    const streamer = activityStreamer(context, sent, edited, { quietMs: 2, minEditMs: 30, maxMs: 60 });
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", itemId: "reason", activity: { kind: "reasoning", summary: "one" } });
    await sleep(8);
    expect(sent).toHaveLength(1);

    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", itemId: "reason", activity: { kind: "reasoning", summary: " two" } });
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", itemId: "command", activity: { kind: "item", category: "command", label: "Check", status: "completed" } });
    await sleep(12);
    expect(edited).toHaveLength(0);
    await sleep(25);
    expect(edited).toHaveLength(1);
    expect(edited[0]).toContain("one two");
    expect(edited[0]).toContain("Check");
  });

  test("invalidating an in-flight generation prevents it from owning the next thread card", async () => {
    const sent: string[] = [];
    const edited: string[] = [];
    let context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: null,
      activeTurnId: "turn-a",
    };
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sendCount = 0;
    const streamer = new ActivityStreamer({
      store: activityStore(),
      logger: noopLogger,
      canEdit: true,
      getReplyToMessageId: () => undefined,
      getSessionContext: () => context,
      sendRendered: async (_conversationId, rendered) => {
        sendCount += 1;
        if (sendCount === 1) {
          markStarted();
          await firstRelease;
        }
        sent.push(rendered.text);
        return { messageId: sendCount };
      },
      editRendered: async (_conversationId, rendered) => { edited.push(rendered.text); },
      timing: { quietMs: 1, minEditMs: 0, maxMs: 10 },
    });

    const firstHandle = streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "Old", status: "inProgress" }] } });
    await firstStarted;
    const invalidation = streamer.invalidateSession("codex:1:demo", false);
    releaseFirst();
    await Promise.all([firstHandle, invalidation]);

    context = { ...context, threadId: "thread-b", activeTurnId: "turn-b" };
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-b", turnId: "turn-b", activity: { kind: "plan", steps: [{ step: "New", status: "inProgress" }] } });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Old");
    expect(sent[1]).toContain("Chat thread-b");
    expect(sent[1]).toContain("New");
    expect(edited).toEqual([]);
  });

  test("updates arriving during a send are flushed after that send completes", async () => {
    const context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: null,
      activeTurnId: "turn-a",
    };
    const sent: string[] = [];
    const edited: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const sendRelease = new Promise<void>((resolve) => { release = resolve; });
    const streamer = new ActivityStreamer({
      store: activityStore(),
      logger: noopLogger,
      canEdit: true,
      getReplyToMessageId: () => undefined,
      getSessionContext: () => context,
      sendRendered: async (_conversationId, rendered) => {
        started();
        await sendRelease;
        sent.push(rendered.text);
        return { messageId: 1 };
      },
      editRendered: async (_conversationId, rendered) => { edited.push(rendered.text); },
      timing: { quietMs: 1, minEditMs: 0, maxMs: 10 },
    });

    const first = streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "Old", status: "inProgress" }] } });
    await sendStarted;
    const second = streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "New", status: "inProgress" }] } });
    release();
    await Promise.all([first, second]);

    expect(sent[0]).toContain("Old");
    expect(edited.at(-1)).toContain("New");
  });

  test("retiring a Goal-converted activity card preserves its synchronized body", async () => {
    let context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: { threadId: "thread-a", objective: "Old objective", status: "complete", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 1 },
      activeTurnId: "turn-a",
    };
    const edits: Array<{ text: string; messageId: string | number; buttons: unknown[] }> = [];
    let nextMessageId = 1;
    const streamer = new ActivityStreamer({
      store: activityStore(),
      logger: noopLogger,
      canEdit: true,
      getReplyToMessageId: () => undefined,
      getSessionContext: () => context,
      sendRendered: async () => ({ messageId: nextMessageId++ }),
      editRendered: async (_conversationId, rendered, options) => {
        edits.push({ text: rendered.text, messageId: options.messageId, buttons: options.replyMarkup?.inline_keyboard ?? [] });
      },
      timing: { quietMs: 1, minEditMs: 0, maxMs: 10 },
    });

    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "Old work", status: "inProgress" }] } });
    await streamer.finalize("codex:1:demo", "turn-a", "completed");
    await streamer.activateControlCard("codex:1:demo", "1", 1, renderTelegramText(["Goal current"]));

    context = { ...context, activeTurnId: "turn-b" };
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-b", activity: { kind: "plan", steps: [{ step: "New work", status: "inProgress" }] } });

    const retired = edits.filter((edit) => String(edit.messageId) === "1").at(-1)!;
    expect(retired.text).toBe("Goal current");
    expect(retired.buttons).toEqual([]);
  });

  test("does not resend a card after an at-most-once delivery becomes unknown", async () => {
    const context: ActivitySessionContext = {
      threadId: "thread-a",
      collaborationMode: "default",
      goal: null,
      activeTurnId: "turn-a",
    };
    const sendOptions: SendMessageOptions[] = [];
    let sendAttempts = 0;
    let transcriptCount = 0;
    const streamer = new ActivityStreamer({
      store: {
        ...activityStore(),
        appendTranscript: () => { transcriptCount += 1; },
      },
      logger: noopLogger,
      canEdit: true,
      getReplyToMessageId: () => undefined,
      getSessionContext: () => context,
      sendRendered: async (_conversationId, _rendered, options) => {
        sendAttempts += 1;
        sendOptions.push(options ?? {});
        throw new MessageDeliveryUnknownError("telegram", "sendMessage", new Error("socket closed"));
      },
      editRendered: async () => undefined,
      timing: { quietMs: 1, minEditMs: 0, maxMs: 10 },
    });

    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "plan", steps: [{ step: "Start", status: "inProgress" }] } });
    await streamer.handle({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-a", turnId: "turn-a", activity: { kind: "item", category: "command", label: "Continue", status: "completed" } });
    await sleep(15);
    await streamer.finalize("codex:1:demo", "turn-a", "completed");

    expect(sendAttempts).toBe(1);
    expect(sendOptions[0]?.deliveryMode).toBe("at-most-once");
    expect(transcriptCount).toBe(1);
  });
});

function activityStreamer(
  context: ActivitySessionContext,
  sent: string[],
  edited: string[],
  timing: { quietMs: number; minEditMs: number; maxMs: number } = { quietMs: 2, minEditMs: 0, maxMs: 10 },
): ActivityStreamer {
  return new ActivityStreamer({
    store: activityStore(),
    logger: noopLogger,
    canEdit: true,
    getReplyToMessageId: () => undefined,
    getSessionContext: () => context,
    sendRendered: async (_conversationId, rendered) => {
      sent.push(rendered.text);
      return { messageId: 1 };
    },
    editRendered: async (_conversationId, rendered) => { edited.push(rendered.text); },
    timing,
  });
}

function activityStore() {
  return {
    deletePagedOutputsForSession: () => undefined,
    appendTranscript: () => undefined,
    setPendingPrompt: () => undefined,
    deletePendingPrompt: () => undefined,
  };
}
