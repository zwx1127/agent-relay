import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, lstatSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

// Run by package-smoke.mjs using the actual npm-installed Bun, never a global Bun.
// Bun's PTY support is POSIX-only; Windows gets the non-interactive/package checks.
if (process.platform === "win32") throw new Error("This PTY smoke requires Linux or macOS.");
const [tarball, root] = process.argv.slice(2);
assert(tarball && root);
const home = join(root, "interactive home");
const cwd = join(root, "interactive cwd");
const data = join(root, "persistent data with spaces");
// A genuinely custom prefix cannot be rediscovered by merely recomputing XDG defaults.
const prefix = join(root, "custom persistent prefix with spaces");
const config = join(home, "private config", "config.json");
const workspace = join(root, "workspaces with spaces");
for (const path of [home, cwd, workspace]) mkdirSync(path, { recursive: true });
const codex = join(root, "codex stub with spaces");
writeFileSync(codex, '#!/bin/sh\nprintf "codex-cli 0.159.2\\n"\n'); chmodSync(codex, 0o755);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: data, npm_config_cache: join(root, "interactive npx cache"), AGENT_RELAY_CONFIG: "", AGENT_RELAY_BUN_PATH: "" };
for (const key of Object.keys(env)) if (/^(TELEGRAM_|LARK_|CODEX_|CLAUDE_|DSH_|IM_PROVIDER$|AGENT_PROVIDER$|ALLOWED_|WORKSPACE_ROOT$|SQLITE_PATH$|RELAY_|EXPERIMENTAL_RELAY_)/.test(key)) delete env[key];
const fakeToken = "123456:fake-private-install-smoke-token";
const base = ["npx", "--yes", `--package=${tarball}`, "agent-relay", "install", "--prefix", prefix, "--config", config];

