import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentApprovalKind, AgentImageInput, AgentReviewTarget, AgentSessionStatus, AgentTaskInput, AgentThreadSummary, AgentUserInputQuestion } from "../../agents/types.ts";
import type { InboundMediaFile, InlineKeyboardMarkup } from "../../messaging/types.ts";
import { appendRendered, contextUsageBar, renderTelegramText, truncateForTelegramLabel, type RenderedTelegramText, type StatusView, type TelegramTextPart } from "../../rendering/telegram-text.ts";
import type { HomeStatusMode, RelayTask, WorkspaceRecord } from "../types.ts";
import { CALLBACK_LIMIT_BYTES, LIST_PAGE_SIZE, UI_BUTTON, WORKSPACE_BUTTON_LABEL_WIDTH } from "./constants.ts";

export function commandName(text: string): string | undefined {
  const [command = ""] = text.split(/\s+/);
  return command.split("@")[0] || undefined;
}

export function commandArgs(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
}

export function parseReviewTarget(args: string): AgentReviewTarget {
  if (!args) return { type: "uncommittedChanges" };
  const [kind = "", second = "", ...rest] = args.split(/\s+/);
  if (kind === "branch" && second) return { type: "baseBranch", branch: second };
  if (kind === "commit" && second) return { type: "commit", sha: second, title: rest.join(" ") || null };
  return { type: "custom", instructions: args };
}

export function decoratePagedOutput(page: RenderedTelegramText, pageIndex: number, totalPages: number): RenderedTelegramText {
  return appendRendered(page, renderTelegramText(["\n\n", bold(`Page ${pageIndex + 1}/${totalPages}`)]));
}

export function pagedOutputKeyboard(token: string, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  if (totalPages <= 1) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.firstPage, callback_data: `ar:p:${token}:0` },
      { text: UI_BUTTON.previousPage, callback_data: `ar:p:${token}:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:p:${token}:${Math.min(totalPages - 1, pageIndex + 1)}` },
      { text: UI_BUTTON.lastPage, callback_data: `ar:p:${token}:${totalPages - 1}` },
    ]],
  };
}

export function shortToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export function codexRequestKey(sessionKeyValue: string, requestId: string | number): string {
  return `${sessionKeyValue}:${String(requestId)}`;
}

export function bestPhoto(photos: InboundMediaFile[]): InboundMediaFile | undefined {
  return [...photos].sort((a, b) => {
    const aSize = a.fileSize ?? a.width * a.height;
    const bSize = b.fileSize ?? b.width * b.height;
    return bSize - aSize;
  })[0];
}

export function taskInputFromTask(task: RelayTask): AgentTaskInput {
  if (task.inputJson) {
    try {
      const parsed = JSON.parse(task.inputJson) as Partial<AgentTaskInput>;
      if (typeof parsed.text === "string") {
        return {
          text: parsed.text,
          images: Array.isArray(parsed.images)
            ? parsed.images
              .filter((image): image is AgentImageInput => Boolean(image) && typeof image === "object" && typeof (image as AgentImageInput).path === "string")
              .map((image) => ({ path: image.path, ...(image.caption ? { caption: image.caption } : {}) }))
            : undefined,
        };
      }
    } catch {
      return { text: task.text };
    }
  }
  return { text: task.text };
}

export function transcriptTextForInput(input: AgentTaskInput): string {
  const imageText = input.images?.length ? `\n[${input.images.length} image${input.images.length === 1 ? "" : "s"} attached]\n` : "\n";
  return `${input.text}${imageText}`;
}

export function pathContains(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncateTelegramCaption(text: string): string {
  return text.length <= 1024 ? text : `${text.slice(0, 1021)}...`;
}

export function bold(text: string): TelegramTextPart {
  return { text, entity: "bold" };
}

export function code(text: string): TelegramTextPart {
  return { text, entity: "code" };
}

export function textMessage(text: string): RenderedTelegramText {
  return renderTelegramText([text]);
}

export function ensureRendered(body: string | RenderedTelegramText): RenderedTelegramText {
  return typeof body === "string" ? textMessage(body) : body;
}

export function messageWithTitle(title: string, body?: string): RenderedTelegramText {
  return renderTelegramText(body ? [bold(title), "\n\n", body] : [bold(title)]);
}

export function formatResumeMessage(threads: AgentThreadSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Resume chat"), "\n\n"];
  for (const [index, thread] of threads.entries()) {
    if (index > 0) parts.push("\n");
    parts.push(`${index + 1}. `, code(thread.name ?? thread.id));
    if (thread.preview) parts.push(` - ${truncateForTelegramLabel(thread.preview, 80)}`);
  }
  return renderTelegramText(parts);
}

export function resumeKeyboard(token: string, threads: AgentThreadSummary[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: threads.map((thread, index) => [{
      text: buttonLabel(thread.name ?? thread.id),
      callback_data: `ar:cmd:resume:${token}:${index}`,
    }]),
  };
}

export function planReadyKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Implement", callback_data: `ar:cmd:plan:${token}:implement` },
      { text: "Continue", callback_data: `ar:cmd:plan:${token}:continue` },
    ]],
  };
}

