import { describe, expect, test } from "bun:test";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";

describe("backend-bound persisted Relay state", () => {
  test("populated legacy state stays Codex-owned and queued prompts are never reinterpreted", () => {
    const store = new SQLiteStore(":memory:");
    try {
      store.upsertWorkspace({ name: "demo", path: "/tmp/demo", createdAt: 1 });
      store.createTask({ conversationId: 1, workspaceName: "demo", text: "Codex-only pending work", status: "queued" });
      expect(() => store.bindAgentProvider("claude")).toThrow("belongs to codex");
      expect(() => store.bindAgentProvider("dsh")).toThrow("belongs to codex");
      expect(store.nextQueuedTask(1, "demo")?.text).toBe("Codex-only pending work");
      store.bindAgentProvider("codex");
      expect(store.countTasks(1, "demo", ["queued"])).toBe(1);
    } finally { store.close(); }
  });
  test("an empty database can bind once to a native provider, with repeat starts allowed", () => {
    const store = new SQLiteStore(":memory:");
    try {
      store.bindAgentProvider("dsh");
      store.bindAgentProvider("dsh");
      expect(() => store.bindAgentProvider("claude")).toThrow("belongs to dsh");
      expect(() => store.bindAgentProvider("codex")).toThrow("belongs to dsh");
    } finally { store.close(); }
  });
});
