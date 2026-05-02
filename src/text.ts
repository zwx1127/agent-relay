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

export function splitHtmlForTelegram(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const stack: Array<{ name: string; open: string }> = [];
  let current = "";

  for (const token of htmlTokens(text)) {
    const closing = isClosingTag(token.value) ? "" : closingTags(stack);
    if (current.length > 0 && current.length + token.value.length + closing.length > maxChars) {
      chunks.push(current + closing);
      current = stack.map((entry) => entry.open).join("");
    }

    current += token.value;
    if (token.kind === "tag") updateHtmlStack(stack, token.value);
  }

  if (current.length > 0) chunks.push(current + closingTags(stack));
  return chunks.length > 0 ? chunks : [text];
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

export function formatAgentMarkdownForTelegramHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const output: string[] = [];
  let codeBlock: string[] | undefined;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (codeBlock) {
        output.push(`<pre>${htmlEscape(codeBlock.join("\n"))}</pre>`);
        codeBlock = undefined;
      } else {
        codeBlock = [];
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.push(line);
      continue;
    }

    output.push(formatMarkdownLine(line));
  }

  if (codeBlock) output.push(`<pre>${htmlEscape(codeBlock.join("\n"))}</pre>`);
  return output.join("\n");
}

function formatMarkdownLine(line: string): string {
  if (line.trim().length === 0) return "";

  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) return `<b>${formatInlineMarkdown(heading[2] ?? "")}</b>`;

  const unordered = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (unordered) return `${htmlEscape(unordered[1] ?? "")}• ${formatInlineMarkdown(unordered[2] ?? "")}`;

  const ordered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
  if (ordered) return `${htmlEscape(ordered[1] ?? "")}${ordered[2]}. ${formatInlineMarkdown(ordered[3] ?? "")}`;

  return formatInlineMarkdown(line);
}

function formatInlineMarkdown(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      if (end > index + 1) {
        result += `<code>${htmlEscape(value.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    const link = tryParseMarkdownLink(value, index);
    if (link) {
      result += `<a href="${htmlEscape(link.url)}">${formatInlineMarkdown(link.label)}</a>`;
      index = link.end;
      continue;
    }

    const boldMarker = value.startsWith("**", index) ? "**" : value.startsWith("__", index) ? "__" : undefined;
    if (boldMarker) {
      const end = value.indexOf(boldMarker, index + boldMarker.length);
      if (end > index + boldMarker.length) {
        result += `<b>${formatInlineMarkdown(value.slice(index + boldMarker.length, end))}</b>`;
        index = end + boldMarker.length;
        continue;
      }
    }

    if (value[index] === "*") {
      const end = value.indexOf("*", index + 1);
      if (end > index + 1) {
        result += `<i>${formatInlineMarkdown(value.slice(index + 1, end))}</i>`;
        index = end + 1;
        continue;
      }
    }

    result += htmlEscape(value[index] ?? "");
    index += 1;
  }

  return result;
}

function tryParseMarkdownLink(value: string, index: number): { label: string; url: string; end: number } | undefined {
  if (value[index] !== "[") return undefined;
  const labelEnd = value.indexOf("]", index + 1);
  if (labelEnd <= index + 1 || value[labelEnd + 1] !== "(") return undefined;
  const urlEnd = value.indexOf(")", labelEnd + 2);
  if (urlEnd <= labelEnd + 2) return undefined;

  const url = value.slice(labelEnd + 2, urlEnd);
  if (!/^https?:\/\/[^\s<>"()]+$/i.test(url)) return undefined;
  return { label: value.slice(index + 1, labelEnd), url, end: urlEnd + 1 };
}

function htmlTokens(text: string): Array<{ kind: "tag" | "text"; value: string }> {
  const tokens: Array<{ kind: "tag" | "text"; value: string }> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end > index) {
        tokens.push({ kind: "tag", value: text.slice(index, end + 1) });
        index = end + 1;
        continue;
      }
    }
    if (text[index] === "&") {
      const entity = /^&(?:amp|lt|gt|quot);/.exec(text.slice(index));
      if (entity) {
        tokens.push({ kind: "text", value: entity[0] });
        index += entity[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: text[index] ?? "" });
    index += 1;
  }
  return tokens;
}

function updateHtmlStack(stack: Array<{ name: string; open: string }>, tag: string): void {
  const close = /^<\/([a-z0-9]+)>$/i.exec(tag);
  if (close) {
    const name = close[1]?.toLowerCase();
    const index = stack.findLastIndex((entry) => entry.name === name);
    if (index >= 0) stack.splice(index, 1);
    return;
  }

  const open = /^<([a-z0-9]+)(?:\s[^>]*)?>$/i.exec(tag);
  if (!open) return;
  const name = open[1]?.toLowerCase();
  if (!name || tag.endsWith("/>")) return;
  stack.push({ name, open: tag });
}

function isClosingTag(value: string): boolean {
  return /^<\/[a-z0-9]+>$/i.test(value);
}

function closingTags(stack: Array<{ name: string }>): string {
  return stack.toReversed().map((entry) => `</${entry.name}>`).join("");
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