export function confirmMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText([bold(title), "\n\n", body]);
}

export function answeredMessage(answer: string, hasNext: boolean): RenderedTelegramText {
  return renderTelegramText([
    bold("Answered:"),
    " ",
    answer,
    hasNext ? "\n\nNext question sent." : "",
  ]);
}

export function reactionForTaskStatus(status: RelayTask["status"]): string {
  switch (status) {
    case "queued":
      return "🫡";
    case "running":
      return "✍";
    case "blocked":
      return "🤔";
    case "done":
      return "😎";
    case "failed":
    case "cancelled":
      return "😱";
  }
}

export function formatErrorMessage(detail: string): RenderedTelegramText {
  return renderTelegramText([bold("Error:"), " ", detail]);
}

export function formatCodexQuestion(question: AgentUserInputQuestion, questionIndex?: number, totalQuestions?: number): RenderedTelegramText {
  if (typeof questionIndex === "number" && typeof totalQuestions === "number" && totalQuestions > 1) {
    return renderCodexQuestionBody([
      bold(`Question ${questionIndex + 1}/${totalQuestions}`),
      "\n",
      bold(question.header),
      "\n\n",
      question.question,
    ], question);
  }
  return renderCodexQuestionBody([bold(question.header), "\n\n", question.question], question);
}

export function renderCodexQuestionBody(parts: TelegramTextPart[], question: AgentUserInputQuestion): RenderedTelegramText {
  const options = question.options ?? [];
  if (!question.isSecret && options.length > 0) {
    parts.push("\n\n");
    for (const [index, option] of options.entries()) {
      if (index > 0) parts.push("\n");
      parts.push(bold(option.label));
      if (option.description) parts.push(` - ${option.description}`);
    }
  }
  return renderTelegramText(parts);
}

export function formatApprovalMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText(approvalMessageParts(title, body));
}

export function formatApprovalDecisionMessage(decision: string, title: string, body: string): RenderedTelegramText {
  return renderTelegramText([
    bold(decision),
    "\n\n",
    ...approvalMessageParts(title, body),
  ]);
}

export function approvalMessageParts(title: string, body: string): TelegramTextPart[] {
  const parts: TelegramTextPart[] = [bold(title)];
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (lines.length > 0) {
    parts.push("\n\n");
    for (const [index, line] of lines.entries()) {
      if (index > 0) parts.push("\n");
      if (line.startsWith("cwd: ")) {
        parts.push("cwd: ", code(line.slice(5)));
      } else if (index === lines.length - 1 && lines.length > 1) {
        parts.push(code(line));
      } else {
        parts.push(line);
      }
    }
  }
  return parts;
}

export function approvalKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.approve, callback_data: `ar:a:${token}:y` },
      { text: UI_BUTTON.deny, callback_data: `ar:a:${token}:n` },
    ]],
  };
}

export function parsePromptPayload(payloadJson: string | undefined): Record<string, unknown> | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson);
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function asPromptRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function isExpired(prompt: { expiresAt?: number }): boolean {
  return typeof prompt.expiresAt === "number" && prompt.expiresAt < Date.now();
}

export function approvalResponse(kind: AgentApprovalKind, approved: boolean, params: unknown): unknown {
  if (kind === "legacy_command" || kind === "legacy_patch") {
    return { decision: approved ? "approved" : "denied" };
  }
  if (kind === "permissions") {
    const record = params && typeof params === "object" ? params as { permissions?: unknown } : {};
    return approved ? { permissions: record.permissions ?? {}, scope: "turn" } : { permissions: {}, scope: "turn" };
  }
  return { decision: approved ? "accept" : "decline" };
}

export function statusViewFromParts(
  workspace: WorkspaceRecord,
  status: AgentSessionStatus | undefined,
  recentOutputAt: number | undefined,
  recentError: string | undefined,
  queuedTaskCount = 0,
  blockedTaskCount = 0,
  activeTask?: RelayTask,
) {
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
      "\nWaiting: no",
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
    "\nApproval policy: ",
    status.approvalPolicy ?? "unknown",
    "\nSandbox policy: ",
    status.sandboxPolicy ?? "unknown",
    "\nWaiting: ",
    formatWaiting(status),
    "\nPrompts: ",
    formatTaskCounts(status),
    "\nContext: ",
    formatContext(status),
    "\nToken usage: ",
    formatTokens(status),
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
  return waiting.length > 0 ? waiting.join(", ") : "no";
}

