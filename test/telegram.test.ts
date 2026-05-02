import { describe, expect, test } from "bun:test";
import { TelegramAdapter } from "../src/telegram.ts";

describe("telegram adapter", () => {
  test("routes long polling text messages", async () => {
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: calls === 1
          ? [{ update_id: 5, message: { message_id: 9, date: 1, text: "hi", chat: { id: 2 }, from: { id: 3 } } }]
          : [],
      });
    });

    const received: unknown[] = [];
    const done = adapter.start(async (message) => {
      received.push(message);
      adapter.stop();
    });
    await done;

    expect(received).toEqual([{ id: "9", chatId: 2, userId: 3, text: "hi", date: 1 }]);
  });

  test("splits outbound messages", async () => {
    const sentBodies: unknown[] = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: true });
    });

    await adapter.sendMessage(1, "x".repeat(3600));

    expect(sentBodies).toHaveLength(2);
  });
});
