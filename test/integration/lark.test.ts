import { describe, expect, test } from "bun:test";
import * as lark from "@larksuiteoapi/node-sdk";
import { TextLogger } from "../../src/domain/logger.ts";
import { LarkAdapter, larkChannelOptions, larkDomainForSdk, type LarkChannelClient } from "../../src/providers/im/lark/adapter.ts";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";

class FakeLarkChannel implements LarkChannelClient {
  handlers: Parameters<LarkChannelClient["on"]>[0] = {};
  connected = false;
  disconnected = false;
  sent: Array<{ to: string; input: SendInput; options?: SendOptions }> = [];
  updateStarted: Array<{ messageId: string; card: object }> = [];
  updateFailures: Error[] = [];
  updateWaits: Promise<void>[] = [];
  updated: Array<{ messageId: string; card: object }> = [];
  edited: Array<{ messageId: string; text: string }> = [];
  recalled: string[] = [];
  reactions: Array<{ messageId: string; emojiType: string }> = [];
  removedReactions: Array<{ messageId: string; emojiType: string }> = [];
  resources = new Map<string, Buffer>();
  nextMessageId = 1;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  on(handlers: Parameters<LarkChannelClient["on"]>[0]): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = {};
    };
  }

  async send(to: string, input: SendInput, options?: SendOptions): Promise<{ messageId: string }> {
    const messageId = `om_${this.nextMessageId++}`;
    this.sent.push({ to, input, ...(options ? { options } : {}) });
    return { messageId };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    this.updateStarted.push({ messageId, card });
    const failure = this.updateFailures.shift();
    if (failure) throw failure;
    const wait = this.updateWaits.shift();
    if (wait) await wait;
    this.updated.push({ messageId, card });
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    this.edited.push({ messageId, text });
  }

  async recallMessage(messageId: string): Promise<void> {
    this.recalled.push(messageId);
  }

  async downloadResource(fileKey: string): Promise<Buffer> {
    return this.resources.get(fileKey) ?? Buffer.from([1, 2, 3]);
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactions.push({ messageId, emojiType });
    return `rx_${messageId}_${emojiType}`;
  }

  async removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean> {
    this.removedReactions.push({ messageId, emojiType });
    return true;
  }
}

