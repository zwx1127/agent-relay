import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../src/domain/session.ts";
import { callbackMessage, cleanupRelayFixtures, relayFixture, textMessage } from "../support/relay-fixture.ts";

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
  test("keeps Relay Home and the command surface unchanged when the master gate is disabled", async () => {
    const { router, store, adapter, root } = relayFixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation("1", "demo");

    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).not.toContain("/attach");
    await router.handle(textMessage("/relay"));
    expect(adapter.sent.at(-1)?.options?.replyMarkup?.inline_keyboard.flat().some((button) => button.callback_data === "ar:r")).toBe(false);
    await router.handle(textMessage("/threads"));
    expect(adapter.sent.at(-1)?.text).toContain("Unknown command: /threads");
  });

  test("ordinary messages start fresh instead of attaching active or persisted threads", async () => {
    const { router, store, agent } = experimentalFixture();
    store.markSessionStarted(sessionKey("1", "demo"), "1", "demo", 1, "persisted-thread", "1");
    store.markSessionStopped(sessionKey("1", "demo"), 2);
    agent.threads = [
      { id: "idle-thread", status: "idle" },
      { id: "active-thread", name: "Desktop work", status: "active" },
    ];

    await router.handle(textMessage("continue from IM"));

    expect(agent.sent[0]?.key).toBe(sessionKey("1", "demo"));
    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).not.toBe("active-thread");
    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).not.toBe("persisted-thread");
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("thread-1");
  });

  test("Relay Home Resume reuses the /resume picker", async () => {
    const { router, adapter, agent } = experimentalFixture();
    agent.threads = [{ id: "thread-a", name: "A", status: "active" }];

    await router.handle(textMessage("/relay"));
    const home = adapter.sent.at(-1)!;
    const resume = home.options?.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:r");
    expect(resume?.text).toBe("Resume");
    await router.handle(callbackMessage("ar:r", 7, "cb-resume-home", home.messageId));

    expect(adapter.sent.at(-1)?.text).toContain("Resume chat");
    expect(adapter.sent.at(-1)?.text).toContain("A");
  });

  test("allows two IM scopes to resume the same thread", async () => {
    const { router, store, adapter, agent } = experimentalFixture();
    store.bindConversation("2", "demo");
    agent.threads = [{ id: "shared-thread", name: "Shared", status: "active" }];

    for (const conversationId of ["1", "2"]) {
      await router.handle(textMessage("/resume", 7, undefined, conversationId));
      const picker = adapter.sent.at(-1)!;
      const button = picker.options?.replyMarkup?.inline_keyboard.flat().find((candidate) => candidate.callback_data.startsWith("ar:cmd:resume:"));
      expect(button).toBeDefined();
      await router.handle(callbackMessage(button!.callback_data, 7, `cb-${conversationId}`, picker.messageId, conversationId));
    }

    expect(agent.getStatus(sessionKey("1", "demo"))?.threadId).toBe("shared-thread");
    expect(agent.getStatus(sessionKey("2", "demo"))?.threadId).toBe("shared-thread");
    expect(store.getSession(sessionKey("1", "demo"))?.thread_id).toBe("shared-thread");
    expect(store.getSession(sessionKey("2", "demo"))?.thread_id).toBe("shared-thread");
  });

  test("removes the legacy thread commands even when Relay Work is enabled", async () => {
    const { router, adapter } = experimentalFixture();

    for (const command of ["/threads", "/attach shared-thread", "/detach"]) {
      await router.handle(textMessage(command));
      expect(adapter.sent.at(-1)?.text).toContain(`Unknown command: ${command.split(" ")[0]}`);
    }

    await router.handle(textMessage("/help"));
    expect(adapter.sent.at(-1)?.text).not.toContain("/threads");
    expect(adapter.sent.at(-1)?.text).not.toContain("/attach");
    expect(adapter.sent.at(-1)?.text).not.toContain("/detach");
  });
});
