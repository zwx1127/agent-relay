import { describe, expect, test } from "bun:test";
import { noopLogger } from "../../src/domain/logger.ts";
import { renderTelegramText } from "../../src/presentation/telegram/text.ts";
import { ActivityStreamer, type ActivitySessionContext } from "../../src/relay/activity-streamer.ts";
import { sleep } from "../support/fakes.ts";

describe("activity streamer lifecycle", () => {
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