async function session(args: string[], prompts: [string, string][], expected: number, overrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const remaining = [...prompts];
  let output = "";
  let pending = "";
  let unexpectedSetup = false;
  const child = Bun.spawn(args, {
    cwd, env: { ...env, ...overrides },
    terminal: { cols: 160, rows: 40, data(terminal, data) {
      const chunk = Buffer.from(data).toString(); output += chunk; pending += chunk;
      // Negative CLI checks must fail promptly rather than hanging in a regressed wizard.
      if (!prompts.length && !unexpectedSetup && /Select a number|Install this version here|Telegram bot token/.test(pending)) {
        unexpectedSetup = true; terminal.write("\x03");
      }
      const next = remaining[0];
      if (next && pending.includes(next[0])) {
        remaining.shift(); pending = ""; terminal.write(next[1]);
      }
    } },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const code = await child.exited;
    assert(!unexpectedSetup, "Rejected command unexpectedly opened setup");
    assert.equal(code, expected, `PTY command exited ${code}, expected ${expected}. Last output: ${output.slice(-6000)}`);
    assert.equal(remaining.length, 0, `Unreached prompts: ${remaining.map(([prompt]) => prompt).join(", ")}`);
    assert(!output.includes(fakeToken), "A secret was echoed into the PTY transcript");
    return output;
  } finally { clearTimeout(timeout); child.terminal?.close(); }
}

function snapshotTree(path: string): unknown {
  const stat = lstatSync(path);
  return {
    mode: stat.mode, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    target: stat.isSymbolicLink() ? readlinkSync(path) : undefined,
    children: stat.isDirectory() ? readdirSync(path).sort().map((name) => [name, snapshotTree(join(path, name))]) : undefined,
  };
}

const prompts: [string, string][] = [
  ["Install this version here, then open configuration? [Y/n]:", "y\r"],
  ["Select a number [1]:", "1\r"], // Agent backend: Codex
  ["Select a number [1]:", "1\r"], // Messaging provider: Telegram
  ["Telegram bot token:", `${fakeToken}\r`],
  ["Allowed Telegram user IDs (comma-separated):", "123456\r"],
  ["Allowed Telegram chat IDs (optional, comma-separated; - clears restrictions; blank keeps saved IDs):", "\r"],
  ["Workspace root (absolute directory)", `${workspace}\r`],
  ["SQLite state file (absolute path)", "\r"],
  ["Codex binary (PATH command or executable path)", `${codex}\r`],
  ["Select a number [1]:", "\r"],
  ["Select a number [1]:", "\r"],
  ["Enable the optional localhost helper", "n\r"],
  ["Enable the experimental Gateway sharing flag?", "n\r"],
  ["Verify now?", "n\r"],
  ["Save this configuration? [y/N]:", "y\r"],
];
const first = await session([...base, "--package", tarball], prompts, 0);
assert(first.includes("Verified persistent installation:"));
assert(first.includes("Installation and configuration completed."));
assert(first.includes("PATH has not been changed"));
assert(existsSync(join(prefix, "bin", "agent-relay")));
const saved = readFileSync(config, "utf8");
assert.equal(JSON.parse(saved).env.TELEGRAM_BOT_TOKEN, fakeToken);
assert.equal(JSON.parse(saved).env.WORKSPACE_ROOT, workspace);
const installedSnapshot = snapshotTree(prefix);
// The second invocation uses the same pinned installer, skips npm, and cancels safely.
const cancelPrompts: [string, string][] = [["Select a number [1]:", "1\r"], ["Select a number [1]:", "1\r"], ["Telegram bot token [saved value; Enter to keep]:", "\x03"]];
const second = await session(base, cancelPrompts, 130);
assert(second.includes("This version is already installed here"));
assert(!second.includes("Installing the persistent copy"));
assert(second.includes("software remains installed"));
assert.equal(readFileSync(config, "utf8"), saved, "Canceled setup altered saved credentials");
assert.deepEqual(snapshotTree(prefix), installedSnapshot, "Repeated npx install mutated the existing prefix");
const executable = join(prefix, "bin", "agent-relay");

// Reconfigure through the installed executable with no --prefix, after changing XDG.
// A sentinel npm executable makes any accidental reinstall fail without registry access.
const changedData = join(root, "changed XDG data with spaces");
const sentinelBin = join(root, "npm sentinel bin"); mkdirSync(sentinelBin);
const npmCalled = join(root, "unexpected-npm-call");
const npmSentinel = join(sentinelBin, "npm");
writeFileSync(npmSentinel, '#!/bin/sh\nprintf "called\\n" > "$AGENT_RELAY_SMOKE_NPM_CALLED"\nprintf "Unexpected npm invocation\\n" >&2\nexit 97\n'); chmodSync(npmSentinel, 0o755);
const changedEnv = { XDG_DATA_HOME: changedData, PATH: `${sentinelBin}:${env.PATH ?? ""}`, npm_execpath: "", AGENT_RELAY_SMOKE_NPM_CALLED: npmCalled };
const direct = await session([executable, "install", "--config", config], cancelPrompts, 130, changedEnv);
assert(direct.includes(`Persistent npm prefix: ${prefix}`), "Installed executable did not reuse its custom prefix");
assert(direct.includes("This version is already installed here"));
assert(!direct.includes("Installing the persistent copy"));
assert(!direct.includes("Install this version here, then open configuration?"));
assert(!existsSync(npmCalled), "Installed reconfiguration invoked npm");
assert(!existsSync(changedData), "Installed reconfiguration created a new XDG prefix");
assert(!existsSync(data), "Custom-prefix setup created the default XDG prefix");
assert.equal(readFileSync(config, "utf8"), saved, "Installed canceled setup altered saved credentials");
assert.deepEqual(snapshotTree(prefix), installedSnapshot, "Installed reconfiguration mutated the existing prefix");

const missingConfig = join(home, "missing config", "config.json");
for (const configPath of [missingConfig, config]) {
  const rejected = await session([executable, "init", "--config", configPath], [], 1, changedEnv);
  assert(rejected.includes("Unknown command"), "TTY init was not rejected as an unknown command");
  assert(!rejected.includes("Telegram bot token"));
}
const missingStart = await session([executable, "start", "--config", missingConfig], [], 1, changedEnv);
assert(missingStart.includes("agent-relay install"), "TTY start did not direct missing configuration to install");
assert(!existsSync(join(home, "missing config")), "Rejected init or missing-config start created private config state");
assert.equal(readFileSync(config, "utf8"), saved, "Rejected init altered saved credentials");
assert.deepEqual(snapshotTree(prefix), installedSnapshot, "Rejected init or missing-config start mutated the prefix");
assert(!existsSync(npmCalled));
assert(!existsSync(changedData));
for (const profile of [".profile", ".bashrc", ".zshrc", ".npmrc"]) assert(!existsSync(join(home, profile)), `Installer created ${profile}`);
const verify = Bun.spawnSync([executable, "doctor", "--config", config], { cwd, env });
assert.equal(verify.exitCode, 0, verify.stderr.toString());
assert(verify.stdout.toString().includes("0.159.2"));
assert(!verify.stdout.toString().includes(fakeToken));

// Preserve the launcher's explicit external-Bun fallback when reconfiguring an own install.
// Move only this disposable custom prefix's runtime; the script's separate runtime stays intact.
const installedRoot = dirname(dirname(realpathSync(executable)));
const bundledRuntime = join(installedRoot, "node_modules", "bun", "bin", "bun.exe");
const runtimeBackup = join(root, "custom prefix runtime backup");
assert.notEqual(realpathSync(bundledRuntime), realpathSync(process.execPath), "Smoke must use a separate runtime before moving the custom-prefix Bun");
renameSync(bundledRuntime, runtimeBackup);
try {
  const withoutBundledRuntime = snapshotTree(prefix);
  const externalRuntime = await session([executable, "install", "--config", config], cancelPrompts, 130, { ...changedEnv, AGENT_RELAY_BUN_PATH: process.execPath });
  assert(externalRuntime.includes(`Persistent npm prefix: ${prefix}`), "External-Bun reconfiguration did not reuse its custom prefix");
  assert(externalRuntime.includes("This version is already installed here"));
  assert(!externalRuntime.includes("Installing the persistent copy"));
  assert(!externalRuntime.includes("Install this version here, then open configuration?"));
  assert(!existsSync(npmCalled), "External-Bun reconfiguration invoked npm");
  assert(!existsSync(changedData), "External-Bun reconfiguration created a new XDG prefix");
  assert(!existsSync(data), "External-Bun reconfiguration created the default XDG prefix");
  assert(!existsSync(bundledRuntime), "External-Bun reconfiguration recreated the bundled runtime");
  assert.equal(readFileSync(config, "utf8"), saved, "External-Bun canceled setup altered saved credentials");
  assert.deepEqual(snapshotTree(prefix), withoutBundledRuntime, "External-Bun reconfiguration mutated the existing prefix");
} finally { renameSync(runtimeBackup, bundledRuntime); }
console.log("Interactive package smoke passed: clean npx tarball -> custom persistent npm install -> English wizard -> private config; repeat/cancel preserved credentials; installed install reused its prefix after XDG changed without npm or prefix writes, including external Bun with bundled Bun absent; TTY init rejected and missing-config start directed to install without mutation; executable works outside checkout with no global Bun and paths with spaces.");
