import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";
import { cleanupCodexHarness, fakeCodexBin, readLog, sleep } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("CodexDriver server requests and recovery", () => {
  test("fans one shared thread out to multiple Relay scopes and unsubscribes only after the last release", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const first = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd(), threadId: "thread-1" });
    const second = await driver.start({ conversationId: 2, workspaceName: "demo", workspacePath: process.cwd(), threadId: "thread-1" });
    await driver.send(first.sessionKey, "ask");
    await sleep(100);

    expect(events.filter((event) => event.type === "user_input_request").map((event) => event.sessionKey)).toEqual([
      first.sessionKey,
      second.sessionKey,
    ]);
    expect(driver.getStatus(first.sessionKey)?.waitingForUserInput).toBe(true);
    expect(driver.getStatus(second.sessionKey)?.waitingForUserInput).toBe(true);

    await driver.respond(second.sessionKey, 900, { answers: { mode: { answers: ["Fast"] } } });
    expect(events.filter((event) => event.type === "server_request_resolved").map((event) => event.sessionKey)).toEqual([
      first.sessionKey,
      second.sessionKey,
    ]);
    expect(driver.getStatus(first.sessionKey)?.activeTurnId).toBe("turn-1");
    expect(driver.getStatus(second.sessionKey)?.activeTurnId).toBe("turn-1");
    await expect(driver.respond(first.sessionKey, 900, { answers: { mode: { answers: ["Slow"] } } })).rejects.toThrow("already been resolved");

    await driver.release(first.sessionKey);
    expect((readLog(fake).match(/"method":"thread\/unsubscribe"/g) ?? [])).toHaveLength(0);
    await driver.release(second.sessionKey);
    expect((readLog(fake).match(/"method":"thread\/unsubscribe"/g) ?? [])).toHaveLength(1);
  });

  test("normalizes typed MCP form elicitations and returns MCP response metadata", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "mcp form");
    await sleep(100);

    expect(events.at(-1)).toMatchObject({
      type: "mcp_elicitation_request",
      sessionKey: "codex:1:demo",
      requestId: 901,
      serverName: "example",
      mode: "form",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 20 },
          count: { type: "integer", minimum: 1, maximum: 4 },
          choices: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 2 },
        },
      },
    });

    await driver.respond(status.sessionKey, 901, { action: "accept", content: { name: "Ada", count: 2, choices: ["a"] }, _meta: null });
    await sleep(50);
    expect(readLog(fake)).toContain('"id":901,"result":{"action":"accept","content":{"name":"Ada","count":2,"choices":["a"]},"_meta":null}');
    await driver.stop(status.sessionKey);
  });

  test("cancels unsupported openai forms and rejects unknown server requests", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "unsupported requests");
    await sleep(100);
    const log = readLog(fake);

    expect(log).toContain('"id":902,"result":{"action":"cancel","content":null,"_meta":null}');
    expect(log).toContain('"id":903,"error":{"code":-32601');
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "notice" && event.activity.title === "Unsupported MCP form")).toBe(true);
    expect(driver.getStatus(status.sessionKey)?.recentError).toMatch(/disabled|Unsupported/);
    await driver.stop(status.sessionKey);
  });

  test("preserves failed turn error and duration", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      (event) => { events.push(event); },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "failed turn");
    await sleep(100);

    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      sessionKey: "codex:1:demo",
      turnId: "turn-1",
      status: "failed",
      error: { message: "boom", additionalDetails: "details" },
      durationMs: 321,
    });
    expect(driver.getStatus(status.sessionKey)?.recentError).toBe("boom");
    await driver.stop(status.sessionKey);
  });

  test("clears transient app-server errors after a turn recovers", async () => {
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
    await driver.send(status.sessionKey, "recovering error");
    await sleep(100);

    const updated = driver.getStatus(status.sessionKey)!;
    expect(updated.recentError).toBeUndefined();
    expect(events).toContainEqual({ type: "message", sessionKey: "codex:1:demo", chunk: "recovered", turnId: "turn-1", itemId: "m1" });
    expect(events).toContainEqual({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1", status: "completed" });
    await driver.stop(status.sessionKey);
  });});
