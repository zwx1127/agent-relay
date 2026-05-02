import { describe, expect, test } from "bun:test";
import { TextLogger } from "../src/logger.ts";
import { TelegramAdapter } from "../src/telegram.ts";

describe("telegram adapter", () => {
  test("routes long polling text messages", async () => {
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: calls === 2
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

    expect(received).toEqual([{ kind: "message", id: "9", chatId: 2, userId: 3, text: "hi", date: 1 }]);
  });

  test("skips pending messages before polling", async () => {
    const requestBodies: unknown[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        ok: true,
        result: calls === 1
          ? [{ update_id: 5, message: { message_id: 9, date: 1, text: "old", chat: { id: 2 }, from: { id: 3 } } }]
          : [{ update_id: 6, message: { message_id: 10, date: 2, text: "new", chat: { id: 2 }, from: { id: 3 } } }],
      });
    });

    const received: unknown[] = [];
    await adapter.start(async (message) => {
      received.push(message);
      adapter.stop();
    });

    expect(requestBodies).toEqual([
      { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
      { offset: 6, timeout: 30, allowed_updates: ["message", "callback_query"] },
    ]);
    expect(received).toEqual([{ kind: "message", id: "10", chatId: 2, userId: 3, text: "new", date: 2 }]);
  });

  test("routes long polling callback queries", async () => {
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: calls === 2
          ? [{
            update_id: 5,
            callback_query: {
              id: "cb1",
              data: "ar:status",
              from: { id: 3 },
              message: { message_id: 9, date: 1, chat: { id: 2 } },
            },
          }]
          : [],
      });
    });

    const received: unknown[] = [];
    await adapter.start(async (message) => {
      received.push(message);
      adapter.stop();
    });

    expect(received).toEqual([{
      kind: "callback_query",
      id: "cb1",
      callbackQueryId: "cb1",
      chatId: 2,
      userId: 3,
      messageId: 9,
      data: "ar:status",
      date: 1,
    }]);
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

  test("sends parse mode and reply markup", async () => {
    const sentBodies: unknown[] = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: true });
    });

    await adapter.sendMessage(1, "<b>Help</b>", {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:status" }]] },
    });

    expect(sentBodies.at(-1)).toEqual({
      chat_id: 1,
      text: "<b>Help</b>",
      disable_web_page_preview: true,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:status" }]] },
    });
  });

  test("edits messages and answers callback queries", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const adapter = new TelegramAdapter("token", async (url, init) => {
      requests.push({ method: String(url).split("/").at(-1) || "", body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: true });
    });

    await adapter.editMessageText(1, "<b>Status</b>", {
      messageId: 2,
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:status" }]] },
    });
    await adapter.answerCallbackQuery("cb1", "Done");

    expect(requests).toEqual([
      {
        method: "editMessageText",
        body: {
          chat_id: 1,
          message_id: 2,
          text: "<b>Status</b>",
          disable_web_page_preview: true,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:status" }]] },
        },
      },
      {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: "cb1",
          text: "Done",
        },
      },
    ]);
  });

  test("ignores message is not modified edit errors", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({
      ok: false,
      description: "Bad Request: message is not modified",
    }));

    await expect(adapter.editMessageText(1, "same", { messageId: 2 })).resolves.toBeUndefined();
  });

  test("ignores HTTP 400 message is not modified edit errors", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({
      ok: false,
      description: "Bad Request: message is not modified",
    }, { status: 400 }));

    await expect(adapter.editMessageText(1, "same", { messageId: 2 })).resolves.toBeUndefined();
  });

  test("includes Telegram HTTP error descriptions", async () => {
    const lines: string[] = [];
    const logger = new TextLogger("error", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
    const adapter = new TelegramAdapter("token", async () => Response.json({
      ok: false,
      description: "Bad Request: can't parse entities",
    }, { status: 400 }), logger);

    await expect(adapter.editMessageText(1, "<b>broken", { messageId: 2 }))
      .rejects.toThrow("Bad Request: can't parse entities");
    expect(lines.join("\n")).toContain('telegram.api_http_error method="editMessageText" status=400 description="Bad Request: can\'t parse entities"');
  });

  test("debug logs raw inbound message text", async () => {
    const lines: string[] = [];
    const logger = new TextLogger("debug", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: calls === 2
          ? [{ update_id: 5, message: { message_id: 9, date: 1, text: "secret", chat: { id: 2 }, from: { id: 3 } } }]
          : [],
      });
    }, logger);

    await adapter.start(async () => {
      adapter.stop();
    });

    expect(lines.join("\n")).toContain('message_text="secret"');
  });
});
