import type { AgentActivity, AgentTurnSnapshot, AgentTurnStatus } from "../../../ports/agent.ts";
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

export function turnSnapshot(value: unknown): AgentTurnSnapshot | undefined {
  const turn = asRecord(value);
  const id = getString(turn, "id");
  const status = normalizedTurnStatus(getString(turn, "status"));
  if (!id || !status) return undefined;

  const activities = (Array.isArray(turn?.items) ? turn.items : []).map((value) => {
    const item = asRecord(value);
    const itemId = getString(item, "id");
    const type = getString(item, "type");
    let activity: AgentActivity | undefined;
    if (type === "reasoning") {
      const summary = Array.isArray(item?.summary)
        ? item.summary.filter((part): part is string => typeof part === "string").join("\n")
        : getString(item, "summary");
      if (summary) activity = { kind: "reasoning", summary };
    } else if (type === "plan") {
      const text = getString(item, "text");
      if (text) {
        activity = {
          kind: "item",
          category: "other",
          label: "Plan snapshot",
          detail: truncateSummary(text),
          status: status === "inProgress" ? "inProgress" : "completed",
        };
      }
    } else {
      activity = itemActivity(item, status === "inProgress");
    }
    return activity ? { ...(itemId ? { itemId } : {}), activity } : undefined;
  }).filter((entry): entry is AgentTurnSnapshot["activities"][number] => Boolean(entry));

  const errorRecord = asRecord(turn?.error);
  const errorMessage = getString(errorRecord, "message");
  const startedAt = unixSecondsToMilliseconds(turn?.startedAt);
  const completedAt = unixSecondsToMilliseconds(turn?.completedAt);
  const durationMs = typeof turn?.durationMs === "number"
    ? turn.durationMs
    : startedAt !== undefined && completedAt !== undefined
      ? Math.max(0, completedAt - startedAt)
      : undefined;
  return {
    id,
    status,
    activities,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorMessage ? {
      error: {
        message: errorMessage,
        ...(errorRecord?.codexErrorInfo !== undefined && errorRecord.codexErrorInfo !== null ? { codexErrorInfo: errorRecord.codexErrorInfo } : {}),
        ...(getString(errorRecord, "additionalDetails") ? { additionalDetails: getString(errorRecord, "additionalDetails") } : {}),
      },
    } : {}),
  };
}

function normalizedTurnStatus(value: string | undefined): AgentTurnStatus | undefined {
  return value === "completed" || value === "interrupted" || value === "failed" || value === "inProgress" ? value : undefined;
}

function unixSecondsToMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : undefined;
}

function truncateSummary(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
