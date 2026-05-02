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

    expect(events).toContainEqual({ type: "message", sessionKey: "1:demo", chunk: "hello " });
    expect(events).toContainEqual({ type: "message", sessionKey: "1:demo", chunk: "world" });
    expect(events).toContainEqual({ type: "turn_completed", sessionKey: "1:demo" });
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
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  fs.appendFileSync(log, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    send({ id: msg.id, result: { thread: { id: "thread-1" } } });
  } else if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn-1", status: "running", items: [] } } });
    if (msg.params.input[0].text === "ask") {
      send({ id: 900, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }] } });
    } else {
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "hello " } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "c1", delta: "raw stdout" } });
      send({ method: "item/commandExecution/terminalInteraction", params: { threadId: "thread-1", turnId: "turn-1", itemId: "t1", processId: "p1", stdin: "raw stdin" } });
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "m1", delta: "world" } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    }
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
