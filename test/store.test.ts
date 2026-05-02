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
    store.setPendingPrompt({ chatId: 123, promptMessageId: 9, kind: "workspace_name", createdAt: 3 });
    expect(store.getPendingPrompt(123, 9)).toEqual({ chatId: 123, promptMessageId: 9, kind: "workspace_name", createdAt: 3 });
    store.deletePendingPrompt(123, 9);
    expect(store.getPendingPrompt(123, 9)).toBeUndefined();
    store.close();
  });
});
