import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const harnessDirs: string[] = [];

export function createCodexTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  harnessDirs.push(dir);
  return dir;
}

export function cleanupCodexHarness(): void {
  for (const dir of harnessDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
export function fakeCodexBin(scriptPath?: string): string {
  const dir = scriptPath ? dirname(scriptPath) : mkdtempSync(join(tmpdir(), "agent-relay-fake-codex-"));
  if (!scriptPath) harnessDirs.push(dir);
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
let currentTurn;
let threadRuntimeStatus = { type: "idle" };
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
    send({ id: msg.id, result: { thread: { id: "thread-1", name: "Initial thread", status: { type: "idle" } }, initialTurnsPage: msg.method === "thread/resume" ? { data: [{ id: "latest-turn", status: "completed", items: [{ type: "commandExecution", id: "resume-command", command: "git status", status: "completed", exitCode: 0, durationMs: 12 }], startedAt: 1, completedAt: 2, durationMs: 1000 }], nextCursor: null } : null, model: "gpt-5.2", modelProvider: "openai", reasoningEffort: "medium", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (msg.method === "thread/read") {
    send({ id: msg.id, result: { thread: { id: "thread-1", name: "Initial thread", status: threadRuntimeStatus, turns: currentTurn ? [currentTurn] : [] } } });
  } else if (msg.method === "turn/start") {
    const turnId = "turn-" + (++turnCount);
    const threadId = msg.params.threadId;
    const inputText = msg.params.input[0].text;
    const previousTurnId = currentTurn && currentTurn.id;
    currentTurn = { id: turnId, status: "inProgress", items: [] };
    threadRuntimeStatus = { type: "active", activeFlags: [] };
    const startTurn = () => send({ id: msg.id, result: { turn: currentTurn } });
    if (inputText === "slow active") {
      setTimeout(startTurn, 50);
    } else {
      startTurn();
    }
    if (inputText === "missing terminal completed") {
      currentTurn = { id: turnId, status: "completed", items: [], startedAt: 1, completedAt: 2, durationMs: 1000 };
      threadRuntimeStatus = { type: "idle" };
    } else if (inputText === "inconsistent idle turn") {
      threadRuntimeStatus = { type: "idle" };
    } else if (inputText === "failed command stalls") {
      send({ method: "turn/started", params: { threadId, turn: currentTurn } });
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: "failed-command", command: "false", status: "failed", exitCode: 1, durationMs: 5, commandActions: [] } } });
    } else if (inputText === "late old setup") {
      // Keep the first turn active. The next steer request intentionally fails.
    } else if (inputText === "new turn with late old completion") {
      if (previousTurnId) send({ method: "turn/completed", params: { threadId, turn: { id: previousTurnId, status: "completed", items: [] } } });
    } else if (inputText === "duplicate completion") {
      const terminal = { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } };
      send(terminal);
      send(terminal);
    } else if (inputText === "status please") {
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
    } else if (inputText !== "slow active" && inputText !== "missing terminal completed" && inputText !== "inconsistent idle turn" && inputText !== "failed command stalls" && inputText !== "late old setup" && inputText !== "new turn with late old completion" && inputText !== "duplicate completion") {
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

export function fakeCodexCommandPath(dir: string): string {
  return join(dir, process.platform === "win32" ? "codex-fake" : "codex-fake.js");
}

export function writeNodeCommand(commandPath: string, scriptText: string): void {
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

export function readLog(fakeBin: string): string {
  return readFileSync(join(fakeBin, "..", "messages.log"), "utf8");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
