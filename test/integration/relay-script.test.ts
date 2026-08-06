import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const unixOnlyTest = process.platform === "win32" ? test.skip : test;

let roots: string[] = [];
const fastRelayEnv = {
  ...process.env,
  AGENT_RELAY_START_CHECK_DELAY_SECONDS: "0.05",
  AGENT_RELAY_STOP_POLL_INTERVAL_SECONDS: "0.05",
  AGENT_RELAY_RESTART_WORKER_DELAY_SECONDS: "0.05",
  AGENT_RELAY_STOP_TIMEOUT_SECONDS: "2",
};

afterEach(() => {
  for (const root of roots) {
    spawnSync(join(root, "scripts", "relay.sh"), ["stop"], { cwd: root, encoding: "utf8", env: fastRelayEnv });
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

describe("relay lifecycle script", () => {
  unixOnlyTest("does not expose Gateway lifecycle commands", () => {
    const root = createFixture();
    const result = runRelay(root, "gateway-start");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("gateway-start|");
  });

  unixOnlyTest("restart stops the relay, removes data, and starts a fresh process", async () => {
    const root = createFixture();
    expectSuccess(runRelay(root, "start"));
    const firstPid = readPid(root);
    expect(pidIsAlive(firstPid)).toBe(true);

    const sentinel = join(root, ".data", "sentinel");
    writeFileSync(sentinel, "old data");

    const restart = runRelay(root, "restart");
    expectSuccess(restart);
    expect(restart.stdout).toContain("removed ");

    const secondPid = readPid(root);
    expect(secondPid).not.toBe(firstPid);
    expect(pidIsAlive(secondPid)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);

    await waitFor(() => !pidIsAlive(firstPid), "old relay process to exit");
  });

  unixOnlyTest("self restart survives cleanup of the calling process group", async () => {
    const root = createFixture();
    expectSuccess(runRelay(root, "start"));
    const firstPid = readPid(root);
    const sentinel = join(root, ".data", "sentinel");
    writeFileSync(sentinel, "old data");

    writeFileSync(join(root, "trigger-self-restart"), "1");
    await waitFor(() => existsSync(join(root, "self-restart-scheduled")), "self restart command to finish scheduling");

    const commandPid = Number(readFileSync(join(root, "self-restart-command.pid"), "utf8"));
    killProcessGroup(commandPid);

    await waitFor(() => {
      if (!existsSync(join(root, ".data", "agent-relay.pid"))) return false;
      const nextPid = readPid(root);
      return nextPid !== firstPid && pidIsAlive(nextPid) && !existsSync(sentinel);
    }, "detached restart worker to replace the relay and clear data", 10_000);

    expect(readPid(root)).not.toBe(firstPid);
  });

  unixOnlyTest("clean-data refuses while the relay is running", () => {
    const root = createFixture();
    expectSuccess(runRelay(root, "start"));
    const sentinel = join(root, ".data", "sentinel");
    writeFileSync(sentinel, "old data");

    const clean = runRelay(root, "clean-data");
    expect(clean.status).not.toBe(0);
    expect(clean.stderr).toContain("stop it before cleaning data");
    expect(existsSync(sentinel)).toBe(true);
  });

  unixOnlyTest("experimental relay work restart preserves Relay data", async () => {
    const root = createFixture();
    expectSuccess(runRelay(root, "start"));
    const firstPid = readPid(root);
    const sentinel = join(root, ".data", "relay-work-binding");
    writeFileSync(sentinel, "keep");

    const restart = runRelay(root, "restart", { EXPERIMENTAL_RELAY_WORK_ENABLED: "true" });
    expectSuccess(restart);
    expect(restart.stdout).toContain("preserving Relay data");
    expect(readPid(root)).not.toBe(firstPid);
    expect(existsSync(sentinel)).toBe(true);
  });
});

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-script-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  copyFileSync(join(process.cwd(), "scripts", "relay.sh"), join(root, "scripts", "relay.sh"));
  chmodSync(join(root, "scripts", "relay.sh"), 0o755);
  writeFileSync(join(root, "src", "main.ts"), fakeRelaySource());
  return root;
}

function runRelay(root: string, command: string, envOverrides: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(join(root, "scripts", "relay.sh"), [command], { cwd: root, encoding: "utf8", env: { ...fastRelayEnv, ...envOverrides } });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(`${result.stdout}${result.stderr}`).toBeTruthy();
  expect(result.status).toBe(0);
}

function readPid(root: string): number {
  return Number(readFileSync(join(root, ".data", "agent-relay.pid"), "utf8"));
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The command may have already exited after scheduling the restart worker.
  }
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function fakeRelaySource(): string {
  return `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
mkdirSync(join(root, ".data"), { recursive: true });
writeFileSync(join(root, ".data", "started-" + process.pid), "");
appendFileSync(join(root, "fake-relay-events.log"), "started " + process.pid + "\\n");

let triggered = false;
process.on("SIGTERM", () => {
  appendFileSync(join(root, "fake-relay-events.log"), "stopped " + process.pid + "\\n");
  process.exit(0);
});

setInterval(() => {
  const trigger = join(root, "trigger-self-restart");
  if (triggered || !existsSync(trigger)) return;
  triggered = true;
  rmSync(trigger, { force: true });
  const proc = Bun.spawn(["bash", "-lc", "scripts/relay.sh restart; touch self-restart-scheduled; sleep 30"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  writeFileSync(join(root, "self-restart-command.pid"), String(proc.pid));
}, 50);
`.trimStart();
}
