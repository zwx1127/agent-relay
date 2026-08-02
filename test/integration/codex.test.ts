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
  test("performs the strict initialized handshake and capability probes", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));

    expect(messages.slice(0, 6).map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "collaborationMode/list",
      "thread/start",
      "thread/backgroundTerminals/list",
    ]);
    expect(messages[0]?.params).toMatchObject({
      clientInfo: { name: "agent-relay", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    expect(status.appServerVersion).toBe("0.145.0");
    await driver.stop(status.sessionKey);
  });

  test("rejects Codex versions below the supported floor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-old-codex-"));
    dirs.push(dir);
    const fake = fakeCodexCommandPath(dir);
    writeNodeCommand(fake, `#!/usr/bin/env node
process.stdout.write("codex-cli 0.144.0\\n");
`);
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    await expect(driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() }))
      .rejects.toThrow("requires 0.145.0 or newer");
  });

  test("rejects unparseable Codex version output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-unknown-codex-"));
    dirs.push(dir);
    const fake = fakeCodexCommandPath(dir);
    writeNodeCommand(fake, `#!/usr/bin/env node
process.stdout.write("unknown build\\n");
`);
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    await expect(driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() }))
      .rejects.toThrow("Unable to parse Codex version");
  });

  test("resets failed app-server startup so a later start can retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
    dirs.push(dir);
    const fake = fakeCodexCommandPath(dir);
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
    const fake = fakeCodexCommandPath(dir);
    writeNodeCommand(fake, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.145.0\\n");
  process.exit(0);
}
process.stderr.write("startup failed\\nmore detail\\n");
setTimeout(() => process.exit(1), 20);
`);
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
    const skills = await driver.listSkills("/tmp/demo");
    const files = await driver.searchFiles("/tmp/demo", "read", { limit: 5 });

    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "review/start").params).toEqual({
      threadId: "thread-1",
      target: { type: "uncommittedChanges" },
      delivery: "inline",
    });
    expect(messages.find((message) => message.method === "thread/compact/start").params).toEqual({ threadId: "thread-1" });
    expect(messages.find((message) => message.method === "thread/list").params.cwd).toBe("/tmp/demo");
    expect(messages.find((message) => message.method === "model/list").params.includeHidden).toBe(false);
    expect(messages.find((message) => message.method === "skills/list").params).toEqual({ cwds: ["/tmp/demo"] });
    expect(messages.find((message) => message.method === "fuzzyFileSearch").params).toEqual({ query: "read", roots: ["/tmp/demo"], cancellationToken: null });
    expect(threads[0]?.id).toBe("listed-thread");
    expect(models[0]?.id).toBe("gpt-5.2");
    expect(models[0]?.supportedReasoningEfforts).toEqual(["low", "medium"]);
    expect(skills[0]).toMatchObject({ name: "review", path: "/tmp/SKILL.md", enabled: true });
    expect(files[0]).toEqual({ root: "/tmp/demo", path: "README.md", fileName: "README.md", matchType: "file", score: 10 });
    await driver.stop(status.sessionKey);
  });

  test("synchronizes thread settings and expanded goal states from notifications", async () => {
    const fake = fakeCodexBin();
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request" },
      () => undefined,
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: process.cwd() });
    await driver.send(status.sessionKey, "settings and goal");
    await sleep(100);

    expect(driver.getStatus(status.sessionKey)).toMatchObject({
      model: "gpt-current",
      modelProvider: "openai",
      reasoningEffort: "high",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: "dangerFullAccess",
      threadGoal: { objective: "Wait for quota", status: "usageLimited" },
    });
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

  test("runs side conversations in an ephemeral fork without switching the main thread", async () => {
    const fake = fakeCodexBin();
    const events: AgentOutputEvent[] = [];
    const driver = new CodexDriver(
      { codexBin: fake, sandbox: "workspace-write", approval: "on-request", developerInstructions: "developer text" },
      (event) => {
        events.push(event);
      },
      () => undefined,
    );

    const status = await driver.start({ conversationId: 1, workspaceName: "demo", workspacePath: "/tmp/demo" });
    const result = await driver.sideConversation(status.sessionKey, "side question");

    const messages = readLog(fake).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const fork = messages.find((message) => message.method === "thread/fork" && message.params.ephemeral);
    const injected = messages.find((message) => message.method === "thread/inject_items");
    const turnStart = messages.find((message) => message.method === "turn/start" && message.params.threadId === "side-thread");
    expect(fork.params).toMatchObject({
      threadId: "thread-1",
      cwd: "/tmp/demo",
      ephemeral: true,
      excludeTurns: true,
    });
    expect(typeof fork.params.developerInstructions).toBe("string");
    expect(fork.params.developerInstructions.includes("You are in a side conversation, not the main thread.")).toBe(true);
    expect(fork.params.developerInstructions.includes("developer text")).toBe(true);
    expect(injected.params.threadId).toBe("side-thread");
    expect(JSON.stringify(injected.params.items)).toContain("Side conversation boundary.");
    expect(turnStart.params.input[0].text).toBe("side question");
    expect(messages.find((message) => message.method === "thread/unsubscribe").params).toEqual({ threadId: "side-thread" });
    expect(result).toEqual({ message: "side answer", threadId: "side-thread", turnId: "turn-1" });
    expect(driver.getStatus(status.sessionKey)?.threadId).toBe("thread-1");
    expect(events).toEqual([]);
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

    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", turnId: "turn-1", itemId: "reason-1", activity: { kind: "reasoning", summary: "Safe summary", sectionIndex: 0 } });
    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", turnId: "turn-1", activity: { kind: "plan", explanation: "Do it", steps: [{ step: "Edit file", status: "inProgress" }] } });
    expect(events).toContainEqual({ type: "activity", sessionKey: "codex:1:demo", turnId: "turn-1", activity: { kind: "diff", diff: "diff --git a/a b/a" } });
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
  });
});

function fakeCodexBin(scriptPath?: string): string {
  const dir = scriptPath ? dirname(scriptPath) : mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
  if (!scriptPath) dirs.push(dir);
  const script = scriptPath ?? fakeCodexCommandPath(dir);
  const log = join(dir, "messages.log");
  writeNodeCommand(script, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.145.0\\n");
  process.exit(0);
}
const fs = require("fs");
const readline = require("readline");
const log = ${JSON.stringify(log)};
const rl = readline.createInterface({ input: process.stdin });
let turnCount = 0;
let initialized = false;
const terminals = new Map();
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  fs.appendFileSync(log, line + "\\n");
  const msg = JSON.parse(line);
  if (msg.method === "initialized") {
    initialized = true;
    return;
  }
  if (msg.method !== "initialize" && !initialized) {
    send({ id: msg.id, error: { code: -32002, message: "initialized notification required" } });
    return;
  }
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "codex-cli 0.145.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (msg.method === "thread/start" || msg.method === "thread/resume") {
    send({ id: msg.id, result: { thread: { id: "thread-1", name: "Initial thread", status: { type: "idle" } }, model: "gpt-5.2", modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (msg.method === "turn/start") {
    const turnId = "turn-" + (++turnCount);
    const threadId = msg.params.threadId;
    const inputText = msg.params.input[0].text;
    const startTurn = () => send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    if (inputText === "slow active") {
      setTimeout(startTurn, 50);
    } else {
      startTurn();
    }
    if (inputText === "status please") {
      send({ method: "thread/name/updated", params: { threadId, threadName: "Demo thread" } });
      send({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { totalTokens: 7 }, total: { totalTokens: 42 }, modelContextWindow: 100 } } });
    } else if (inputText === "settings and goal") {
      send({ method: "thread/settings/updated", params: { threadId, threadSettings: { cwd: "/tmp", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null, model: "gpt-current", modelProvider: "openai", serviceTier: null, effort: "high", summary: null, collaborationMode: { mode: "default", settings: { model: "gpt-current", reasoning_effort: "high", developer_instructions: null } }, multiAgentMode: "explicitRequestOnly", personality: null } } });
      send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { threadId, objective: "Wait for quota", status: "blocked", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } } });
      send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { threadId, objective: "Wait for quota", status: "usageLimited", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2, createdAt: 1, updatedAt: 3 } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "warn please") {
      send({ method: "warning", params: { threadId, message: "Under-development features enabled: goals" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "recovering error") {
      send({ method: "error", params: { threadId, error: { message: "Reconnecting... 5/5", codexErrorInfo: { message: "Stream disconnected before completion: remote host closed the connection (os error 10054)" } } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: "recovered" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "ask") {
      send({ id: 900, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: "item-1", questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [{ label: "Fast", description: "Quick" }] }] } });
    } else if (inputText === "mcp form") {
      send({ id: 901, method: "mcpServer/elicitation/request", params: { threadId, turnId, serverName: "example", mode: "form", message: "Configure", _meta: null, requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 2, maxLength: 20 }, count: { type: "integer", minimum: 1, maximum: 4 }, choices: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 2 } }, required: ["name"] } } });
    } else if (inputText === "unsupported requests") {
      send({ id: 902, method: "mcpServer/elicitation/request", params: { threadId, turnId, serverName: "example", mode: "openai/form", message: "Unsupported", _meta: null, requestedSchema: {} } });
      send({ id: 903, method: "item/tool/call", params: { threadId, turnId, callId: "dynamic-1", tool: "unsafe", arguments: {} } });
    } else if (inputText === "failed turn") {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [], itemsView: { type: "full" }, error: { message: "boom", codexErrorInfo: null, additionalDetails: "details" }, startedAt: 1, completedAt: 2, durationMs: 321 } } });
    } else if (inputText === "plan please") {
      send({ method: "item/plan/delta", params: { threadId, turnId, itemId: "p1", delta: "Plan item" } });
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "exitedReviewMode", id: "r1", review: "Review summary" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "image output") {
      send({ method: "rawResponseItem/completed", params: { threadId, turnId, item: { type: "image_generation_call", id: "img1", status: "completed", revised_prompt: "revised", result: "aW1hZ2U=" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText === "activity please") {
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reason-1", delta: "Safe summary", summaryIndex: 0 } });
      send({ method: "item/reasoning/textDelta", params: { threadId, turnId, itemId: "reason-1", delta: "secret chain", contentIndex: 0 } });
      send({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "Do it", plan: [{ step: "Edit file", status: "inProgress" }] } });
      send({ method: "turn/diff/updated", params: { threadId, turnId, diff: "diff --git a/a b/a" } });
      send({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: "file-1", changes: [{ path: "a", kind: "update", diff: "raw patch" }], status: "inProgress" } } });
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: "file-1", changes: [{ path: "a", kind: "update", diff: "raw patch" }], status: "completed" } } });
      send({ method: "guardianWarning", params: { threadId, message: "Check this action" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], durationMs: 25 } } });
    } else if (inputText === "background terminal") {
      terminals.set("proc1", { itemId: "bg1", processId: "proc1", command: "bash -lc 'npm run dev'" });
      send({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: "bg1", command: "bash -lc 'npm run dev'", processId: "proc1", source: "unifiedExecStartup", commandActions: [] } } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "bg1", delta: "ready\\nline2\\nline3\\nline4\\n" } });
      send({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: "local1", command: "git status", source: "userShell", commandActions: [] } } });
    } else if (inputText === "side question") {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "side-message", delta: "side answer" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    } else if (inputText !== "slow active") {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: "hello " } });
      send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "c1", delta: "raw stdout" } });
      send({ method: "item/commandExecution/terminalInteraction", params: { threadId, turnId, itemId: "t1", processId: "p1", stdin: "raw stdin" } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: "world" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    }
  } else if (msg.method === "turn/steer") {
    const inputText = msg.params.input[0].text;
    if (inputText === "second while active") {
      send({ id: msg.id, result: { turn: { id: msg.params.expectedTurnId, status: "inProgress", items: [] } } });
    } else if (inputText === "finish background terminal") {
      terminals.delete("proc1");
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
    const threadId = msg.params.ephemeral ? "side-thread" : "fork-thread";
    send({ id: msg.id, result: { thread: { id: threadId, name: msg.params.ephemeral ? "Side thread" : "Forked thread", status: { type: "idle" }, ephemeral: Boolean(msg.params.ephemeral) }, model: "gpt-5.2", modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (msg.method === "thread/inject_items") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/unsubscribe") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/name/set") {
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/archive") {
    send({ id: msg.id, result: {} });
    send({ method: "thread/archived", params: { threadId: msg.params.threadId } });
  } else if (msg.method === "thread/delete") {
    send({ id: msg.id, result: {} });
    send({ method: "thread/deleted", params: { threadId: msg.params.threadId } });
  } else if (msg.method === "thread/backgroundTerminals/clean") {
    terminals.clear();
    send({ id: msg.id, result: {} });
  } else if (msg.method === "thread/backgroundTerminals/list") {
    send({ id: msg.id, result: { data: [...terminals.values()], nextCursor: null } });
  } else if (msg.method === "thread/backgroundTerminals/terminate") {
    const terminated = terminals.delete(msg.params.processId);
    send({ id: msg.id, result: { terminated } });
  } else if (msg.method === "thread/list") {
    send({ id: msg.id, result: { data: [{ id: "listed-thread", name: "Listed", cwd: msg.params.cwd, status: { type: "idle" }, updatedAt: 10, createdAt: 5, preview: "Preview" }] } });
  } else if (msg.method === "model/list") {
    send({ id: msg.id, result: { data: [{ id: "gpt-5.2", model: "gpt-5.2", displayName: "GPT-5.2", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }] }] } });
  } else if (msg.method === "collaborationMode/list") {
    send({ id: msg.id, result: { data: [{ name: "Default", mode: "default", model: "gpt-5.2", reasoningEffort: "medium" }, { name: "Plan", mode: "plan", model: "gpt-5.2", reasoningEffort: "medium" }] } });
  } else if (msg.method === "skills/list") {
    send({ id: msg.id, result: { data: [{ cwd: msg.params.cwds[0], skills: [{ name: "review", description: "Review changes", path: "/tmp/SKILL.md", scope: "user", enabled: true }], errors: [] }] } });
  } else if (msg.method === "fuzzyFileSearch") {
    send({ id: msg.id, result: { files: [{ root: msg.params.roots[0], path: "README.md", file_name: "README.md", match_type: "file", score: 10, indices: [0] }] } });
  } else if (msg.method === "turn/interrupt") {
    if (msg.params.turnId === "stale-turn") {
      send({ id: msg.id, error: { code: -32000, message: "no active turn to interrupt" } });
    } else {
      send({ id: msg.id, result: {} });
    }
  }
});
`);
  return script;
}

function fakeCodexCommandPath(dir: string): string {
  return join(dir, process.platform === "win32" ? "codex-fake" : "codex-fake.js");
}

function writeNodeCommand(commandPath: string, scriptText: string): void {
  if (process.platform !== "win32") {
    writeFileSync(commandPath, scriptText);
    chmodSync(commandPath, 0o755);
    return;
  }
  const commandFile = commandPath.toLowerCase().endsWith(".cmd") ? commandPath : `${commandPath}.cmd`;
  const scriptPath = commandFile.replace(/\.cmd$/i, ".js");
  writeFileSync(scriptPath, scriptText);
  writeFileSync(commandFile, `@echo off\r\n"${process.execPath}" "%~dp0${scriptPath.split(/[\\/]/).at(-1)}" %*\r\n`);
}

function readLog(fakeBin: string): string {
  return readFileSync(join(fakeBin, "..", "messages.log"), "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
