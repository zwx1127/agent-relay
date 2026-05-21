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
      goal: async (_conversationId, args) => { calls.push(`goal:${args}`); },
      interrupt: async (_conversationId, args) => { calls.push(`interrupt:${args}`); },
      ps: async () => { calls.push("ps"); },
      stop: async () => { calls.push("stop"); },
      unknown: async (_conversationId, command) => { calls.push(`unknown:${command}`); },
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
    expect(await router.handle({ ...message, text: "/ps" }, "/ps", "/ps")).toBe(true);
    expect(await router.handle({ ...message, text: "/goal ship it" }, "/goal", "/goal ship it")).toBe(true);
    expect(await router.handle({ ...message, text: "/interrupt all" }, "/interrupt", "/interrupt all")).toBe(true);
    expect(await router.handle(message, "/unknown", message.text)).toBe(true);
    expect(calls).toEqual(["resume:sprint work", "ps", "goal:ship it", "interrupt:all", "unknown:/unknown"]);
  });

  test("callback router dispatches prefixed payloads", async () => {
    const calls: string[] = [];
    const router = new CallbackRouter({
      isStaleConsoleCallback: () => false,
      renderStaleConsole: async () => { calls.push("stale"); },
      home: async () => { calls.push("home"); },
      status: async () => { calls.push("status"); },
      workspaces: async (_message, pageIndex) => { calls.push(`workspaces:${pageIndex}`); },
      newWorkspace: async (_message, pageIndex) => { calls.push(`new:${pageIndex}`); },
      toggleStatusMode: async () => { calls.push("toggle"); },
      approval: async (_message, payload) => { calls.push(`approval:${payload}`); },
      codexQuestion: async (_message, payload) => { calls.push(`question:${payload}`); },
      pagedOutput: async (_message, payload) => { calls.push(`page:${payload}`); },
      command: async (_message, payload) => { calls.push(`command:${payload}`); },
      fileBrowser: async (_message, payload) => { calls.push(`file:${payload}`); },
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
      data: "ar:n:3",
    });
    await router.route({
      kind: "callback_query",
      id: "5",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb5",
      data: "ar:q:tok:1",
    });
    await router.route({
      kind: "callback_query",
      id: "6",
      conversationId: "c1",
      userId: "u1",
      callbackQueryId: "cb6",
      data: "ar:f:tok:o:1",
    });

    expect(calls).toEqual(["home", "workspaces:2", "select:abc", "intro:2:def", "new:3", "question:q:tok:1", "file:f:tok:o:1"]);
  });
});
