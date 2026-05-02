import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

let dirs: string[] = [];

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-store-"));
  dirs.push(dir);
  return new Store(join(dir, "db.sqlite"));
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("store", () => {
  test("migrates and stores workspaces", () => {
    const store = tempStore();
    store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    expect(store.getWorkspace("demo")).toEqual({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    expect(store.listWorkspaces()).toHaveLength(1);
    store.close();
  });

  test("stores chat bindings and transcript", () => {
    const store = tempStore();
    store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    store.bindChat(123, "demo", 2);
    expect(store.getBinding(123)).toEqual({ chatId: 123, workspaceName: "demo", updatedAt: 2 });
    store.appendTranscript({ chatId: 123, workspaceName: "demo", role: "agent", text: "hello\n", createdAt: 3 });
    expect(store.recentTranscript(123, "demo", "agent", 50)).toBe("hello\n");
    expect(store.latestTranscriptEvent(123, "demo", "agent")).toEqual({
      chatId: 123,
      workspaceName: "demo",
      role: "agent",
      text: "hello\n",
      createdAt: 3,
    });
    store.close();
  });

  test("stores pending prompts", () => {
    const store = tempStore();
    store.setPendingPrompt({
      chatId: 123,
      promptMessageId: 9,
      kind: "codex_user_input",
      createdAt: 3,
      sessionKey: "123:demo",
      payloadJson: "{\"ok\":true}",
      expiresAt: 5,
    });
    expect(store.getPendingPrompt(123, 9)).toEqual({
      chatId: 123,
      promptMessageId: 9,
      kind: "codex_user_input",
      createdAt: 3,
      sessionKey: "123:demo",
      payloadJson: "{\"ok\":true}",
      expiresAt: 5,
    });
    store.deletePendingPrompt(123, 9);
    expect(store.getPendingPrompt(123, 9)).toBeUndefined();
    store.close();
  });

  test("stores app-server thread ids on sessions", () => {
    const store = tempStore();
    store.markSessionStarted("123:demo", 123, "demo", 4, "thread-1");
    expect(store.getSession("123:demo")?.thread_id).toBe("thread-1");
    store.markSessionStarted("123:demo", 123, "demo", 5);
    expect(store.getSession("123:demo")?.thread_id).toBe("thread-1");
    store.close();
  });

  test("stores and prunes paged outputs", () => {
    const store = tempStore();
    store.setPagedOutput({
      token: "tok",
      chatId: 123,
      sessionKey: "123:demo",
      text: "long output",
      createdAt: 4,
      expiresAt: 10,
    });
    expect(store.getPagedOutput("tok")).toEqual({
      token: "tok",
      chatId: 123,
      sessionKey: "123:demo",
      text: "long output",
      createdAt: 4,
      expiresAt: 10,
    });
    store.prunePagedOutputs(11);
    expect(store.getPagedOutput("tok")).toBeUndefined();
    store.close();
  });
});
