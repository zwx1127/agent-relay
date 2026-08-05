import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextLogger } from "../../src/domain/logger.ts";
import { TelegramAdapter } from "../../src/providers/im/telegram/adapter.ts";
import { RelayController } from "../../src/relay/controller.ts";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";
import { FakeAgent } from "../support/fakes.ts";
import { callbackMessage, relayTestConfig, textMessage } from "../support/relay-fixture.ts";

interface TelegramRequest {
  method: string;
  body: Record<string, unknown>;
  activeSessionCount: number;
}

const stores: SQLiteStore[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("relay controller Telegram reactions", () => {
  test("routes receipt and task status reactions through the production Telegram adapter", async () => {
    const { router, store, agent, requests, logLines } = productionFixture(true);

    await router.handle(textMessage("run task"));
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });

    expect(agent.sent).toEqual([{ key: "codex:1:demo", text: "run task", options: { collaborationMode: "default" } }]);
    expect(store.getTask(1)?.status).toBe("done");
    const reactionRequests = requests.filter((request) => request.method === "setMessageReaction");
    expect(reactionRequests.map((request) => request.activeSessionCount)).toEqual([0, 1, 1]);
    expect(reactionRequests.map((request) => request.body)).toEqual([
      {
        chat_id: "1",
        message_id: 1,
        reaction: [{ type: "emoji", emoji: "🫡" }],
        is_big: true,
      },
      {
        chat_id: "1",
        message_id: 1,
        reaction: [{ type: "emoji", emoji: "✍" }],
      },
      {
        chat_id: "1",
        message_id: 1,
        reaction: [{ type: "emoji", emoji: "😎" }],
      },
    ]);
    expect(logLines.filter((line) => line.includes("router.task_reaction_applied"))).toHaveLength(3);
  });

  test("continues task submission when Telegram does not confirm a reaction", async () => {
    const { router, store, agent, logLines } = productionFixture(false);

    await router.handle(textMessage("run task"));

    expect(agent.sent).toHaveLength(1);
    expect(store.getTask(1)?.status).toBe("running");
    expect(logLines.join("\n")).toContain("router.task_reaction_failed");
    expect(logLines.join("\n")).toContain("did not confirm success");
  });

  test("keeps only the latest Telegram Activity or Goal card interactive", async () => {
    const { router, agent, requests } = productionFixture(true);
    await router.handle({ ...textMessage("restart service"), id: "10", messageId: "10" });
    const key = "codex:1:demo";
    const status = agent.getStatus(key)!;
    agent.goal = { threadId: status.threadId!, objective: "Old objective", status: "complete", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 1 };
    status.threadGoal = agent.goal;
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: key,
      threadId: status.threadId,
      turnId: "turn-1",
      activity: { kind: "plan", steps: [{ step: "Restart service", status: "inProgress" }] },
    });
    status.activeTurnId = undefined;
    await router.handleAgentOutput({ type: "turn_completed", sessionKey: key, turnId: "turn-1" });

    const activitySend = requests.find((request) => request.method === "sendMessage" && String(request.body.text).includes("Restart service"))!;
    const sourceMessageId = 500;
    const activityControls = requests.find((request) => request.method === "editMessageReplyMarkup" && request.body.message_id === sourceMessageId)!;
    const activityEdit = requests.filter((request) => request.method === "editMessageText" && request.body.message_id === sourceMessageId).at(-1)!;
    const editData = callbackData(activityEdit.body, "Edit");
    await router.handle(callbackMessage(editData, 7, "cb-production-edit", sourceMessageId));
    const editPrompt = requests.filter((request) => request.method === "sendMessage" && hasForceReply(request.body)).at(-1)!;
    const retiredSourceIndex = requests.findLastIndex((request) => request.method === "editMessageText" && request.body.message_id === sourceMessageId);
    const retiredSource = requests[retiredSourceIndex]!;
    expect(activitySend.body.reply_parameters).toEqual({ message_id: 10, allow_sending_without_reply: true });
    expect(activitySend.body.reply_markup).toBeUndefined();
    expect(callbackData(activityControls.body, "Interrupt")).toContain("ar:cmd:activity:");
    expect(editPrompt.body.reply_markup).toMatchObject({ force_reply: true });
    expect(String(retiredSource.body.text)).toBe(String(activityEdit.body.text));
    expect(retiredSource.body.reply_markup).toEqual({ inline_keyboard: [] });

    await router.handle(textMessage("Replacement objective", 7, 501));
    expect(requests.some((request) => request.method === "deleteMessage" && request.body.message_id === 501)).toBe(true);
    expect(requests.slice(retiredSourceIndex + 1).filter((request) => request.method === "editMessageText" && request.body.message_id === sourceMessageId)).toEqual([]);

    status.activeTurnId = "turn-2";
    await router.handleAgentOutput({
      type: "activity",
      sessionKey: key,
      threadId: status.threadId,
      turnId: "turn-2",
      activity: { kind: "plan", steps: [{ step: "New work", status: "inProgress" }] },
    });
    const newest = requests.filter((request) => request.method === "sendMessage" && String(request.body.text).includes("New work")).at(-1)!;
    expect(String(newest.body.text)).toContain("Goal Active");
    const newestMessageId = 502;
    const newestControls = requests.filter((request) => request.method === "editMessageReplyMarkup" && request.body.message_id === newestMessageId).at(-1)!;
    expect(newest.body.reply_markup).toBeUndefined();
    const clearData = callbackData(newestControls.body, "Clear");
    await router.handle(callbackMessage(clearData, 7, "cb-production-clear", newestMessageId));
    const cleared = requests.filter((request) => request.method === "sendMessage" && String(request.body.text).includes("Goal cleared.")).at(-1)!;
    expect(cleared.body.reply_markup).toMatchObject({ inline_keyboard: [[{ text: "Interrupt" }]] });
    const retiredNewest = requests.filter((request) => request.method === "editMessageText" && request.body.message_id === newestMessageId).at(-1)!;
    expect(String(retiredNewest.body.text)).toBe(String(newest.body.text));
    expect(retiredNewest.body.reply_markup).toEqual({ inline_keyboard: [] });
    const laterSourceEdits = requests.slice(retiredSourceIndex + 1).filter((request) => request.method === "editMessageText" && request.body.message_id === sourceMessageId);
    expect(laterSourceEdits).toEqual([]);
  });
});

