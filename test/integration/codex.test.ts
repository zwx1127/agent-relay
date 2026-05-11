import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("CodexDriver app-server protocol", () => {
  test("resets failed app-server startup so a later start can retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
    dirs.push(dir);
    const fake = join(dir, "codex-fake.js");
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    await expect(driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() })).rejects.toThrow("Failed to start Codex app-server");

    fakeCodexBin(fake);
    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });

    expect(status.threadId).toBe("thread-1");
    await driver.stop(status.sessionKey);
  });

  test("includes recent app-server stderr when startup exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-failing-codex-"));
    dirs.push(dir);
    const fake = join(dir, "codex-fake.js");
    writeFileSync(fake, `#!/usr/bin/env node
process.stderr.write("startup failed\\nmore detail\\n");
setTimeout(() => process.exit(1), 20);
`);
    chmodSync(fake, 0o755);
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    let error: unknown;
    try {
      await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Codex app-server exited with code 1.");
    expect((error as Error).message).toContain("startup failed");
    expect((error as Error).message).toContain("more detail");
    expect((error as Error).message).toContain("CODEX_BIN=");
  });

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
    expect(events).toContainEqual({ type: "turn_completed", sessionKey: "codex:1:demo", turnId: "turn-1" });
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
      commandDisplay: "npm run dev",
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

  test("injects developer and base instructions into thread start and resume", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      {
        codexBin: fake,
        sandbox: "workspace-write",
        approval: "on-request",
        developerInstructions: "developer text",
        baseInstructions: "base text",
      },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd(), threadId: "resume-thread" });

    const resume = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "thread/resume");
    expect(resume.params.developerInstructions).toBe("developer text");
    expect(resume.params.baseInstructions).toBe("base text");
    expect(resume.params.threadId).toBe("resume-thread");
    await driver.stop(status.sessionKey);
  });

  test("sends built-in command and listing payloads", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    await driver.runBuiltinCommand(status.sessionKey, { type: "review" });
    await driver.runBuiltinCommand(status.sessionKey, { type: "compact" });
    const threads = await driver.listThreads({ workspacePath: "/tmp/demo", limit: 5 });
    const models = await driver.listModels();

    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "review/start").params).toEqual({
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    expect(messages.find((message) => message.method === "thread/compact/start").params).toEqual({ threadId: "thread-1" });
    expect(messages.find((message) => message.method === "thread/list").params.cwd).toBe("/tmp/demo");
    expect(messages.find((message) => message.method === "model/list").params.includeHidden).toBe(false);
    expect(threads[0]?.id).toBe("listed-thread");
    expect(models[0]?.id).toBe("gpt-5.2");
    await driver.stop(status.sessionKey);
  });

  test("sends thread goal payloads", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    const existing = await driver.getThreadGoal(status.sessionKey);
    const updated = await driver.setThreadGoal(status.sessionKey, { objective: "Ship feature", status: "active", tokenBudget: null });
    const cleared = await driver.clearThreadGoal(status.sessionKey);

    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "thread/goal/get").params).toEqual({ threadId: "thread-1" });
    expect(messages.find((message) => message.method === "thread/goal/set").params).toEqual({
      threadId: "thread-1",
      objective: "Ship feature",
      status: "active",
      tokenBudget: null,
    });
    expect(messages.find((message) => message.method === "thread/goal/clear").params).toEqual({ threadId: "thread-1" });
    expect(existing?.status).toBe("budgetLimited");
    expect(updated.objective).toBe("Ship feature");
    expect(cleared).toBe(true);
    await driver.stop(status.sessionKey);
  });

  test("sends thread management command payloads", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    const forked = await driver.forkThread(status.sessionKey);
    await driver.renameThread(status.sessionKey, "New name");
    await driver.cleanBackgroundTerminals(status.sessionKey);

    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "thread/fork").params.threadId).toBe("thread-1");
    expect(messages.find((message) => message.method === "thread/name/set").params).toEqual({ threadId: "fork-thread", name: "New name" });
    expect(messages.find((message) => message.method === "thread/backgroundTerminals/clean").params).toEqual({ threadId: "fork-thread" });
    expect(forked.threadId).toBe("fork-thread");
    expect(driver.getStatus(status.sessionKey)?.threadName).toBe("New name");
    await driver.stop(status.sessionKey);
  });

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

  test("sends local images as Codex turn input", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "inspect", { images: [{ path: "/tmp/image.jpg" }] });

    const turnStart = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.method === "turn/start");
    expect(turnStart.params.input).toEqual([
      { type: "text", text: "inspect", text_elements: [] },
      { type: "localImage", path: "/tmp/image.jpg" },
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
});

