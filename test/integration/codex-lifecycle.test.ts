import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import { cleanupCodexHarness, createCodexTempDir, fakeCodexBin, fakeCodexCommandPath, readLog, writeNodeCommand } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("CodexDriver app-server lifecycle", () => {
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
    const dir = createCodexTempDir("agent-relay-old-codex-");
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
    const dir = createCodexTempDir("agent-relay-unknown-codex-");
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
    const dir = createCodexTempDir("agent-relay-fake-codex-");
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
    const dir = createCodexTempDir("agent-relay-failing-codex-");
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

});
