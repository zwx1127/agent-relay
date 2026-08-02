import { describe, expect, test } from "bun:test";
import { noopLogger, TextLogger } from "../../src/domain/logger.ts";
import { TelegramAdapter } from "../../src/providers/im/telegram/adapter.ts";

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

    expect(received).toEqual([{ kind: "message", id: "9", messageId: "9", conversationId: "2", userId: "3", text: "hi", date: 1 }]);
  });

  test("routes long polling photo messages", async () => {
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({
        ok: true,
        result: calls === 2
          ? [{
            update_id: 5,
            message: {
              message_id: 9,
              date: 1,
              caption: "inspect",
              media_group_id: "album-1",
              chat: { id: 2 },
              from: { id: 3 },
              photo: [
                { file_id: "small", width: 10, height: 10 },
                { file_id: "large", file_unique_id: "unique", width: 100, height: 100, file_size: 123 },
              ],
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
      kind: "media",
      id: "9",
      messageId: "9",
      conversationId: "2",
      userId: "3",
      caption: "inspect",
      mediaGroupId: "album-1",
      photos: [
        { fileId: "small", width: 10, height: 10 },
        { fileId: "large", fileUniqueId: "unique", width: 100, height: 100, fileSize: 123 },
      ],
      date: 1,
    }]);
  });

  test("routes document messages as files", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }));
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        caption: "inspect",
        chat: { id: 2 },
        from: { id: 3 },
        document: { file_id: "doc", file_unique_id: "unique", file_name: "report.pdf", mime_type: "application/pdf", file_size: 123 },
      },
    });

    expect(inbound).toEqual({
      kind: "file",
      id: "9",
      messageId: "9",
      conversationId: "2",
      userId: "3",
      caption: "inspect",
      file: {
        fileId: "doc",
        fileUniqueId: "unique",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        fileSize: 123,
      },
      date: 1,
    });
  });

  test("routes voice, audio, and audio documents as audio", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }));
    const voice = (adapter as any).toInboundMessage({
      update_id: 5,
      message: { message_id: 9, date: 1, chat: { id: 2 }, from: { id: 3 }, voice: { file_id: "voice", duration: 4, file_size: 12 } },
    });
    const document = (adapter as any).toInboundMessage({
      update_id: 6,
      message: { message_id: 10, date: 1, caption: "transcribe", chat: { id: 2 }, from: { id: 3 }, document: { file_id: "audio-doc", file_name: "clip.mp3", mime_type: "audio/mpeg" } },
    });

    expect(voice).toMatchObject({ kind: "audio", audio: { fileId: "voice", fileName: "voice-9.ogg", mimeType: "audio/ogg", fileSize: 12 }, durationSeconds: 4 });
    expect(document).toMatchObject({ kind: "audio", caption: "transcribe", audio: { fileId: "audio-doc", fileName: "clip.mp3", mimeType: "audio/mpeg" } });
  });

  test("marks and strips telegram bot mentions in group text", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }), noopLogger, {
      botUsername: "relay_bot",
    });
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        text: "@relay_bot /relay",
        entities: [{ type: "mention", offset: 0, length: 10 }],
        chat: { id: -2, type: "group" },
        from: { id: 3 },
      },
    });

    expect(inbound).toMatchObject({
      kind: "message",
      conversationId: "-2",
      text: "/relay",
      conversationType: "group",
      mentionedBot: true,
    });
  });

  test("marks telegram group slash commands addressed to the bot", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }), noopLogger, {
      botUsername: "relay_bot",
    });
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        text: "/relay@relay_bot",
        entities: [{ type: "bot_command", offset: 0, length: 16 }],
        chat: { id: -2, type: "supergroup" },
        from: { id: 3 },
      },
    });

    expect(inbound).toMatchObject({
      text: "/relay",
      conversationType: "group",
      mentionedBot: true,
    });
  });

  test("marks telegram group slash commands with a separated bot mention", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }), noopLogger, {
      botUsername: "relay_bot",
    });
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        text: "/relay @relay_bot",
        entities: [
          { type: "bot_command", offset: 0, length: 6 },
          { type: "mention", offset: 7, length: 10 },
        ],
        chat: { id: -2, type: "supergroup" },
        from: { id: 3 },
      },
    });

    expect(inbound).toMatchObject({
      text: "/relay",
      conversationType: "group",
      mentionedBot: true,
    });
  });

  test("does not mark concatenated telegram bot mentions as addressed to the bot", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }), noopLogger, {
      botUsername: "relay_bot",
    });
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        text: "@relay_bot/relay",
        entities: [{ type: "mention", offset: 0, length: 10 }],
        chat: { id: -2, type: "supergroup" },
        from: { id: 3 },
      },
    });

    expect(inbound).toMatchObject({
      text: "@relay_bot/relay",
      conversationType: "group",
      mentionedBot: false,
    });
  });

  test("marks telegram group text without bot mention as unmentioned", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({ ok: true, result: [] }), noopLogger, {
      botUsername: "relay_bot",
    });
    const inbound = (adapter as any).toInboundMessage({
      update_id: 5,
      message: {
        message_id: 9,
        date: 1,
        text: "hello",
        chat: { id: -2, type: "group" },
        from: { id: 3 },
      },
    });

    expect(inbound).toMatchObject({ conversationType: "group", mentionedBot: false, text: "hello" });
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
    expect(received).toEqual([{ kind: "message", id: "10", messageId: "10", conversationId: "2", userId: "3", text: "new", date: 2 }]);
  });

  test("uses configured long polling timeout", async () => {
    const requestBodies: unknown[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        ok: true,
        result: calls === 1
          ? []
          : [{ update_id: 6, message: { message_id: 10, date: 2, text: "new", chat: { id: 2 }, from: { id: 3 } } }],
      });
    }, noopLogger, { pollTimeoutSeconds: 12 });

    await adapter.start(async () => {
      adapter.stop();
    });

    expect(requestBodies).toEqual([
      { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
      { offset: 0, timeout: 12, allowed_updates: ["message", "callback_query"] },
    ]);
  });

  test("keeps polling after transient Telegram failures", async () => {
    const delays: number[] = [];
    const requestBodies: unknown[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      if (calls === 1) {
        return Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
      }
      return Response.json({
        ok: true,
        result: calls === 3
          ? [{ update_id: 6, message: { message_id: 10, date: 2, text: "new", chat: { id: 2 }, from: { id: 3 } } }]
          : [],
      });
    }, noopLogger, {
      retryInitialDelayMs: 25,
      retryMaxDelayMs: 100,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    const received: unknown[] = [];
    await adapter.start(async (message) => {
      received.push(message);
      adapter.stop();
    });

    expect(delays).toEqual([25]);
    expect(requestBodies).toEqual([
      { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
      { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
      { offset: 0, timeout: 30, allowed_updates: ["message", "callback_query"] },
    ]);
    expect(received).toEqual([{ kind: "message", id: "10", messageId: "10", conversationId: "2", userId: "3", text: "new", date: 2 }]);
  });

  test("keeps polling after inbound handler failures", async () => {
    const lines: string[] = [];
    const requestBodies: unknown[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        ok: true,
        result: calls === 2
          ? [{ update_id: 5, message: { message_id: 9, date: 1, text: "bad", chat: { id: 2 }, from: { id: 3 } } }]
          : calls === 3
            ? [{ update_id: 6, message: { message_id: 10, date: 2, text: "new", chat: { id: 2 }, from: { id: 3 } } }]
            : [],
      });
    }, new TextLogger("error", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z")));

    const received: unknown[] = [];
    await adapter.start(async (message) => {
      if (message.messageId === "9") throw new Error("handler failed");
      received.push(message);
      adapter.stop();
    });

    expect(requestBodies).toEqual([
      { offset: -1, timeout: 0, allowed_updates: ["message", "callback_query"] },
      { offset: 0, timeout: 30, allowed_updates: ["message", "callback_query"] },
      { offset: 6, timeout: 30, allowed_updates: ["message", "callback_query"] },
    ]);
    expect(received).toEqual([{ kind: "message", id: "10", messageId: "10", conversationId: "2", userId: "3", text: "new", date: 2 }]);
    expect(lines.join("\n")).toContain('telegram.update_handler_failed update_id=5 message_id="9"');
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
              data: "ar:s",
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
      conversationId: "2",
      userId: "3",
      messageId: "9",
      data: "ar:s",
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

  test("prepends outbound telegram peer mentions", async () => {
    const sentBodies: unknown[] = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 12 } });
    });

    await adapter.sendMessage(1, "Please help.", { mentions: [{ label: "Designer", telegramUsername: "designer_bot" }] });

    expect(sentBodies.at(-1)).toMatchObject({ text: "@designer_bot Please help." });
  });

  test("retries transient outbound Telegram API failures", async () => {
    const delays: number[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 })
        : Response.json({ ok: true, result: { message_id: 9 } });
    }, noopLogger, {
      requestRetryMaxAttempts: 2,
      retryInitialDelayMs: 25,
      retryMaxDelayMs: 100,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(adapter.sendMessage(1, "hi")).resolves.toEqual({ messageId: "9" });
    expect(calls).toBe(2);
    expect(delays).toEqual([25]);
  });

  test("does not retry non-rate-limit client errors", async () => {
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
    }, noopLogger, {
      requestRetryMaxAttempts: 3,
      delay: async () => undefined,
    });

    await expect(adapter.sendMessage(1, "broken")).rejects.toThrow("can't parse entities");
    expect(calls).toBe(1);
  });

  test("uses Telegram retry_after for rate limits", async () => {
    const delays: number[] = [];
    let calls = 0;
    const adapter = new TelegramAdapter("token", async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }, { status: 429 })
        : Response.json({ ok: true, result: true });
    }, noopLogger, {
      requestRetryMaxAttempts: 2,
      retryInitialDelayMs: 25,
      retryMaxDelayMs: 10000,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(adapter.sendChatAction(1)).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(delays).toEqual([7000]);
  });

  test("sends parse mode and reply markup", async () => {
    const sentBodies: unknown[] = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 77 } });
    });

    const result = await adapter.sendMessage(1, "<b>Help</b>", {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] },
    });

    expect(result).toEqual({ messageId: "77" });
    expect(sentBodies.at(-1)).toEqual({
      chat_id: 1,
      text: "<b>Help</b>",
      disable_web_page_preview: true,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] },
    });
  });

  test("sends entities and ForceReply markup", async () => {
    const sentBodies: unknown[] = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 12 } });
    });

    await adapter.sendMessage(1, "Done src/app.ts", {
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "code", offset: 5, length: 10 },
      ],
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt, or send your next message with the workspace name.",
      inputFieldPlaceholder: "repo name under WORKSPACE_ROOT",
    });

    expect(sentBodies.at(-1)).toEqual({
      chat_id: 1,
      text: "Done src/app.ts",
      disable_web_page_preview: true,
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "code", offset: 5, length: 10 },
      ],
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: "repo name under WORKSPACE_ROOT" },
    });
  });

  test("downloads Telegram files", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const adapter = new TelegramAdapter("token", async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "photos/image.jpg", file_size: 3 } });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });

    const file = await adapter.downloadFile("abc");

    expect(file.filePath).toBe("photos/image.jpg");
    expect(file.fileSize).toBe(3);
    expect([...new Uint8Array(file.bytes)]).toEqual([1, 2, 3]);
    expect(requests).toEqual([
      { url: "https://api.telegram.org/bottoken/getFile", body: { file_id: "abc" } },
      { url: "https://api.telegram.org/file/bottoken/photos/image.jpg", body: undefined },
    ]);
  });

  test("sends photos as multipart", async () => {
    const requests: Array<{ method: string; body: FormData }> = [];
    const adapter = new TelegramAdapter("token", async (url, init) => {
      requests.push({ method: String(url).split("/").at(-1) || "", body: init?.body as FormData });
      return Response.json({ ok: true, result: { message_id: 12 } });
    });

    const result = await adapter.sendPhoto(1, new Blob([new Uint8Array([1, 2, 3])]), {
      caption: "caption",
      replyToMessageId: 99,
    });

    expect(result).toEqual({ messageId: "12" });
    expect(requests[0]?.method).toBe("sendPhoto");
    expect(requests[0]?.body.get("chat_id")).toBe("1");
    expect(requests[0]?.body.get("caption")).toBe("caption");
    expect(requests[0]?.body.get("reply_parameters")).toBe(JSON.stringify({ message_id: 99, allow_sending_without_reply: true }));
    expect(requests[0]?.body.get("photo")).toBeInstanceOf(Blob);
  });

  test("sends documents as multipart", async () => {
    const requests: Array<{ method: string; body: FormData }> = [];
    const adapter = new TelegramAdapter("token", async (url, init) => {
      requests.push({ method: String(url).split("/").at(-1) || "", body: init?.body as FormData });
      return Response.json({ ok: true, result: { message_id: 12 } });
    });

    const result = await adapter.sendFile(1, new Blob([new Uint8Array([1, 2, 3])]), {
      filename: "report.txt",
      caption: "caption",
      replyToMessageId: 99,
    });

    expect(result).toEqual({ messageId: "12" });
    expect(requests[0]?.method).toBe("sendDocument");
    expect(requests[0]?.body.get("chat_id")).toBe("1");
    expect(requests[0]?.body.get("caption")).toBe("caption");
    expect(requests[0]?.body.get("reply_parameters")).toBe(JSON.stringify({ message_id: 99, allow_sending_without_reply: true }));
    expect(requests[0]?.body.get("document")).toBeInstanceOf(Blob);
  });

  test("sends reply parameters only on the first outbound chunk", async () => {
    const sentBodies: Array<{ text: string; reply_parameters?: unknown; reply_markup?: unknown }> = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 12 } });
    });

    await adapter.sendMessage(1, "x".repeat(3600), {
      replyToMessageId: 99,
      replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] },
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.reply_parameters).toEqual({ message_id: 99, allow_sending_without_reply: true });
    expect(sentBodies[1]?.reply_parameters).toBeUndefined();
    expect(sentBodies[0]?.reply_markup).toBeUndefined();
    expect(sentBodies[1]?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] });
  });

  test("splits html outbound messages without dropping parse mode", async () => {
    const sentBodies: Array<{ text: string; parse_mode?: string }> = [];
    const adapter = new TelegramAdapter("token", async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: true });
    });

    await adapter.sendMessage(1, `<pre>${"x".repeat(3600)}</pre>`, {
      parseMode: "HTML",
      replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] },
    });

    expect(sentBodies.length).toBeGreaterThan(1);
    expect(sentBodies.every((body) => body.parse_mode === "HTML")).toBe(true);
    expect(sentBodies.every((body) => body.text.startsWith("<pre>") && body.text.endsWith("</pre>"))).toBe(true);
    expect(sentBodies.slice(0, -1).every((body) => !("reply_markup" in body))).toBe(true);
    expect(sentBodies.at(-1)).toHaveProperty("reply_markup");
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
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });
    await adapter.answerCallbackQuery("cb1", "Done");
    await adapter.sendChatAction(1);
    await adapter.deleteMessage(1, 2);

    expect(requests).toEqual([
      {
        method: "editMessageText",
        body: {
          chat_id: 1,
          message_id: 2,
          text: "<b>Status</b>",
          disable_web_page_preview: true,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
        },
      },
      {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: "cb1",
          text: "Done",
        },
      },
      {
        method: "sendChatAction",
        body: {
          chat_id: 1,
          action: "typing",
        },
      },
      {
        method: "deleteMessage",
        body: {
          chat_id: 1,
          message_id: 2,
        },
      },
    ]);
  });

  test("sets and clears message reactions", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const adapter = new TelegramAdapter("token", async (url, init) => {
      requests.push({ method: String(url).split("/").at(-1) || "", body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: true });
    });

    await adapter.setMessageReaction(1, 2, "😎");
    await adapter.setMessageReaction(1, 2);

    expect(requests).toEqual([
      {
        method: "setMessageReaction",
        body: {
          chat_id: 1,
          message_id: 2,
          reaction: [{ type: "emoji", emoji: "😎" }],
        },
      },
      {
        method: "setMessageReaction",
        body: {
          chat_id: 1,
          message_id: 2,
          reaction: [],
        },
      },
    ]);
  });

  test("surfaces message reaction errors", async () => {
    const adapter = new TelegramAdapter("token", async () => Response.json({
      ok: false,
      description: "Bad Request: reaction is not allowed",
    }, { status: 400 }));

    await expect(adapter.setMessageReaction(1, 2, "😎")).rejects.toThrow("reaction is not allowed");
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

  test("does not log message is not modified edits as errors", async () => {
    const lines: string[] = [];
    const logger = new TextLogger("error", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
    const adapter = new TelegramAdapter("token", async () => Response.json({
      ok: false,
      description: "Bad Request: message is not modified",
    }, { status: 400 }), logger);

    await expect(adapter.editMessageText(1, "same", { messageId: 2 })).resolves.toBeUndefined();
    expect(lines).toEqual([]);
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
