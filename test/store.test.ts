import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.ts";

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
    store.bindChat(1, "demo");
    store.deleteWorkspace("demo");
    expect(store.getWorkspace("demo")).toBeUndefined();
    expect(store.getBinding(1)).toBeUndefined();
    store.close();
  });

  test("stores chat bindings and transcript", () => {
    const store = tempStore();
    store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    store.bindChat(123, "demo", 2);
    expect(store.getBinding(123)).toEqual({ chatId: 123, workspaceName: "demo", updatedAt: 2 });
    store.clearBinding(123);
    expect(store.getBinding(123)).toBeUndefined();
    store.bindChat(123, "demo", 2);
    store.clearBindingsForWorkspace("demo");
    expect(store.getBinding(123)).toBeUndefined();
    store.appendTranscript({ chatId: 123, workspaceName: "demo", role: "agent", text: "hello\n", createdAt: 3 });
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
    store.clearSessionThreadId("123:demo");
    expect(store.getSession("123:demo")?.thread_id).toBeNull();
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

  test("stores console ui state and task queue", () => {
    const store = tempStore();
    store.setConsoleMessageId(1, 101);
    expect(store.getConsoleMessageId(1)).toBe(101);
    expect(store.getHomeStatusMode(1)).toBe("compact");
    store.setHomeStatusMode(1, "details");
    expect(store.getHomeStatusMode(1)).toBe("details");

    const first = store.createTask({ chatId: 1, workspaceName: "demo", text: "first", status: "queued", createdAt: 1 });
    const second = store.createTask({
      chatId: 1,
      workspaceName: "demo",
      text: "second",
      input: { text: "second", images: [{ path: "/tmp/image.jpg" }] },
      status: "queued",
      createdAt: 2,
    });

    expect(store.nextQueuedTask(1, "demo")?.id).toBe(first.id);
    expect(store.getTask(second.id)?.inputJson).toBe(JSON.stringify({ text: "second", images: [{ path: "/tmp/image.jpg" }] }));
    expect(store.countTasks(1, "demo", ["queued"])).toBe(2);
    store.updateTask(first.id, { status: "running", turnId: "turn-1", statusMessageId: 501 });
    expect(store.activeTask(1, "demo")?.turnId).toBe("turn-1");
    expect(store.activeTask(1, "demo")?.statusMessageId).toBe(501);
    expect(store.nextQueuedTask(1, "demo")?.id).toBe(second.id);
    store.close();
  });
});
