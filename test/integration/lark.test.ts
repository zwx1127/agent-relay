import { describe, expect, test } from "bun:test";
import * as lark from "@larksuiteoapi/node-sdk";
import { LarkAdapter, larkDomainForSdk, type LarkChannelClient } from "../../src/providers/im/lark/adapter.ts";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";

class FakeLarkChannel implements LarkChannelClient {
  handlers: Parameters<LarkChannelClient["on"]>[0] = {};
  connected = false;
  disconnected = false;
  sent: Array<{ to: string; input: SendInput; options?: SendOptions }> = [];
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
    const adapter = adapterWith(channel);
    const received: unknown[] = [];

    await adapter.start(async (message) => {
      received.push(message);
    });
    await channel.handlers.cardAction?.({
      messageId: "om_card",
      chatId: "oc_chat",
      operator: { openId: "ou_user" },
      action: { tag: "button", value: { callback_data: "ar:s" } },
    } satisfies CardActionEvent);

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
    expect(JSON.stringify(sentCard)).toContain("\"tag\":\"column_set\"");
    expect(JSON.stringify(sentCard)).toContain("\"callback_data\":\"ar:s\"");
    expect(channel.updated[0]).toMatchObject({ messageId: "om_2" });
    expectNoLarkCardFooter(channel.updated[0]!.card);
    expect(channel.edited).toEqual([{ messageId: "om_1", text: "plain edit" }]);
    expect(channel.sent[2]?.input).toHaveProperty("image");
    expect(channel.sent[3]).toEqual({ to: "oc_chat", input: { text: "caption" }, options: { replyTo: "om_3" } });
    expect(channel.recalled).toEqual(["om_1"]);
    expect(channel.reactions).toEqual([
      { messageId: "om_1", emojiType: "SMILE" },
      { messageId: "om_1", emojiType: "THINKING" },
    ]);
    expect(channel.removedReactions).toEqual([{ messageId: "om_1", emojiType: "SMILE" }]);
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
  expect(input).toMatchObject({ card: { schema: "2.0" } });
  if (!input || !("card" in input)) throw new Error("expected Lark card input");
  return input.card;
}

function expectNoLarkCardFooter(card: object): void {
  expect(card).toMatchObject({ schema: "2.0" });
  expect(card).not.toHaveProperty("footer");
}

function adapterWith(channel: FakeLarkChannel): LarkAdapter {
  return new LarkAdapter({
    appId: "cli_a",
    appSecret: "secret",
    channel,
  });
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
