import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let roots: string[] = [];
const fastRelayEnv = {
  ...process.env,
  AGENT_RELAY_START_CHECK_DELAY_SECONDS: "0.05",
  AGENT_RELAY_STOP_POLL_INTERVAL_SECONDS: "0.05",
  AGENT_RELAY_RESTART_WORKER_DELAY_SECONDS: "0.5",
  AGENT_RELAY_STOP_TIMEOUT_SECONDS: "2",
};

afterEach(async () => {
  for (const root of roots) {
    runRelay(root, "stop");
    let removed = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        removed = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!removed) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  roots = [];
});

if (process.platform === "win32") {
  describe("relay PowerShell lifecycle script", () => {
    test("does not expose Gateway lifecycle commands", () => {
      const root = createFixture();
      const result = runRelay(root, "gateway-start");
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("gateway-start|");
    });

    test("restart stops the relay, removes data, and starts a fresh process", async () => {
      const root = createFixture();
      expectSuccess(runRelay(root, "start"));
      const firstPid = readPid(root);
      expect(pidIsAlive(firstPid)).toBe(true);

      const sentinel = join(root, ".data", "sentinel");
      writeFileSync(sentinel, "old data");

      const restart = runRelay(root, "restart");
      expectSuccess(restart);
      expect(restart.stdout).toContain("restart scheduled");

      await waitFor(() => {
        if (!existsSync(join(root, ".data", "agent-relay.pid"))) return false;
        const secondPid = readPid(root);
        return secondPid !== firstPid && relayStatus(root).includes(`pid ${secondPid}`) && !existsSync(sentinel);
      }, "restart worker to replace the relay and clear data", 10_000);

      await waitFor(() => !pidIsAlive(firstPid), "old relay process to exit");
    }, 15_000);

    test("clean-data refuses while the relay is running", () => {
      const root = createFixture();
      expectSuccess(runRelay(root, "start"));
      const sentinel = join(root, ".data", "sentinel");
      writeFileSync(sentinel, "old data");

      const clean = runRelay(root, "clean-data");
      expect(clean.status).not.toBe(0);
      expect(clean.stderr).toContain("stop it before cleaning data");
      expect(existsSync(sentinel)).toBe(true);
    }, 15_000);

    test("experimental relay work restart preserves Relay data for Gateway continuity", async () => {
      const root = createFixture();
      expectSuccess(runRelay(root, "start"));
      const firstPid = readPid(root);
      const sentinel = join(root, ".data", "relay-work-binding");
      writeFileSync(sentinel, "keep");

      const restart = runRelay(root, "restart", { EXPERIMENTAL_RELAY_WORK_ENABLED: "true" });
      expectSuccess(restart);
      await waitFor(() => {
        if (!existsSync(join(root, ".data", "agent-relay.pid"))) return false;
        const nextPid = readPid(root);
        return nextPid !== firstPid && existsSync(sentinel);
      }, "experimental restart to preserve data", 10_000);
      expect(existsSync(sentinel)).toBe(true);
    }, 15_000);
  });
}

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-powershell-script-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  copyFileSync(join(process.cwd(), "scripts", "relay.ps1"), join(root, "scripts", "relay.ps1"));
  writeFileSync(join(root, "src", "main.ts"), fakeRelaySource());
  return root;
}

function runRelay(root: string, command: string, envOverrides: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "scripts", "relay.ps1"),
    command,
  ], { cwd: root, encoding: "utf8", env: { ...fastRelayEnv, ...envOverrides } });
}

function expectSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(`${result.stdout}${result.stderr}`).toBeTruthy();
  expect(result.status).toBe(0);
}

function relayStatus(root: string): string {
  const result = runRelay(root, "status");
  return `${result.stdout}${result.stderr}`;
}

function readPid(root: string): number {
  return Number(readFileSync(join(root, ".data", "agent-relay.pid"), "utf8"));
}

function pidIsAlive(pid: number): boolean {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
  ], { encoding: "utf8" });
  return result.status === 0;
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
import { spawn } from "node:child_process";
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

function psLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

setInterval(() => {
  const trigger = join(root, "trigger-self-restart");
  if (triggered || !existsSync(trigger)) return;
  triggered = true;
  rmSync(trigger, { force: true });

  const relayScript = join(root, "scripts", "relay.ps1");
  const scheduled = join(root, "self-restart-scheduled");
  const commandLog = join(root, "self-restart-command.log");
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\\\Windows";
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "& " + psLiteral(relayScript) + " restart *>> " + psLiteral(commandLog),
    "New-Item -ItemType File -Path " + psLiteral(scheduled) + " -Force | Out-Null",
    "Start-Sleep -Seconds 30",
  ].join("; ");
  const proc = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(join(root, "self-restart-command.pid"), String(proc.pid ?? 0));
}, 50);
`.trimStart();
}
