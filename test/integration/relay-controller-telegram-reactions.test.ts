import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextLogger } from "../../src/domain/logger.ts";
import { TelegramAdapter } from "../../src/providers/im/telegram/adapter.ts";
import { RelayController } from "../../src/relay/controller.ts";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";
import { FakeAgent } from "../support/fakes.ts";
import { relayTestConfig, textMessage } from "../support/relay-fixture.ts";

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
});

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
  const adapter = new TelegramAdapter("token", async (url, init) => {
    const method = String(url).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method, body, activeSessionCount: agent.statuses.size });
    return Response.json({ ok: true, result: method === "setMessageReaction" ? reactionResult : true });
  }, logger, { requestRetryMaxAttempts: 1 });
  const router = new RelayController({
    config: relayTestConfig(root),
    store,
    adapter,
    agent,
    logger,
  });
  return { router, store, agent, requests, logLines };
}
