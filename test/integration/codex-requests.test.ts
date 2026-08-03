import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";
import { cleanupCodexHarness, fakeCodexBin, readLog, sleep } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("CodexDriver request ordering", () => {
  test("emits only assistant deltas and ignores command and terminal output", async () => {
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
    await driver.send(status.sessionKey, "say hello");
    await sleep(100);

    expect(events).toContainEqual({ type: "message", sessionKey: "codex:1:demo", chunk: "hello ", turnId: "turn-1", itemId: "m1" });
    expect(events).toContainEqual({ type: "message", sessionKey: "codex:1:demo", chunk: "world", turnId: "turn-1", itemId: "m1" });
    expect(events).toContainEqual({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1", status: "completed" });
    expect(JSON.stringify(events)).not.toContain("raw stdout");
    await driver.stop(status.sessionKey);
  });

  test("tracks only Codex unified exec background terminals", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "background terminal");
    await sleep(100);

    expect(await driver.listBackgroundTerminals(status.sessionKey)).toEqual([{
      itemId: "bg1",
      processId: "proc1",
      commandDisplay: "bash -lc 'npm run dev'",
      osPid: null,
      cpuPercent: null,
      rssKb: null,
      recentChunks: ["line2", "line3", "line4"],
    }]);

    await driver.send(status.sessionKey, "finish background terminal");
    await sleep(100);
    expect(await driver.listBackgroundTerminals(status.sessionKey)).toEqual([]);
    await driver.stop(status.sessionKey);
  });

  test("parses requestUserInput and sends response on the same request id", async () => {
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
    await driver.send(status.sessionKey, "ask");
    await sleep(100);

    expect(events.at(-1)).toEqual({
      type: "user_input_request",
      sessionKey: "codex:1:demo",
      requestId: 900,
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "mode",
        header: "Mode",
        question: "Pick one.",
        options: [{ label: "Fast", description: "Quick" }],
      }],
    });

    await driver.respond(status.sessionKey, 900, { answers: { mode: { answers: ["Fast"] } } });
    await sleep(100);
    expect(readLog(fake)).toContain('"id":900,"result":{"answers":{"mode":{"answers":["Fast"]}}}');
    await driver.stop(status.sessionKey);
  });

  test("retries stale turn steering as a new turn", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "ask");
    await driver.send(status.sessionKey, "after stale");

    const methods = readLog(fake)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).method)
      .filter((method) => method === "turn/start" || method === "turn/steer");
    expect(methods).toEqual(["turn/start", "turn/steer", "turn/start"]);
    await driver.stop(status.sessionKey);
  });

  test("serializes quick inputs so follow-up steers the active turn", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await Promise.all([
      driver.send(status.sessionKey, "slow active"),
      driver.send(status.sessionKey, "second while active"),
    ]);

    const methods = readLog(fake)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).method)
      .filter((method) => method === "turn/start" || method === "turn/steer");
    expect(methods).toEqual(["turn/start", "turn/steer"]);
    await driver.stop(status.sessionKey);
  });

  test("interrupts an active turn without stopping the session", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "slow active");

    const result = await driver.interrupt(status.sessionKey);

    expect(result).toEqual({ interrupted: true, turnId: "turn-1" });
    expect(driver.getStatus(status.sessionKey)?.running).toBe(true);
    expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBeUndefined();
    const interrupt = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await driver.stop(status.sessionKey);
  });

  test("recovers stale active turn state when interrupt reports no active turn", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "slow active");
    status.activeTurnId = "stale-turn";
    status.waitingForApproval = true;
    status.waitingForUserInput = true;

    const result = await driver.interrupt(status.sessionKey);

    expect(result).toEqual({ interrupted: false, turnId: "stale-turn", stale: true });
    expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBeUndefined();
    expect(driver.getStatus(status.sessionKey)?.waitingForApproval).toBe(false);
    expect(driver.getStatus(status.sessionKey)?.waitingForUserInput).toBe(false);
    await driver.stop(status.sessionKey);
  });

});
