import type { AgentSessionStatus } from "../../ports/agent.ts";
import { renderTelegramText, truncateForTelegramLabel, type RenderedTelegramText, type TelegramTextPart } from "../../presentation/telegram/text.ts";
import type { HomeStatusMode, RelayTask, WorkspaceRecord } from "../types.ts";
import type { StatusView } from "./status-view.ts";
import { bold, code } from "./text-parts.ts";

export function statusViewFromParts(
  workspace: WorkspaceRecord,
  status: AgentSessionStatus | undefined,
  recentOutputAt: number | undefined,
  recentError: string | undefined,
  queuedTaskCount = 0,
  blockedTaskCount = 0,
  activeTask?: RelayTask,
): StatusView {
  return {
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    running: Boolean(status?.running),
    recentOutputAt,
    recentError: status?.recentError ?? recentError,
    threadId: status?.threadId,
    threadName: status?.threadName,
    threadStatus: status?.threadStatus,
    model: status?.model,
    modelProvider: status?.modelProvider,
    reasoningEffort: status?.reasoningEffort,
    approvalPolicy: status?.approvalPolicy,
    approvalsReviewer: status?.approvalsReviewer,
    sandboxPolicy: status?.sandboxPolicy,
    tokenUsage: status?.tokenUsage,
    contextWindow: status?.contextWindow,
    waitingForApproval: status?.waitingForApproval,
    waitingForUserInput: status?.waitingForUserInput,
    queuedTaskCount,
    blockedTaskCount,
    activeTaskId: activeTask?.id,
    activeTaskStatus: activeTask?.status,
  };
}

export function formatHomeMessage(status: StatusView, mode: HomeStatusMode): RenderedTelegramText {
  return mode === "details" ? formatDetailsMessage(status) : formatStatusMessage(status);
}

export function formatStatusMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) {
    return renderTelegramText([
      bold("Relay Home"),
      `\n\n${statusIcon(status)} ${statusLabel(status)}`,
      "\ncwd: none",
      "\nWaiting: none",
    ]);
  }
  const parts: TelegramTextPart[] = [
    bold("Relay Home"),
    "\n\n",
    statusIcon(status),
    " ",
    statusLabel(status),
    "\ncwd: ",
    code(truncateForTelegramLabel(status.workspaceName, 32)),
    "\nWaiting: ",
    formatWaiting(status),
  ];
  if (status.recentError) parts.push("\nError: ", truncateForTelegramLabel(status.recentError.trim(), 120));
  return renderTelegramText(parts);
}

export function formatDetailsMessage(status: StatusView): RenderedTelegramText {
  if (!status.workspaceName || !status.workspacePath) return formatStatusMessage(status);
  const parts: TelegramTextPart[] = [
    bold("Relay Home"),
    "\n\n",
    statusIcon(status),
    " ",
    statusLabel(status),
    "\n\ncwd: ",
    code(status.workspaceName),
    "\nPath: ",
    code(status.workspacePath),
    "\nWaiting: ",
    formatWaiting(status),
    "\nPrompts: ",
    formatTaskCounts(status),
    "\nThread: ",
  ];
  const threadLabel = status.threadName || status.threadId;
  parts.push(threadLabel ? code(threadLabel) : "none");
  if (status.threadStatus) parts.push(` (${status.threadStatus})`);
  parts.push(
    "\nModel: ",
    status.model ? code(status.model) : "unknown",
    status.modelProvider ? ` / ${status.modelProvider}` : "",
    "\nReasoning: ",
    status.reasoningEffort ?? "unknown",
    "\nUsage: ",
    formatTokenContextUsage(status),
    "\nApproval policy: ",
    status.approvalPolicy ?? "unknown",
    "\nSandbox policy: ",
    status.sandboxPolicy ?? "unknown",
  );
  if (status.recentOutputAt) parts.push("\nLast output: ", relativeTime(status.recentOutputAt));
  if (status.recentError) parts.push("\nError: ", truncateForTelegramLabel(status.recentError.trim(), 120));
  return renderTelegramText(parts);
}

export function statusIcon(status: StatusView): string {
  if (status.recentError) return "🔴";
  if (status.waitingForApproval || status.waitingForUserInput) return "🟡";
  return status.running ? "🟢" : "⚪";
}

export function statusLabel(status: StatusView): string {
  if (status.recentError) return "Error";
  if (status.waitingForApproval || status.waitingForUserInput) return "Waiting";
  return status.running ? "Running" : "Stopped";
}

export function formatWaiting(status: StatusView): string {
  const waiting = [
    status.waitingForUserInput ? "user input" : undefined,
    status.waitingForApproval ? "approval" : undefined,
  ].filter(Boolean);
  return waiting.length > 0 ? waiting.join(", ") : "none";
}

export function formatTaskCounts(status: StatusView): string {
  const parts = [
    status.activeTaskId ? `#${status.activeTaskId} ${status.activeTaskStatus ?? "active"}` : undefined,
    status.queuedTaskCount ? `${status.queuedTaskCount} queued` : undefined,
    status.blockedTaskCount ? `${status.blockedTaskCount} blocked` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function formatTokenContextUsage(status: StatusView): string {
  const total = status.tokenUsage?.total?.totalTokens;
  const context = status.contextWindow;
  const last = status.tokenUsage?.last?.totalTokens;
  const parts: string[] = [];

  if (typeof total === "number" && typeof context === "number" && context > 0) {
    const percent = Math.round((total / context) * 100);
    const remaining = Math.max(0, context - total);
    parts.push(`total ${total}/${context} (${percent}%, ${remaining} left)`);
  } else if (typeof total === "number") {
    parts.push(`total ${total}`);
  } else if (typeof context === "number") {
    parts.push(`context ${context}`);
  } else {
    parts.push("unknown");
  }

  if (typeof last === "number") parts.push(`last ${last}`);
  return parts.join("; ");
}

export function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(timestamp).toISOString();
}
