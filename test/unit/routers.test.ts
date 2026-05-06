import { describe, expect, test } from "bun:test";
import { CallbackRouter } from "../../src/relay/callback-router.ts";
import { SlashCommandRouter } from "../../src/relay/command-router.ts";

describe("relay routers", () => {
  test("slash command router dispatches command args", async () => {
    const calls: string[] = [];
    const router = new SlashCommandRouter({
      review: async (_conversationId, text) => { calls.push(`review:${text}`); },
      compact: async () => { calls.push("compact"); },
      init: async () => { calls.push("init"); },
      newThread: async () => { calls.push("new"); },
      resume: async (_conversationId, searchTerm) => { calls.push(`resume:${searchTerm}`); },
      fork: async () => { calls.push("fork"); },
      rename: async (_conversationId, name) => { calls.push(`rename:${name}`); },
      plan: async (_conversationId, prompt) => { calls.push(`plan:${prompt}`); },
      stop: async () => { calls.push("stop"); },
    });

    const message = {
      kind: "message" as const,
      id: "1",
      messageId: "1",
      conversationId: "c1",
      userId: "u1",
      text: "/resume sprint work",
    };

    expect(router.command(message.text)).toBe("/resume");
    expect(await router.handle(message, "/resume", message.text)).toBe(true);
    expect(await router.handle(message, "/unknown", message.text)).toBe(false);
    expect(calls).toEqual(["resume:sprint work"]);
  });

  test("callback router dispatches prefixed payloads", async () => {
    const calls: string[] = [];
    const router = new CallbackRouter({
      isStaleConsoleCallback: () => false,
      renderStaleConsole: async () => { calls.push("stale"); },
      home: async () => { calls.push("home"); },
      status: async () => { calls.push("status"); },
      workspaces: async (_message, pageIndex) => { calls.push(`workspaces:${pageIndex}`); },
      newWorkspace: async () => { calls.push("new"); },
      toggleStatusMode: async () => { calls.push("toggle"); },
      approval: async (_message, payload) => { calls.push(`approval:${payload}`); },
      codexQuestion: async (_message, payload) => { calls.push(`question:${payload}`); },
      pagedOutput: async (_message, payload) => { calls.push(`page:${payload}`); },
      command: async (_message, payload) => { calls.push(`command:${payload}`); },
      stop: async () => { calls.push("stop"); },
      workspaceIntro: async (_message, token, pageIndex) => { calls.push(`intro:${pageIndex}:${token}`); },
      confirmDeleteWorkspace: async (_message, token) => { calls.push(`confirm:${token}`); },
      deleteWorkspace: async (_message, token) => { calls.push(`delete:${token}`); },
      selectWorkspace: async (_message, token) => { calls.push(`select:${token}`); },
    });

    await router.route({
      kind: "callback_query",
      id: "1",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb1",
      data: "ar:home",
    });
    await router.route({
      kind: "callback_query",
      id: "1",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb1",
      data: "ar:wl:2",
    });
    await router.route({
      kind: "callback_query",
      id: "2",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb2",
      data: "ar:uh:abc",
    });
    await router.route({
      kind: "callback_query",
      id: "3",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb3",
      data: "ar:wi:2:def",
    });
    await router.route({
      kind: "callback_query",
      id: "4",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb4",
      data: "ar:q:tok:1",
    });

    expect(calls).toEqual(["home", "workspaces:2", "select:abc", "intro:2:def", "question:q:tok:1"]);
  });
});
