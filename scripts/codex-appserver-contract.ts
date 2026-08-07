import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import packageJson from "../package.json" with { type: "json" };
import { codexSpawnCommand, isCodexVersionSupported, MINIMUM_CODEX_VERSION, parseCodexVersion } from "../src/providers/agents/codex/spawn.ts";

const codexBin = process.env.CODEX_BIN?.trim() || "codex";
const workDir = mkdtempSync(join(tmpdir(), "agent-relay-codex-contract-"));

async function main(): Promise<void> {
  try {
    const versionOutput = await runCodex(["--version"]);
    const version = parseCodexVersion(versionOutput);
    if (!version || !isCodexVersionSupported(version)) {
      throw new Error(`Contract requires codex-cli ${MINIMUM_CODEX_VERSION} or newer; received ${JSON.stringify(versionOutput.trim())}.`);
    }

    const schemaDir = join(workDir, "schema");
    await runCodex(["app-server", "generate-ts", "--out", schemaDir, "--experimental"], 60_000);
    assertGeneratedProtocol(schemaDir);

    const rpc = new ContractRpc(codexBin);
    try {
      const initialized = asRecord(await rpc.request("initialize", {
        clientInfo: { name: "agent-relay-contract", title: "Agent Relay Contract", version: packageJson.version },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
        },
      }));
      if (typeof initialized?.userAgent !== "string") throw new Error("initialize did not return userAgent.");
      rpc.notify("initialized");

      const models = asRecord(await rpc.request("model/list", { includeHidden: false }));
      if (!Array.isArray(models?.data) || models.data.length === 0) throw new Error("model/list returned no models.");
      const collaborationModes = asRecord(await rpc.request("collaborationMode/list", {}));
      if (!Array.isArray(collaborationModes?.data)) throw new Error("collaborationMode/list returned an invalid payload.");
      const modeNames = collaborationModes.data.map((value) => asRecord(value)?.mode).filter((mode): mode is string => typeof mode === "string");
      if (!modeNames.includes("default") || !modeNames.includes("plan")) throw new Error("collaborationMode/list did not advertise default and plan modes.");

      process.stdout.write(`codex app-server contract passed (${version}; ${models.data.length} models; ${collaborationModes.data.length} collaboration modes)\n`);
    } finally {
      await rpc.close();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function assertGeneratedProtocol(schemaDir: string): void {
  const clientRequestPath = join(schemaDir, "ClientRequest.ts");
  const capabilitiesPath = join(schemaDir, "InitializeCapabilities.ts");
  const userInputPath = join(schemaDir, "v2", "UserInput.ts");
  const notificationsPath = join(schemaDir, "ServerNotification.ts");
  const threadResumePath = join(schemaDir, "v2", "ThreadResumeParams.ts");
  const threadItemPath = join(schemaDir, "v2", "ThreadItem.ts");
  const turnPath = join(schemaDir, "v2", "Turn.ts");
  const turnStartPath = join(schemaDir, "v2", "TurnStartParams.ts");
  const turnSteerPath = join(schemaDir, "v2", "TurnSteerParams.ts");
  if (![clientRequestPath, capabilitiesPath, userInputPath, notificationsPath, threadResumePath, threadItemPath, turnPath, turnStartPath, turnSteerPath].every(existsSync)) throw new Error("Experimental TypeScript schema was not generated.");
  const requests = readFileSync(clientRequestPath, "utf8");
  const capabilities = readFileSync(capabilitiesPath, "utf8");
  const userInput = readFileSync(userInputPath, "utf8");
  const notifications = readFileSync(notificationsPath, "utf8");
  const threadResume = readFileSync(threadResumePath, "utf8");
  const threadItem = readFileSync(threadItemPath, "utf8");
  const turn = readFileSync(turnPath, "utf8");
  const turnStart = readFileSync(turnStartPath, "utf8");
  const turnSteer = readFileSync(turnSteerPath, "utf8");
  for (const method of [
    "model/list",
    "collaborationMode/list",
    "review/start",
    "thread/compact/start",
    "thread/name/set",
    "thread/goal/set",
    "thread/goal/clear",
    "thread/archive",
    "thread/delete",
    "thread/fork",
    "thread/backgroundTerminals/list",
    "thread/backgroundTerminals/clean",
    "thread/backgroundTerminals/terminate",
    "skills/list",
    "fuzzyFileSearch",
  ]) {
    if (!requests.includes(`\"method\": \"${method}\"`)) throw new Error(`Generated schema is missing ${method}.`);
  }
  for (const capability of ["experimentalApi", "requestAttestation", "mcpServerOpenaiFormElicitation"]) {
    if (!capabilities.includes(capability)) throw new Error(`Generated schema is missing initialize capability ${capability}.`);
  }
  for (const variant of ["text", "image", "localImage", "audio", "localAudio", "skill", "mention"]) {
    if (!userInput.includes(`\"type\": \"${variant}\"`)) throw new Error(`Generated UserInput is missing ${variant}.`);
  }
  for (const method of [
    "item/reasoning/summaryTextDelta",
    "turn/plan/updated",
    "turn/diff/updated",
    "thread/compacted",
    "thread/name/updated",
    "thread/goal/updated",
    "thread/goal/cleared",
    "thread/status/changed",
    "thread/archived",
    "thread/deleted",
    "hook/started",
    "guardianWarning",
    "configWarning",
  ]) {
    if (!notifications.includes(`\"method\": \"${method}\"`)) throw new Error(`Generated notifications are missing ${method}.`);
  }
  if (!threadResume.includes("initialTurnsPage") || !threadResume.includes("excludeTurns")) throw new Error("Generated thread/resume schema is missing latest-turn bootstrap fields.");
  if (!threadItem.includes('"type": "userMessage"') || !threadItem.includes("clientId") || !threadItem.includes("content")) {
    throw new Error("Generated ThreadItem is missing shared user-message fields.");
  }
  if (!turnStart.includes("clientUserMessageId") || !turnSteer.includes("clientUserMessageId")) {
    throw new Error("Generated turn input schemas are missing clientUserMessageId.");
  }
  for (const field of ["items", "status", "error", "startedAt", "completedAt", "durationMs"]) {
    if (!turn.includes(field)) throw new Error(`Generated Turn is missing ${field}.`);
  }
}

async function runCodex(args: string[], timeoutMs = 30_000): Promise<string> {
  const command = codexSpawnCommand(codexBin, args);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex command timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else reject(new Error(`Codex command failed (${code ?? "unknown"}): ${stderr || stdout}`));
    });
  });
}

class ContractRpc {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private stderr = "";

  constructor(bin: string) {
    const command = codexSpawnCommand(bin, ["app-server", "--listen", "stdio://"]);
    this.proc = spawn(command.command, command.args, {
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.handleLine(line));
    this.proc.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000); });
    this.proc.on("exit", (code) => {
      const error = new Error(`Codex app-server exited (${code ?? "unknown"}): ${this.stderr}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.proc.kill();
    await new Promise<void>((resolve) => this.proc.once("exit", () => resolve()));
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Invalid app-server JSON: ${line}`);
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.write({ id: message.id, error: { code: -32601, message: `Unexpected server request: ${message.method}` } });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const error = asRecord(message.error);
    if (error) pending.reject(new Error(String(error.message ?? JSON.stringify(error))));
    else pending.resolve(message.result);
  }

  private write(message: unknown): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

await main();
