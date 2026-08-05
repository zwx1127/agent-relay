import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import { cleanupRelayFixtures, relayFixture, textMessage } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

function experimentalFixture() {
  const result = relayFixture("info", { experimentalRelayWorkEnabled: true });
  const path = join(result.root, "demo");
  mkdirSync(path);
  result.store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
  result.store.bindConversation("1", "demo");
  return { ...result, path };
}

describe("experimental relay work behavior", () => {
  test("keeps commands and help hidden when the master gate is disabled", async () => {
    const { router, store, adapter, root } = relayFixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation("1", "demo");

    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).not.toContain("/attach");
    await router.handle(textMessage("/threads"));
    expect(adapter.sent.at(-1)?.text).toContain("Unknown command: /threads");
  });

  test("automatically attaches the only active shared thread", async () => {
    const { router, store, agent } = experimentalFixture();
    agent.threads = [
      { id: "idle-thread", status: "idle" },
      { id: "active-thread", name: "Desktop work", status: "active" },
    ];

    await router.handle(textMessage("continue from IM"));

    expect(agent.sent[0]?.key).toBe(sessionKey("1", "demo"));
    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).toBe("active-thread");
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("active-thread");
  });

  test("shows the thread picker instead of guessing when several threads are active", async () => {
    const { router, adapter, agent } = experimentalFixture();
    agent.threads = [
      { id: "thread-a", name: "A", status: "active" },
      { id: "thread-b", name: "B", status: "active" },
    ];

    await router.handle(textMessage("continue from IM"));

    expect(agent.sent).toEqual([]);
    expect(adapter.sent.at(-1)?.text).toContain("Resume chat");
    expect(adapter.sent.at(-1)?.text).toContain("A");
    expect(adapter.sent.at(-1)?.text).toContain("B");
  });

  test("attaches and detaches a shared thread explicitly", async () => {
    const { router, store, adapter, agent } = experimentalFixture();
    agent.threads = [{ id: "thread-abcdef", name: "Desktop work", status: "idle" }];

    await router.handle(textMessage("/attach thread-abc"));
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("thread-abcdef");
    expect(adapter.sent.at(-1)?.text).toContain("Attached shared thread");

    await router.handle(textMessage("/detach"));
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBeNull();
    expect(adapter.sent.at(-1)?.text).toContain("Detached shared thread");
  });

  test("refuses to attach one thread to two writable IM scopes", async () => {
    const { router, store, adapter, agent } = experimentalFixture();
    agent.threads = [{ id: "shared-thread", status: "idle" }];
    store.markSessionStarted(sessionKey("2", "demo"), "2", "demo", 1, "shared-thread", "2");

    await router.handle(textMessage("/attach shared-thread"));

    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).not.toBe("shared-thread");
    expect(adapter.sent.at(-1)?.text).toContain("already attached to IM scope 2");
  });
});