export function formatTaskCounts(status: StatusView): string {
  const parts = [
    status.activeTaskId ? `#${status.activeTaskId} ${status.activeTaskStatus ?? "active"}` : undefined,
    status.queuedTaskCount ? `${status.queuedTaskCount} queued` : undefined,
    status.blockedTaskCount ? `${status.blockedTaskCount} blocked` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function formatTokens(status: StatusView): string {
  const total = status.tokenUsage?.total?.totalTokens;
  const context = status.contextWindow;
  if (typeof total !== "number" && typeof context !== "number") return "unknown";
  if (typeof total === "number" && typeof context === "number" && context > 0) {
    const percent = Math.round((total / context) * 100);
    return `${total}/${context} (${percent}%)`;
  }
  return typeof total === "number" ? String(total) : `context ${context}`;
}

export function contextPercent(status: StatusView): number | undefined {
  const total = status.tokenUsage?.total?.totalTokens;
  const context = status.contextWindow;
  if (typeof total !== "number" || typeof context !== "number" || context <= 0) return undefined;
  return Math.round((total / context) * 100);
}

export function formatContext(status: StatusView): string {
  const percent = contextPercent(status);
  return typeof percent === "number"
    ? `${contextUsageBar(percent)} ${percent}%`
    : `${contextUsageBar(undefined)} ${formatTokens(status)}`;
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

export function formatWorkspacesMessage(workspaces: Array<{ name: string; selected: boolean }>, pageIndex: number, totalPages: number): RenderedTelegramText {
  if (workspaces.length === 0) {
    return renderTelegramText([
      bold("Workspace"),
      `\n\nNo cwd directories found.\nUse ${UI_BUTTON.create} to create one.`,
    ]);
  }
  const parts: TelegramTextPart[] = [bold("Workspace"), `\n\nPage ${pageIndex + 1}/${totalPages}\n`];
  for (const workspace of workspaces) {
    parts.push("\n", workspace.selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `, code(workspace.name));
  }
  return renderTelegramText(parts);
}

export function consoleKeyboard(status: { workspaceName?: string; running?: boolean }): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  rows.push([
    { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    { text: UI_BUTTON.status, callback_data: "ar:status" },
    { text: UI_BUTTON.refresh, callback_data: "ar:s" },
  ]);
  if (status.workspaceName) {
    rows.push([{ text: UI_BUTTON.stop, callback_data: "ar:stop" }]);
  }
  return {
    inline_keyboard: rows,
  };
}

export function workspacesKeyboard(workspaces: WorkspaceRecord[], selected: string | undefined, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  const rows = workspaces.map((workspace) => [
    {
      text: workspaceButtonText(workspace.name, workspace.name === selected),
      callback_data: workspaceCallbackData(workspace.name),
    },
    { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(workspace.name, false) },
  ]);
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.previousPage, callback_data: `ar:wl:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:wl:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }

  return {
    inline_keyboard: [
      ...rows,
      [
        { text: UI_BUTTON.create, callback_data: "ar:n" },
        { text: UI_BUTTON.refresh, callback_data: "ar:w" },
      ],
    ],
  };
}

export function paginateWorkspaces(workspaces: WorkspaceRecord[], selected: string | undefined, rawPageIndex: number): { items: WorkspaceRecord[]; pageIndex: number; totalPages: number } {
  const sorted = [...workspaces].sort((left, right) => {
    if (left.name === selected) return -1;
    if (right.name === selected) return 1;
    return left.name.localeCompare(right.name);
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / LIST_PAGE_SIZE));
  const pageIndex = clampPage(rawPageIndex, totalPages);
  return {
    items: sorted.slice(pageIndex * LIST_PAGE_SIZE, pageIndex * LIST_PAGE_SIZE + LIST_PAGE_SIZE),
    pageIndex,
    totalPages,
  };
}

export function clampPage(value: number, totalPages: number): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(totalPages - 1, value));
}

export function buttonLabel(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

export function workspaceButtonText(name: string, selected: boolean): string {
  const prefix = selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `;
  return `${prefix}${buttonLabel(name).padEnd(WORKSPACE_BUTTON_LABEL_WIDTH, "\u00A0")}`;
}

export function workspaceCallbackData(name: string): string {
  const callbackData = `ar:uh:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

export function deleteWorkspaceCallbackData(name: string, confirmed: boolean): string {
  const callbackData = `ar:${confirmed ? "wd!" : "wd?"}:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

export function deleteWorkspaceConfirmKeyboard(name: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(name, true) },
      { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    ]],
  };
}

export function workspaceCallbackToken(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export function isConsolePayload(payload: string): boolean {
  return payload === "s"
    || payload === "w"
    || payload === "n"
    || payload === "status"
    || payload === "stop"
    || payload.startsWith("wl:")
    || payload.startsWith("wd?:")
    || payload.startsWith("wd!:")
    || payload.startsWith("uh:");
}