function callbackData(body: Record<string, unknown>, label: string): string {
  const markup = body.reply_markup as { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined;
  const button = markup?.inline_keyboard?.flat().find((candidate) => candidate.text === label);
  if (!button?.callback_data) throw new Error(`Missing ${label} callback data.`);
  return button.callback_data;
}

function hasForceReply(body: Record<string, unknown>): boolean {
  return Boolean((body.reply_markup as { force_reply?: boolean } | undefined)?.force_reply);
}

function productionFixture(reactionResult: boolean): {
  router: RelayController;
  store: SQLiteStore;
  agent: FakeAgent;
  requests: TelegramRequest[];
  logLines: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-telegram-reactions-"));
  roots.push(root);
  const workspacePath = join(root, "demo");
  mkdirSync(workspacePath);
  const store = new SQLiteStore(":memory:");
  stores.push(store);
  store.upsertWorkspace({ name: "demo", path: workspacePath, createdAt: 1 });
  store.bindConversation("1", "demo");

  const requests: TelegramRequest[] = [];
  const logLines: string[] = [];
  const logger = new TextLogger("info", (line) => logLines.push(line), () => new Date("2026-08-03T04:00:00.000Z"));
  const agent = new FakeAgent();
  let nextMessageId = 500;
  const adapter = new TelegramAdapter("token", async (url, init) => {
    const method = String(url).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method, body, activeSessionCount: agent.statuses.size });
    const result = method === "setMessageReaction"
      ? reactionResult
      : method === "sendMessage"
        ? { message_id: nextMessageId++ }
        : true;
    return Response.json({ ok: true, result });
  }, logger, { requestRetryMaxAttempts: 1 });
  const router = new RelayController({
    config: relayTestConfig(root),
    store,
    adapter,
    agent,
    logger,
    streamTiming: { quietMs: 1 },
  });
  return { router, store, agent, requests, logLines };
}
