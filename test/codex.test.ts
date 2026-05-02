import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver } from "../src/codex.ts";
import type { AgentOutputEvent } from "../src/types.ts";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("CodexDriver app-server protocol", () => {
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

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "say hello");
    await sleep(100);

    expect(events).toContainEqual({ type: "message", sessionKey: "1:demo", chunk: "hello ", turnId: "turn-1", itemId: "m1" });
    expect(events).toContainEqual({ type: "message", sessionKey: "1:demo", chunk: "world", turnId: "turn-1", itemId: "m1" });
    expect(events).toContainEqual({ type: "turn_completed", sessionKey: "1:demo", turnId: "turn-1" });
    expect(JSON.stringify(events)).not.toContain("raw stdout");
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

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "ask");
    await sleep(100);

    expect(events.at(-1)).toEqual({
      type: "user_input_request",
      sessionKey: "1:demo",
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

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: process.cwd() });
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

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: process.cwd(), threadId: "resume-thread" });

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

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    await driver.runBuiltinCommand(status.sessionKey, "review");
    await driver.runBuiltinCommand(status.sessionKey, "compact");
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

  test("updates session status from app-server metadata notifications", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ chatId: 1, workspaceName: "demo", workspacePath: process.cwd() });
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
});

function fakeCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
  dirs.push(dir);
  const script = join(dir, "codex-fake.js");
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
    send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    if (msg.params.input[0].text === "status please") {
      send({ method: "thread/name/updated", params: { threadId: "thread-1", threadName: "Demo thread" } });
      send({ method: "thread/status/changed", params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId, tokenUsage: { last: { totalTokens: 7 }, total: { totalTokens: 42 }, modelContextWindow: 100 } } });
    } else if (msg.params.input[0].text === "ask") {
      send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId, itemId: "item-1", questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }] } });
    } else {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: "hello " } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId, itemId: "c1", delta: "raw stdout" } });
      send({ method: "item/commandExecution/terminalInteraction", params: { threadId: "thread-1", turnId, itemId: "t1", processId: "p1", stdin: "raw stdin" } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "m1", delta: "world" } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", items: [] } } });
    }
  } else if (msg.method === "turn/steer") {
    send({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } });
  } else if (msg.method === "review/start") {
    send({ id: msg.id, result: { reviewThreadId: "thread-1", turn: { id: "review-turn", status: "inProgress", items: [] } } });
  } else if (msg.method === "thread/compact/start") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/list") {
    send({ id: msg.id, result: { data: [{ id: "listed-thread", name: "Listed", cwd: msg.params.cwd, status: { type: "idle" }, updatedAt: 10, createdAt: 5, preview: "Preview" }] } });
  } else if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.2", model: "gpt-5.2", displayName: "GPT-5.2", isDefault: true, supportedReasoningEfforts: ["low", "medium"] }] } });
  } else if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
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
