import type { AgentSessionStatus } from "../../../ports/agent.ts";
import { getString } from "./protocol.ts";
import type { PendingGlobalNotice } from "./state.ts";

export function globalNoticeFor(method: string, params: Record<string, unknown> | undefined): PendingGlobalNotice | undefined {
  if (method === "warning" || method === "guardianWarning") {
    const message = getString(params, "message");
    return message ? { level: "warning", title: method === "guardianWarning" ? "Guardian warning" : "Codex warning", detail: message } : undefined;
  }
  if (method === "configWarning" || method === "deprecationNotice") {
    const summary = getString(params, "summary");
    if (!summary) return undefined;
    const details = getString(params, "details");
    const path = getString(params, "path");
    return {
      level: "warning",
      title: method === "configWarning" ? "Configuration warning" : "Deprecation notice",
      detail: [summary, details, path ? `File: ${path}` : undefined].filter(Boolean).join(" — "),
    };
  }
  return undefined;
}

export function settingsSnapshot(status: AgentSessionStatus): Record<string, string | undefined> {
  return {
    model: status.model,
    modelProvider: status.modelProvider,
    reasoningEffort: status.reasoningEffort,
    approvalPolicy: status.approvalPolicy,
    approvalsReviewer: status.approvalsReviewer,
    sandboxPolicy: status.sandboxPolicy,
  };
}

export function changedSettings(before: Record<string, string | undefined>, after: Record<string, string | undefined>): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const [name, value] of Object.entries(after)) {
    if (before[name] !== value) changes[name] = value ?? "(default)";
  }
  return changes;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
