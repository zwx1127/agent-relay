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

  test("reconciles a missed terminal event before starting the next turn", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "missing terminal completed");
    expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBe("turn-1");

    await driver.send(status.sessionKey, "say hello");
    await sleep(100);

    expect(events.filter((event) => event.type === "turn_completed" && event.turnId === "turn-1")).toEqual([{
      type: "turn_completed",
      sessionKey: status.sessionKey,
      turnId: "turn-1",
      status: "completed",
      durationMs: 1000,
    }]);
    const methods = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line).method);
    expect(methods).toContain("thread/read");
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(2);
    await driver.stop(status.sessionKey);
  });

  test("fails an orphaned in-progress turn when the authoritative thread is idle", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "inconsistent idle turn");
    await driver.send(status.sessionKey, "say hello");
    await sleep(100);

    const recovered = events.find((event) => event.type === "turn_completed" && event.turnId === "turn-1");
    expect(recovered).toMatchObject({ type: "turn_completed", status: "failed" });
    expect(recovered?.type === "turn_completed" ? recovered.error?.message : "").toContain("terminal event is missing");
    await driver.stop(status.sessionKey);
  });

  test("ignores duplicate terminal notifications", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "duplicate completion");
    await sleep(100);

    expect(events.filter((event) => event.type === "turn_completed" && event.turnId === "turn-1")).toHaveLength(1);
    await driver.stop(status.sessionKey);
  });

  test("a late old completion does not clear a newer active turn", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "late old setup");
    await driver.send(status.sessionKey, "new turn with late old completion");
    await sleep(100);

    expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBe("turn-2");
    await driver.stop(status.sessionKey);
  });

  test("marks a quiet failed-command turn stalled and restores working on progress", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request", stallTimeoutMs: 30 },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "failed command stalls");
    await sleep(100);

    expect(events).toContainEqual({
      type: "turn_stalled",
      sessionKey: status.sessionKey,
      threadId: "thread-1",
      turnId: "turn-1",
      detail: "No Codex events for 5 minutes after a failed command. The turn is still active; interrupt it if needed.",
    });
    expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBe("turn-1");

    await driver.send(status.sessionKey, "second while active");
    expect(events).toContainEqual({
      type: "turn_progressed",
      sessionKey: status.sessionKey,
      threadId: "thread-1",
      turnId: "turn-1",
    });
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