describe("lark adapter", () => {
  test("maps configured domains to SDK domains", () => {
    expect(larkDomainForSdk(undefined)).toBe(lark.Domain.Feishu);
    expect(larkDomainForSdk("feishu")).toBe(lark.Domain.Feishu);
    expect(larkDomainForSdk("lark")).toBe(lark.Domain.Lark);
    expect(larkDomainForSdk("https://open.example.com")).toBe("https://open.example.com");
  });

  test("uses a short Lark action dedup TTL by default", () => {
    const options = larkChannelOptions({ appId: "cli_a", appSecret: "secret", domain: "lark" });

    expect(options.safety?.dedup?.ttl).toBe(500);
    expect(options.policy).toEqual({ requireMention: false, dmMode: "open" });
    expect(options.outbound).toEqual({ textChunkLimit: 3500 });
  });

  test("allows overriding the Lark action dedup TTL", () => {
    const options = larkChannelOptions({
      appId: "cli_a",
      appSecret: "secret",
      domain: "lark",
      cardActionDedupTtlMs: 250,
    });

    expect(options.safety?.dedup?.ttl).toBe(250);
  });

  test("routes long-connection text messages", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    await channel.handlers.message?.(normalizedMessage({
      content: "hi",
      rawContentType: "text",
    }));

    expect(channel.connected).toBe(true);
    expect(received).toEqual([{
      kind: "message",
      id: "om_in",
      messageId: "om_in",
      conversationId: "oc_chat",
      userId: "ou_user",
      text: "hi",
      date: 2,
    }]);
  });

  test("ignores interactive card message echoes", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    await channel.handlers.message?.(normalizedMessage({
      content: "Relay Home\nWorkspaces\nStatus\nRefresh",
      rawContentType: "interactive",
    }));

    expect(received).toEqual([]);
  });

  test("routes image messages and downloads resources", async () => {
    const channel = new FakeLarkChannel();
    channel.resources.set("img_key", Buffer.from([4, 5, 6]));
    const adapter = adapterWith(channel);
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    await channel.handlers.message?.(normalizedMessage({
      content: "",
      rawContentType: "image",
      resources: [{ type: "image", fileKey: "img_key" }],
      replyToMessageId: "om_parent",
    }));
    const file = await adapter.downloadFile("img_key");

    expect(received).toEqual([{
      kind: "media",
      id: "om_in",
      messageId: "om_in",
      conversationId: "oc_chat",
      userId: "ou_user",
      photos: [{ fileId: "img_key", width: 0, height: 0 }],
      replyToMessageId: "om_parent",
      date: 2,
    }]);
    expect([...new Uint8Array(file.bytes)]).toEqual([4, 5, 6]);
    expect(file.filePath).toBe("img_key.jpg");
    expect(file.fileSize).toBe(3);
  });

  test("routes card button actions as callback queries", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel, { cardActionDispatchDelayMs: 0 });
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    await channel.handlers.cardAction?.({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_user" },
      action: { tag: "button", value: { callback_nonce: "nonce-1", callback_data: "ar:s" } },
    } satisfies CardActionEvent);
    await waitUntil(() => received.length === 1);

    expect(received).toEqual([{
      kind: "callback_query",
      id: "om_card:ou_user:ar:s",
      callbackQueryId: "om_card:ou_user:ar:s",
      conversationId: "oc_chat",
      userId: "ou_user",
      messageId: "om_card",
      data: "ar:s",
    }]);
  });

  test("releases card action SDK handler before async relay handling completes", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel, { cardActionDispatchDelayMs: 0 });
    const release = deferred<void>();
    let completed = false;

    await adapter.start(async () => {
      await release.promise;
      completed = true;
    });
    const handling = channel.handlers.cardAction?.({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_user" },
      action: { tag: "button", value: { callback_data: "ar:s" } },
    } satisfies CardActionEvent);
    if (!handling) throw new Error("expected card action handler");

    await handling;
    expect(completed).toBe(false);
    release.resolve();
    await waitUntil(() => completed);
  });

  test("logs asynchronous card action handling failures", async () => {
    const channel = new FakeLarkChannel();
    const logLines: string[] = [];
    const logger = new TextLogger("info", (line) => logLines.push(line), () => new Date("2026-05-13T03:24:22.000Z"));
    const adapter = adapterWith(channel, { logger, cardActionDispatchDelayMs: 0 });

    await adapter.start(async () => {
      throw new Error("callback failed");
    });
    await channel.handlers.cardAction?.({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_user" },
      action: { tag: "button", value: { callback_nonce: "nonce-1", callback_data: "ar:s" } },
    } satisfies CardActionEvent);
    await waitUntil(() => logLines.some((line) => line.includes("lark.card_action_handler_failed")));

    const logs = logLines.join("\n");
    expect(logs).toContain('callback_data="ar:s"');
    expect(logs).toContain("lark.card_action_handler_failed");
    expect(logs).toContain('error="callback failed"');
  });

  test("delays card action relay handling after SDK handler returns", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel, { cardActionDispatchDelayMs: 30 });
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    const handling = channel.handlers.cardAction?.({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_user" },
      action: { tag: "button", value: { callback_nonce: "nonce-1", callback_data: "ar:s" } },
    } satisfies CardActionEvent);
    if (!handling) throw new Error("expected card action handler");

    await handling;
    expect(received).toEqual([]);
    await waitUntil(() => received.length === 1);
  });

  test("dispatches representative relay callback buttons through the same Lark action path", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel, { cardActionDispatchDelayMs: 0 });
    const received: string[] = [];
    const callbacks = [
      "ar:s",
      "ar:status",
      "ar:home",
      "ar:n:0",
      "ar:uh:workspace",
      "ar:wd?:workspace",
      "ar:wd!:workspace",
      "ar:a:approval:y",
      "ar:q:question:0",
      "ar:cmd:plan:token:implement",
      "ar:cmd:goal:token:replace",
      "ar:p:page:1",
    ];

    await adapter.start(async (message) => {
      if (message.kind === "callback_query") received.push(message.data);
    });
    for (const data of callbacks) {
      await channel.handlers.cardAction?.({
        messageId: "om_card",
        chatId: "oc_chat",
        operator: { openId: "ou_user" },
        action: { tag: "button", value: { callback_nonce: `nonce-${data}`, callback_data: data } },
      } satisfies CardActionEvent);
    }
    await waitUntil(() => received.length === callbacks.length);

    expect(received).toEqual(callbacks);
  });

  test("uses fresh callback nonces when cards are re-rendered", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });
    await adapter.editMessageText("oc_chat", "choose again", {
      messageId: "om_1",
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });

    const sentValue = firstButtonValue(expectLarkCard(channel.sent[0]?.input));
    const updatedValue = firstButtonValue(channel.updated[0]!.card);

    expect(sentValue.callback_data).toBe("ar:s");
    expect(updatedValue.callback_data).toBe("ar:s");
    expect(typeof sentValue.callback_nonce).toBe("string");
    expect(typeof updatedValue.callback_nonce).toBe("string");
    expect(updatedValue.callback_nonce).not.toBe(sentValue.callback_nonce);
    expect(JSON.stringify(sentValue).indexOf("callback_nonce")).toBeLessThan(JSON.stringify(sentValue).indexOf("callback_data"));
  });

  test("serializes card updates for the same card message", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);
    const releaseFirst = deferred<void>();
    channel.updateWaits.push(releaseFirst.promise);

    await adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });
    const first = adapter.editMessageText("oc_chat", "first", { messageId: "om_1", replyMarkup: { inline_keyboard: [] } });
    await Promise.resolve();
    const second = adapter.editMessageText("oc_chat", "second", { messageId: "om_1", replyMarkup: { inline_keyboard: [] } });
    await Promise.resolve();

    expect(channel.updateStarted).toHaveLength(1);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(channel.updateStarted).toHaveLength(2);
    expect(channel.updated.map((update) => JSON.stringify(update.card))).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  test("retries transient card update failures", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);
    channel.updateFailures.push(new Error("temporary card patch failure"));

    await adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });
    await adapter.editMessageText("oc_chat", "recovered", {
      messageId: "om_1",
      replyMarkup: { inline_keyboard: [] },
    });

    expect(channel.updateStarted).toHaveLength(2);
    expect(channel.updated).toHaveLength(1);
    expect(JSON.stringify(channel.updated[0]!.card)).toContain("recovered");
  });

  test("times out a stuck card update without blocking later updates", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel, { cardUpdateTimeoutMs: 5 });
    channel.updateWaits.push(new Promise(() => undefined));

    await adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: { inline_keyboard: [[{ text: "Refresh", callback_data: "ar:s" }]] },
    });

    await expect(adapter.editMessageText("oc_chat", "stuck", {
      messageId: "om_1",
      replyMarkup: { inline_keyboard: [] },
    })).rejects.toThrow("Lark card update timed out");

    await adapter.editMessageText("oc_chat", "recovered", {
      messageId: "om_1",
      replyMarkup: { inline_keyboard: [] },
    });

    expect(channel.updateStarted).toHaveLength(2);
    expect(JSON.stringify(channel.updated.at(-1)?.card)).toContain("recovered");
  });

  test("sends text, cards, edits, photos, deletes, and reactions", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await expect(adapter.sendMessage("oc_chat", "hello", { replyToMessageId: "om_parent" })).resolves.toEqual({ messageId: "om_1" });
    await expect(adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: { inline_keyboard: [[{ text: "Status", callback_data: "ar:s" }]] },
    })).resolves.toEqual({ messageId: "om_2" });
    await adapter.editMessageText("oc_chat", "updated", { messageId: "om_2", replyMarkup: { inline_keyboard: [] } });
    await adapter.editMessageText("oc_chat", "plain edit", { messageId: "om_1" });
    await expect(adapter.sendPhoto("oc_chat", new Blob([new Uint8Array([1, 2, 3])]), { caption: "caption" })).resolves.toEqual({ messageId: "om_3" });
    await adapter.deleteMessage("oc_chat", "om_1");
    await adapter.setMessageReaction("oc_chat", "om_1", "😎");
    await adapter.setMessageReaction("oc_chat", "om_1", "🤔");

    expect(channel.sent[0]).toEqual({ to: "oc_chat", input: { markdown: "hello" }, options: { replyTo: "om_parent" } });
    const sentCard = expectLarkCard(channel.sent[1]?.input);
    expectNoLarkCardFooter(sentCard);
    expect(sentCard).toMatchObject({
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: "choose", text_size: "normal" },
          {
            tag: "column_set",
            columns: [{
              elements: [{
                tag: "button",
                text: { tag: "plain_text", content: "Status" },
                type: "default",
                size: "small",
                width: "fill",
                behaviors: [{ type: "callback", value: { callback_data: "ar:s" } }],
              }],
            }],
          },
        ],
      },
    });
    expect(channel.updated[0]).toMatchObject({ messageId: "om_2" });
    expectNoLarkCardFooter(channel.updated[0]!.card);
    expect(channel.edited).toEqual([{ messageId: "om_1", text: "plain edit" }]);
    expect(channel.sent[2]?.input).toHaveProperty("image");
    expect(channel.sent[3]).toEqual({ to: "oc_chat", input: { text: "caption" }, options: { replyTo: "om_3" } });
    expect(channel.recalled).toEqual(["om_1"]);
    expect(channel.reactions).toEqual([
      { messageId: "om_1", emojiType: "DONE" },
      { messageId: "om_1", emojiType: "THINKING" },
    ]);
    expect(channel.removedReactions).toEqual([{ messageId: "om_1", emojiType: "DONE" }]);
  });

  test("preserves Telegram inline keyboard rows in Lark button layout", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await adapter.sendMessage("oc_chat", "choose", {
      replyMarkup: {
        inline_keyboard: [
          [{ text: "Refresh", callback_data: "ar:s" }],
          [
            { text: "Approve", callback_data: "ar:a:y" },
            { text: "Deny", callback_data: "ar:a:n" },
          ],
          [
            { text: "Workspaces", callback_data: "ar:w" },
            { text: "Details", callback_data: "ar:status" },
            { text: "Refresh", callback_data: "ar:s" },
          ],
          [
            { text: "First", callback_data: "ar:p:t:0" },
            { text: "Prev", callback_data: "ar:p:t:0" },
            { text: "Next", callback_data: "ar:p:t:1" },
            { text: "Last", callback_data: "ar:p:t:2" },
          ],
        ],
      },
    });

    const rows = larkButtonRows(expectLarkCard(channel.sent[0]?.input));
    expect(rows.map((row) => row.length)).toEqual([1, 2, 3, 4]);
    expect(rows.flat().map((button) => button.text?.content)).toEqual([
      "Refresh",
      "Approve",
      "Deny",
      "Workspaces",
      "Details",
      "Refresh",
      "First",
      "Prev",
      "Next",
      "Last",
    ]);
    expect(rows.flat().every((button) => button.size === "small" && button.width === "fill")).toBe(true);
  });

  test("maps relay status reactions to Lark emoji types", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await adapter.setMessageReaction("oc_chat", "om_waiting", "🫡");
    await adapter.setMessageReaction("oc_chat", "om_running", "✍");
    await adapter.setMessageReaction("oc_chat", "om_blocked", "🤔");
    await adapter.setMessageReaction("oc_chat", "om_done", "😎");
    await adapter.setMessageReaction("oc_chat", "om_interrupted", "🤨");
    await adapter.setMessageReaction("oc_chat", "om_failed", "😱");

    expect(channel.reactions).toEqual([
      { messageId: "om_waiting", emojiType: "SALUTE" },
      { messageId: "om_running", emojiType: "Typing" },
      { messageId: "om_blocked", emojiType: "THINKING" },
      { messageId: "om_done", emojiType: "DONE" },
      { messageId: "om_interrupted", emojiType: "GLANCE" },
      { messageId: "om_failed", emojiType: "ERROR" },
    ]);
  });

  test("renders relay managed messages as editable Lark cards", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await expect(adapter.sendMessage("oc_chat", "Done src/app.ts", {
      disableWebPagePreview: true,
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "code", offset: 5, length: 10 },
      ],
      replyMarkup: { inline_keyboard: [[
        { text: "Approve", callback_data: "ar:a:y" },
        { text: "Deny", callback_data: "ar:a:n" },
      ]] },
    })).resolves.toEqual({ messageId: "om_1" });

    const card = expectLarkCard(channel.sent[0]?.input);
    expectNoLarkCardFooter(card);
    const payload = JSON.stringify(card);
    expect(payload).toContain("**Done**");
    expect(payload).toContain("`src/app.ts`");
    expect(payload).toContain("\"type\":\"primary\"");
    expect(payload).toContain("\"type\":\"danger\"");
    expect(payload).toContain("\"callback_data\":\"ar:a:y\"");

    await adapter.editMessageText("oc_chat", "Updated", {
      messageId: "om_1",
      disableWebPagePreview: true,
      replyMarkup: { inline_keyboard: [] },
    });

    expect(channel.updated.at(-1)).toMatchObject({ messageId: "om_1" });
    expectNoLarkCardFooter(channel.updated.at(-1)!.card);
  });

  test("logs Lark card update target view and text length", async () => {
    const channel = new FakeLarkChannel();
    const logLines: string[] = [];
    const logger = new TextLogger("info", (line) => logLines.push(line), () => new Date("2026-05-13T03:24:22.000Z"));
    const adapter = adapterWith(channel, { logger });

    await adapter.sendMessage("oc_chat", "Relay Home\nworkspace: none", {
      disableWebPagePreview: true,
      replyMarkup: { inline_keyboard: [[{ text: "Workspaces", callback_data: "ar:w" }]] },
    });
    await adapter.editMessageText("oc_chat", "Workspaces\n\n1. demo", {
      messageId: "om_1",
      disableWebPagePreview: true,
      replyMarkup: { inline_keyboard: [[{ text: "Back", callback_data: "ar:home" }]] },
    });

    const logs = logLines.join("\n");
    expect(logs).toContain("lark.card_update_started");
    expect(logs).toContain("lark.card_update_succeeded");
    expect(logs).toContain('message_id="om_1"');
    expect(logs).toContain('target_view="workspaces"');
    expect(logs).toContain("text_len=19");
  });

  test("renders force reply prompts as Lark cards", async () => {
    const channel = new FakeLarkChannel();
    const adapter = adapterWith(channel);

    await expect(adapter.sendMessage("oc_chat", "Reply with the workspace name.", {
      forceReply: true,
      inputFieldPlaceholder: "repo name under WORKSPACE_ROOT",
    })).resolves.toEqual({ messageId: "om_1" });

    const card = expectLarkCard(channel.sent[0]?.input);
    expectNoLarkCardFooter(card);
    const payload = JSON.stringify(card);
    expect(payload).toContain("Reply to this message.");
    expect(payload).toContain("repo name under WORKSPACE_ROOT");
  });
});

