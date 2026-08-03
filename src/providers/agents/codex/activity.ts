import type { AgentActivity } from "../../../ports/agent.ts";
import { asRecord, getString, summarizeUnknown } from "./protocol.ts";

export function planStepStatus(value: string | undefined): "pending" | "inProgress" | "completed" | undefined {
  return value === "pending" || value === "inProgress" || value === "completed" ? value : undefined;
}

export function activityStatus(value: string | undefined, started: boolean): Extract<AgentActivity, { kind: "item" }>["status"] {
  switch (value) {
    case "completed":
    case "failed":
    case "declined":
    case "interrupted":
      return value;
    case "blocked":
      return "warning";
    case "stopped":
      return "interrupted";
    case "running":
    case "inProgress":
      return "inProgress";
    default:
      return started ? "started" : "completed";
  }
}

export function itemActivity(item: Record<string, unknown> | undefined, started: boolean): AgentActivity | undefined {
  if (!item) return undefined;
  const type = getString(item, "type");
  const status = activityStatus(getString(item, "status"), started);
  switch (type) {
    case "commandExecution": {
      const command = getString(item, "command") ?? "Command";
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
      return {
        kind: "item",
        category: "command",
        label: truncateSummary(command),
        status,
        ...(exitCode !== undefined ? { detail: `Exit ${exitCode}` } : {}),
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      };
    }
    case "fileChange": {
      const files = (Array.isArray(item.changes) ? item.changes : []).map((value) => {
        const change = asRecord(value);
        const path = getString(change, "path");
        return path ? { path, ...(getString(change, "kind") ? { kind: getString(change, "kind") } : {}) } : undefined;
      }).filter((file): file is { path: string; kind?: string } => Boolean(file));
      return { kind: "item", category: "fileChange", label: `File changes (${files.length})`, status, files };
    }
    case "mcpToolCall":
      return {
        kind: "item",
        category: "mcp",
        label: `MCP ${getString(item, "server") ?? "server"}/${getString(item, "tool") ?? "tool"}`,
        status,
        ...(asRecord(item.error) && getString(asRecord(item.error), "message") ? { detail: getString(asRecord(item.error), "message") } : {}),
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      };
    case "webSearch":
      return { kind: "item", category: "webSearch", label: `Web search: ${truncateSummary(getString(item, "query") ?? "search")}`, status };
    case "collabAgentToolCall":
      return { kind: "item", category: "collaboration", label: `Collaboration: ${summarizeUnknown(item.tool) ?? "agent"}`, status };
    case "subAgentActivity":
      return { kind: "item", category: "collaboration", label: `Sub-agent: ${summarizeUnknown(item.kind) ?? "activity"}`, status };
    case "imageView": {
      const path = getString(item, "path");
      return { kind: "item", category: "image", label: "Viewed image", status, ...(path ? { files: [{ path }] } : {}) };
    }
    case "imageGeneration":
      return { kind: "item", category: "image", label: "Generated image", status };
    case "sleep":
      return { kind: "item", category: "other", label: "Waiting", status };
    case "enteredReviewMode":
      return { kind: "item", category: "review", label: "Entered review mode", status };
    case "exitedReviewMode":
      return { kind: "item", category: "review", label: "Completed review", status };
    case "contextCompaction":
      return { kind: "item", category: "compaction", label: "Context compaction", status };
    case "dynamicToolCall":
      return { kind: "notice", level: "warning", title: "Unexpected dynamic tool activity", detail: getString(item, "tool") };
    default:
      return undefined;
  }
}

function truncateSummary(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