function fakeCodexBin(scriptPath?: string): string {
  const dir = scriptPath ? dirname(scriptPath) : mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
  if (!scriptPath) dirs.push(dir);
  const script = scriptPath ?? join(dir, "codex-fake.js");
  const log = join(dir, "messages.log");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("fs");
const readline = require("readline");
const log = ${JSON.stringify(log)};
const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  fs.appendFileSync(log, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    send({ id: msg.id, result: { thread: { id: "thread-1", name: "Initial thread", status: { type: "idle" } }, model: "gpt-5.2", modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (msg.method === "turn/start") {
    const turnId = "turn-" + (++turnCount);
    const inputText = msg.params.input[0].text;
    const startTurn = () => send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    if (inputText === "slow active") {
      setTimeout(startTurn, 50);
    } else {
      startTurn();
    }
    if (inputText === "status please") {
      send({ method: "thread/name/updated", params: { threadId: "thread-1", threadName: "Demo thread" } });
      send({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { totalTokens: 7 }, total: { totalTokens: 42 }, modelContextWindow: 100 } } });
    } else if (inputText === "warn please") {
      send({ method: "warning", params: { threadId: "thread-1", message: "Under-development features enabled: goals" } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "ask") {
      send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId, itemId: "item-1", questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }] } });
    } else if (inputText === "plan please") {
      send({ method: "item/plan/delta", params: { threadId: "thread-1", turnId, itemId: "p1", delta: "Plan item" } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { type: "exitedReviewMode", id: "r1", review: "Review summary" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "image output") {
      send({ method: "rawResponseItem/completed", params: { threadId: "thread-1", turnId, item: { type: "image_generation_call", id: "img1", status: "completed", revised_prompt: "revised", result: "aW1hZ2U=" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "background terminal") {
      send({ method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "commandExecution", id: "bg1", command: "bash -lc 'npm run dev'", processId: "proc1", source: "unifiedExecStartup", commandActions: [] } } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId, itemId: "bg1", delta: "ready\\nline2\\nline3\\nline4\\n" } });
      send({ method: "item/started", params: { threadId: "thread-1", turnId, item: { type: "commandExecution", id: "local1", command: "git status", source: "userShell", commandActions: [] } } });
    } else if (inputText !== "slow active") {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: "hello " } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId, itemId: "c1", delta: "raw stdout" } });
      send({ method: "item/commandExecution/terminalInteraction", params: { threadId: "thread-1", turnId, itemId: "t1", processId: "p1", stdin: "raw stdin" } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: "world" } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
    }
  } else if (msg.method === "turn/steer") {
    const inputText = msg.params.input[0].text;
    if (inputText === "second while active") {
      send({ id: msg.id, result: { turn: { id: msg.params.expectedTurnId, status: "inProgress", items: [] } } });
    } else if (inputText === "finish background terminal") {
      send({ id: msg.id, result: { turn: { id: msg.params.expectedTurnId, status: "inProgress", items: [] } } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: msg.params.expectedTurnId, item: { type: "commandExecution", id: "bg1", command: "bash -lc 'npm run dev'", processId: "proc1", source: "unifiedExecStartup", commandActions: [] } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: msg.params.expectedTurnId, status: "completed", items: [] } } });
    } else {
      send({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } });
    }
  } else if (msg.method === "review/start") {
    send({ id: msg.id, result: { reviewThreadId: "thread-1", turn: { id: "review-turn", status: "inProgress", items: [] } } });
  } else if (msg.method === "thread/compact/start") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/goal/get") {
    send({ id: msg.id, result: { goal: { threadId: "thread-1", objective: "Existing goal", status: "budgetLimited", tokenBudget: 50000, tokensUsed: 63900, timeUsedSeconds: 120, createdAt: 1, updatedAt: 2 } } });
  } else if (msg.method === "thread/goal/set") {
    send({ id: msg.id, result: { goal: { threadId: msg.params.threadId, objective: msg.params.objective || "Existing goal", status: msg.params.status || "active", tokenBudget: msg.params.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 3 } } });
  } else if (msg.method === "thread/goal/clear") {
    send({ id: msg.id, result: { cleared: true } });
  } else if (msg.method === "thread/fork") {
    send({ id: msg.id, result: { thread: { id: "fork-thread", name: "Forked thread", status: { type: "idle" } }, model: "gpt-5.2", modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (msg.method === "thread/name/set") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/backgroundTerminals/clean") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/list") {
    send({ id: msg.id, result: { data: [{ id: "listed-thread", name: "Listed", cwd: msg.params.cwd, status: { type: "idle" }, updatedAt: 10, createdAt: 5, preview: "Preview" }] } });
  } else if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.2", model: "gpt-5.2", displayName: "GPT-5.2", isDefault: true, supportedReasoningEfforts: ["low", "medium"] }] } });
  } else if (msg.method === "turn/interrupt") {
    if (msg.params.turnId === "stale-turn") {
      send({ id: msg.id, error: { code: -32000, message: "no active turn to interrupt" } });
    } else {
      send({ id: msg.id, result: {} });
    }
  }
});
`);
  chmodSync(script, 0o755);
  return script;
}

function readLog(fakeBin: string): string {
  return readFileSync(join(fakeBin, "..", "messages.log"), "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
