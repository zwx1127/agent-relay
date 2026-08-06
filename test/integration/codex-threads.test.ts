import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import type { AgentOutputEvent } from "../../src/ports/agent.ts";
import { cleanupCodexHarness, fakeCodexBin, readLog, sleep } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("CodexDriver thread operations", () => {
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
    expect(resume.params.cwd).toBe(process.cwd());
    expect(resume.params.approvalPolicy).toBe("on-request");
    expect(resume.params.approvalsReviewer).toBe("user");
    expect(resume.params.sandbox).toBe("workspace-write");
    expect(resume.params.initialTurnsPage).toEqual({ limit: 1, sortDirection: "desc", itemsView: "summary" });
    expect(status.latestTurn).toEqual({
      id: "latest-turn",
      status: "completed",
      activities: [{
        itemId: "resume-command",
        activity: { kind: "item", category: "command", label: "git status", status: "completed", detail: "Exit 0", durationMs: 12 },
      }],
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
    });
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
    expect(messages.find((message) => message.method === "thread/fork").params).toMatchObject({
      threadId: "thread-1",
      cwd: "/tmp/demo",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
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

});