function expectLarkCard(input: SendInput | undefined): object {
  if (!input || !("card" in input)) throw new Error("expected Lark card input");
  expectLarkCardShape(input.card);
  return input.card;
}

function expectNoLarkCardFooter(card: object): void {
  expectLarkCardShape(card);
  expect(card).not.toHaveProperty("footer");
}

function expectLarkCardShape(card: object): void {
  const value = card as { schema?: string; config?: { update_multi?: boolean; width_mode?: string }; body?: { elements?: unknown } };
  expect(value.schema).toBe("2.0");
  expect(value.config).toEqual({ update_multi: true, width_mode: "fill" });
  expect(Array.isArray(value.body?.elements)).toBe(true);
}

function firstButtonValue(card: object): { callback_nonce?: string; callback_data?: string } {
  const buttonValue = firstLarkButton(card).behaviors?.find((behavior) => behavior.type === "callback")?.value;
  if (!buttonValue || typeof buttonValue !== "object") throw new Error("expected button value");
  return buttonValue as { callback_nonce?: string; callback_data?: string };
}

function firstLarkButton(card: object): LarkButtonElement {
  const button = larkButtonRows(card).flat()[0];
  if (!button) throw new Error("expected button");
  return button;
}

function larkButtonRows(card: object): LarkButtonElement[][] {
  const value = card as { body?: { elements?: Array<{ tag?: string; columns?: Array<{ elements?: LarkButtonElement[] }> }> } };
  return value.body?.elements
    ?.filter((element) => element.tag === "column_set")
    .map((element) => element.columns?.flatMap((column) => column.elements?.filter((item) => item.tag === "button") ?? []) ?? []) ?? [];
}

interface LarkButtonElement {
  tag?: string;
  text?: { content?: string };
  size?: string;
  width?: string;
  behaviors?: Array<{ type?: string; value?: unknown }>;
}

function adapterWith(channel: FakeLarkChannel, options: Partial<ConstructorParameters<typeof LarkAdapter>[0]> = {}): LarkAdapter {
  return new LarkAdapter({
    appId: "cli_a",
    appSecret: "secret",
    channel,
    ...options,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function normalizedMessage(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: "om_in",
    chatId: "oc_chat",
    chatType: "group",
    senderId: "ou_user",
    content: "hi",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 2000,
    ...overrides,
  };
}
