import type { AgentBackgroundTerminalSummary } from "../../../ports/agent.ts";
import { getString } from "./protocol.ts";

export interface BackgroundTerminalRecord {
  key: string;
  callId: string;
  commandDisplay: string;
  recentChunks: string[];
}

export class BackgroundTerminalTracker {
  private readonly terminals = new Map<string, BackgroundTerminalRecord>();

  clear(): void {
    this.terminals.clear();
  }

  list(): AgentBackgroundTerminalSummary[] {
    return Array.from(this.terminals.values()).map((terminal) => ({
      commandDisplay: terminal.commandDisplay,
      recentChunks: [...terminal.recentChunks],
    }));
  }

  started(params: Record<string, unknown> | undefined): void {
    const item = params?.item && typeof params.item === "object" ? params.item as Record<string, unknown> : undefined;
    if (item?.type !== "commandExecution") return;
    if (getString(item, "source") !== "unifiedExecStartup") return;
    const callId = getString(item, "id");
    if (!callId) return;
    const processId = getString(item, "processId") ?? getString(item, "process_id");
    const key = processId ?? callId;
    const command = commandExecutionDisplay(item);
    const existing = this.terminals.get(key);
    if (existing) {
      existing.callId = callId;
      existing.commandDisplay = command;
      existing.recentChunks = [];
    } else {
      this.terminals.set(key, { key, callId, commandDisplay: command, recentChunks: [] });
    }
  }

  output(params: Record<string, unknown> | undefined): void {
    const callId = getString(params, "itemId") ?? getString(params, "item_id") ?? getString(params, "callId") ?? getString(params, "processId") ?? getString(params, "id");
    if (!callId) return;
    const terminal = Array.from(this.terminals.values()).find((process) => process.callId === callId);
    if (!terminal) return;
    const delta = getString(params, "delta");
    if (!delta) return;
    for (const line of delta.split(/\r?\n/).map((value) => value.trimEnd()).filter(Boolean)) {
      terminal.recentChunks.push(line);
    }
    const maxRecentChunks = 3;
    if (terminal.recentChunks.length > maxRecentChunks) {
      terminal.recentChunks.splice(0, terminal.recentChunks.length - maxRecentChunks);
    }
  }

  completed(item: Record<string, unknown>): void {
    const callId = getString(item, "id");
    const processId = getString(item, "processId") ?? getString(item, "process_id");
    const keys = [processId, callId].filter((key): key is string => Boolean(key));
    for (const key of keys) this.terminals.delete(key);
    if (callId) {
      for (const [key, terminal] of this.terminals.entries()) {
        if (terminal.callId === callId) this.terminals.delete(key);
      }
    }
  }
}

function commandExecutionDisplay(item: Record<string, unknown>): string {
  const command = getString(item, "command") ?? "(command unavailable)";
  const bashLoginShell = /^bash\s+-lc\s+(.+)$/s.exec(command.trim());
  return unquoteShellArgument(bashLoginShell?.[1] ?? command).trim() || command;
}

function unquoteShellArgument(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== "\"") || trimmed.at(-1) !== quote) return trimmed;
  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner.replace(/'\\''/g, "'");
  return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}
