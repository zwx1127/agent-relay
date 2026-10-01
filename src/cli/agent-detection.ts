import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../runtime/config-types.ts";
import { isCodexVersionSupported, parseCodexVersion } from "../providers/agents/codex/spawn.ts";
import { nativeAgentSpawnCommand } from "../providers/agents/native-spawn.ts";
import { isSupportedClaudeVersion, MINIMUM_CLAUDE_VERSION, TESTED_CLAUDE_VERSION } from "../providers/agents/claude/protocol.ts";
import { VERIFIED_DSH_VERSION } from "../providers/agents/dsh/protocol.ts";

export type AgentProvider = AppConfig["agentProvider"];

export const AGENT_BACKENDS = {
  codex: { label: "Codex", binaryKey: "CODEX_BIN", defaultBinary: "codex" },
  claude: { label: "Claude Code", binaryKey: "CLAUDE_BIN", defaultBinary: "claude" },
  dsh: { label: "DeepSeek Harness", binaryKey: "DSH_BIN", defaultBinary: "dsh" },
} as const;

export function backendVersionRequirement(provider: AgentProvider): string {
  if (provider === "codex") return "Codex CLI 0.145.0 or newer is required.";
  if (provider === "claude") return `Claude Code ${MINIMUM_CLAUDE_VERSION}+ in the 2.x series is required; ${TESTED_CLAUDE_VERSION} is the verified target.`;
  return `DeepSeek Harness ${VERIFIED_DSH_VERSION} developer preview is required; other Web Remote versions are not verified.`;
}

export interface AgentDetection {
  found: boolean;
  path?: string;
  version?: string;
  /** Only set when a backend's supported version range is established. */
  compatible?: boolean;
}

const executeFile = promisify(execFile);

/** Local executable check only. Never starts a session, installs, or signs in. */
export async function detectAgent(provider: AgentProvider, binary: string, cwd: string): Promise<AgentDetection> {
  const path = typeof Bun !== "undefined" ? Bun.which(binary, { cwd }) ?? undefined : undefined;
  try {
    const command = nativeAgentSpawnCommand(path ?? binary, ["--version"]);
    const { stdout } = await executeFile(command.command, command.args, {
      cwd, timeout: 5_000, maxBuffer: 8192, windowsHide: true,
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const version = provider === "codex" ? parseCodexVersion(stdout) : /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(stdout.trim())?.[1];
    return {
      found: true,
      ...(isAbsolute(command.resolvedBinary) ? { path: command.resolvedBinary } : {}),
      ...(version ? { version } : {}),
      ...(version ? { compatible: provider === "codex" ? isCodexVersionSupported(version) : provider === "claude" ? isSupportedClaudeVersion(version) : version === VERIFIED_DSH_VERSION } : {}),
    };
  } catch {
    return { found: false };
  }
}
