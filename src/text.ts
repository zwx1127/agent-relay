const ANSI_PATTERN = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function cleanTerminalOutput(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROL_PATTERN, "");
}

export function splitForTelegram(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const newlineIndex = window.lastIndexOf("\n");
    const splitAt = newlineIndex > Math.floor(maxChars * 0.6) ? newlineIndex + 1 : maxChars;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function tailLines(text: string, count: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface StatusView {
  workspaceName?: string;
  workspacePath?: string;
  running?: boolean;
}

export interface WorkspaceView {
  name: string;
  selected: boolean;
}

export function formatHelp(): string {
  return [
    "<b>Agent Relay</b>",
    "",
    "<b>Commands</b>",
    "<code>/help</code> - show this help",
    "<code>/workspaces</code> - list workspaces",
    "<code>/new &lt;name&gt;</code> - create workspace under WORKSPACE_ROOT",
    "<code>/use &lt;name&gt;</code> - switch this chat to a workspace",
    "<code>/status</code> - show current workspace and Codex session",
    "<code>/tail [n]</code> - show recent agent output, default 50 entries",
    "<code>/exit</code> - stop the current Codex session",
    "<code>/send &lt;text&gt;</code> - send text that starts with / to Codex",
  ].join("\n");
}

export function formatStatus(status: StatusView): string {
  if (!status.workspaceName || !status.workspacePath) {
    return [
      "<b>Status</b>",
      "",
      "No workspace selected.",
      "Use <code>/new &lt;name&gt;</code> or <code>/use &lt;name&gt;</code>.",
    ].join("\n");
  }
  return [
    "<b>Status</b>",
    "",
    `<b>Workspace:</b> <code>${htmlEscape(status.workspaceName)}</code>`,
    `<b>Path:</b> <code>${htmlEscape(status.workspacePath)}</code>`,
    `<b>Codex:</b> ${status.running ? "running" : "stopped"}`,
  ].join("\n");
}

export function formatWorkspaces(workspaces: WorkspaceView[]): string {
  if (workspaces.length === 0) {
    return [
      "<b>Workspaces</b>",
      "",
      "No workspaces.",
      "Use <code>/new &lt;name&gt;</code>.",
    ].join("\n");
  }
  return [
    "<b>Workspaces</b>",
    "",
    ...workspaces.map((workspace) => `${workspace.selected ? "Selected:" : "-"} <code>${htmlEscape(workspace.name)}</code>`),
  ].join("\n");
}

export function formatError(detail: string): string {
  return `<b>Error:</b> ${htmlEscape(detail)}`;
}
