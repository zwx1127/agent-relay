import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";
import { cleanupCodexHarness, fakeCodexBin, readLog, sleep } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("CodexDriver activity events", () => {
  test("emits plan deltas and completed review items as visible output", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => {
        events.push(event);
      },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "plan please", { collaborationMode: "plan" });
    await sleep(100);

    expect(events).toContainEqual({ type: "message", sessionKey: "codex:1:demo", chunk: "Plan item", turnId: "turn-1", itemId: "p1" });
    expect(events).toContainEqual({ type: "message", sessionKey: "codex:1:demo", chunk: "Review summary", turnId: "turn-1", itemId: "r1" });
    const turnStart = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "turn/start" && message.params.input[0].text === "plan please");
    expect(turnStart.params.collaborationMode.mode).toBe("plan");
    await driver.stop(status.sessionKey);
  });

  test("sends explicit default collaboration mode when requested", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "implement", { collaborationMode: "default" });

    const turnStart = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "turn/start" && message.params.input[0].text === "implement");
    expect(turnStart.params.collaborationMode.mode).toBe("default");
    await driver.stop(status.sessionKey);
  });

  test("serializes all structured Codex input variants in order", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "inspect", { attachments: [
      { type: "image", url: "https://example.test/image.png" },
      { type: "localImage", path: "/tmp/image.jpg" },
      { type: "audio", url: "https://example.test/audio.mp3" },
      { type: "localAudio", path: "/tmp/audio.ogg" },
      { type: "skill", name: "review", path: "/tmp/SKILL.md" },
      { type: "mention", name: "README.md", path: "/tmp/README.md" },
    ] });

    const turnStart = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "turn/start");
    expect(turnStart.params.input).toEqual([
      { type: "text", text: "inspect", text_elements: [] },
      { type: "image", url: "https://example.test/image.png" },
      { type: "localImage", path: "/tmp/image.jpg" },
      { type: "audio", url: "https://example.test/audio.mp3" },
      { type: "localAudio", path: "/tmp/audio.ogg" },
      { type: "skill", name: "review", path: "/tmp/SKILL.md" },
      { type: "mention", name: "README.md", path: "/tmp/README.md" },
    ]);
    await driver.stop(status.sessionKey);
  });

  test("emits image generation outputs", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => {
        events.push(event);
      },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "image output");
    await sleep(100);

    expect(events).toContainEqual({
      type: "image",
      sessionKey: "codex:1:demo",
      data: "aW1hZ2U=",
      caption: "revised",
      turnId: "turn-1",
      itemId: "img1",
    });
    await driver.stop(status.sessionKey);
  });

  test("updates session status from app-server metadata notifications", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "status please");
    await sleep(100);

    const updated = driver.getStatus(status.sessionKey)!;
    expect(updated.threadName).toBe("Demo thread");
    expect(updated.threadStatus).toBe("active");
    expect(updated.waitingForApproval).toBe(true);
    expect(updated.tokenUsage?.total?.totalTokens).toBe(42);
    expect(updated.contextWindow).toBe(100);
    expect(updated.model).toBe("gpt-5.2");
    expect(updated.reasoningEffort).toBe("medium");
    await driver.stop(status.sessionKey);
  });

  test("tracks app-server warnings separately from errors", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "warn please");
    await sleep(100);

    const updated = driver.getStatus(status.sessionKey)!;
    expect(updated.recentWarning).toBe("Under-development features enabled: goals");
    expect(updated.recentError).toBeUndefined();
    await driver.stop(status.sessionKey);
  });

  test("normalizes activity notifications and isolates raw reasoning", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "activity please");
    await sleep(100);

    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", activity: { kind: "reasoning", summary: "Safe summary", sectionIndex: 0 } });
    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-1", turnId: "turn-1", activity: { kind: "plan", explanation: "Do it", steps: [{ step: "Edit file", status: "inProgress" }] } });
    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", threadId: "thread-1", turnId: "turn-1", activity: { kind: "diff", diff: "diff --git a/a b/a" } });
    expect(events.some((event) => event.type === "message" && event.chunk.includes("secret chain"))).toBe(false);
    await driver.stop(status.sessionKey);
  });

  test("emits idempotent lifecycle events for archive and removes the session", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    await driver.archiveThread(status.sessionKey);
    await sleep(50);

    expect(events).toContainEqual({
      type: "thread_lifecycle",
      sessionKey: "codex:1:demo",
      threadId: "thread-1",
      action: "archived",
      initiatedByClient: true,
    });
    expect(driver.getStatus(status.sessionKey)).toBeUndefined();
    await driver.stop(status.sessionKey);
  });

});
