import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";

let dirs: string[] = [];

function tempStore(): SQLiteStore {
  return new SQLiteStore(":memory:");
}

function fileStore(): { store: SQLiteStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-store-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  return { store: new SQLiteStore(path), path };
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("store", () => {
  test("persists file-backed workspaces across reopen", () => {
    const file = fileStore();
    file.store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    file.store.close();

    const reopened = new SQLiteStore(file.path);
    expect(reopened.getWorkspace("demo")).toEqual({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    reopened.close();
  });

  test("migrates and stores workspaces", () => {
    const store = tempStore();
    store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    expect(store.getWorkspace("demo")).toEqual({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    expect(store.listWorkspaces()).toHaveLength(1);
    store.bindConversation(1, "demo");
    store.deleteWorkspace("demo");
    expect(store.getWorkspace("demo")).toBeUndefined();
    expect(store.getBinding(1)).toBeUndefined();
    store.close();
  });

  test("stores chat bindings and transcript", () => {
    const store = tempStore();
    store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
    store.bindConversation(123, "demo", 2);
    expect(store.getBinding(123)).toEqual({ conversationId: "123", workspaceName: "demo", updatedAt: 2 });
    store.clearBinding(123);
    expect(store.getBinding(123)).toBeUndefined();
    store.bindConversation(123, "demo", 2);
    store.clearBindingsForWorkspace("demo");
    expect(store.getBinding(123)).toBeUndefined();
    store.appendTranscript({ conversationId: "123", workspaceName: "demo", role: "agent", text: "hello\n", createdAt: 3 });
    expect(store.latestTranscriptEvent(123, "demo", "agent")).toEqual({
      conversationId: "123",
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
      conversationId: "123",
      promptMessageId: "9",
      kind: "codex_user_input",
      createdAt: 3,
      sessionKey: "123:demo",
      payloadJson: "{\"ok\":true}",
      expiresAt: 5,
    });
    expect(store.getPendingPrompt(123, 9)).toEqual({
      conversationId: "123",
      promptMessageId: "9",
      kind: "codex_user_input",
      createdAt: 3,
      sessionKey: "123:demo",
      payloadJson: "{\"ok\":true}",
      expiresAt: 5,
    });
    expect(store.getControlMessage(123, 9)).toEqual({ scopeKey: "123", kind: "codex_user_input" });
    store.setPendingPrompt({
      conversationId: "123",
      promptMessageId: "10",
      kind: "codex_approval",
      createdAt: 4,
      sessionKey: "123:demo",
      expiresAt: 10,
    });
    store.setPendingPrompt({
      conversationId: "123",
      promptMessageId: "12",
      kind: "codex_user_input",
      createdAt: 5,
      sessionKey: "123:demo",
      expiresAt: 4,
    });
    store.setPendingPrompt({
      conversationId: "123",
      promptMessageId: "11",
      kind: "relay_command",
      createdAt: 6,
      sessionKey: "123:demo",
    });
    expect(store.latestPendingPrompt(123, ["codex_user_input", "codex_approval"], 6)?.promptMessageId).toBe("10");
    expect(store.latestPendingPrompt(123, ["relay_command"], 6)?.promptMessageId).toBe("11");
    expect(store.deletePendingPromptsForSession("123:demo", ["codex_user_input", "codex_approval"])).toBe(3);
    expect(store.getPendingPrompt(123, 9)).toBeUndefined();
    expect(store.getPendingPrompt(123, 10)).toBeUndefined();
    expect(store.getPendingPrompt(123, 11)?.kind).toBe("relay_command");
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

  test("binds collaboration mode to the current thread lifecycle", () => {
    const store = tempStore();
    store.markSessionStarted("123:demo", 123, "demo", 4, "thread-1");
    store.setCollaborationMode("123:demo", "plan");
    expect(store.getCollaborationMode("123:demo")).toBe("plan");
    expect(store.getSession("123:demo")?.collaboration_thread_id).toBe("thread-1");

    store.setSessionThreadId("123:demo", "thread-2");
    expect(store.getCollaborationMode("123:demo")).toBe("default");
    expect(store.getSession("123:demo")?.collaboration_thread_id).toBeNull();

    store.setCollaborationMode("123:demo", "plan");
    expect(store.getCollaborationMode("123:demo")).toBe("plan");
    store.markSessionStopped("123:demo", 5);
    expect(store.getCollaborationMode("123:demo")).toBe("default");

    store.markSessionStarted("123:demo", 123, "demo", 6, "thread-2");
    store.setCollaborationMode("123:demo", "plan");
    expect(store.getCollaborationMode("123:demo")).toBe("plan");
    store.markSessionStarted("123:demo", 123, "demo", 7, "thread-2");
    expect(store.getCollaborationMode("123:demo")).toBe("default");
    store.close();
  });

  test("stores and prunes paged outputs", () => {
    const store = tempStore();
    store.setPagedOutput({
      token: "tok",
      conversationId: "123",
      sessionKey: "123:demo",
      text: "long output",
      createdAt: 4,
      expiresAt: 10,
    });
    expect(store.getPagedOutput("tok")).toEqual({
      token: "tok",
      conversationId: "123",
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
    expect(store.getConsoleMessageId(1)).toBe("101");
    expect(store.getHomeStatusMode(1)).toBe("compact");
    store.setHomeStatusMode(1, "details");
    expect(store.getHomeStatusMode(1)).toBe("details");

    const first = store.createTask({ conversationId: "1", workspaceName: "demo", text: "first", status: "queued", createdAt: 1 });
    const second = store.createTask({
      conversationId: "1",
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
    expect(store.activeTask(1, "demo")?.statusMessageId).toBe("501");
    expect(store.nextQueuedTask(1, "demo")?.id).toBe(second.id);
    expect(store.updateTasksByStatus(1, "demo", ["queued", "running"], "cancelled").map((task) => task.id)).toEqual([first.id, second.id]);
    expect(store.countTasks(1, "demo", ["cancelled"])).toBe(2);
    store.close();
  });
});
