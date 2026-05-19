import { lstat, readFile } from "node:fs/promises";
import { join, posix, relative, resolve, isAbsolute } from "node:path";
import type { ConversationId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import type { InlineKeyboardMarkup, InboundMessage } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import { renderTelegramText, splitRenderedForTelegram, type RenderedTelegramText, type TelegramTextPart } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";
import type { WorkspaceRecord } from "./types.ts";
import { CODEX_PROMPT_TTL_MS, LIST_PAGE_SIZE, PAGE_MAX_CHARS, UI_BUTTON } from "./ui/constants.ts";
import { deleteWorkspaceCallbackData, shortToken, workspaceCallbackData } from "./ui/callback-data.ts";
import { buttonLabel } from "./ui/keyboards.ts";
import { decoratePagedOutput } from "./ui/pagination.ts";
import { bold, code, messageWithTitle } from "./ui/text-parts.ts";

const MAX_TEXT_FILE_BYTES = 256 * 1024;

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface WorkspaceFileBrowserDeps {
  store: RelayStore;
  logger: Logger;
  workspaceNameForToken(token: string): Promise<string>;
  requireWorkspace(name: string): WorkspaceRecord;
  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

export interface WorkspaceFileEntry {
  kind: "directory" | "file";
  name: string;
  path: string;
}

interface FileBrowserState {
  command: "file_browser";
  token: string;
  workspaceName: string;
  workspacePageIndex: number;
  dir: string;
  mode: "directory" | "file";
  filePath?: string;
}

export class WorkspaceFileBrowser {
  constructor(private readonly deps: WorkspaceFileBrowserDeps) {}

  async openWorkspaceRoot(message: CallbackMessage, workspaceToken: string, workspacePageIndex: number): Promise<void> {
    const workspaceName = await this.deps.workspaceNameForToken(workspaceToken);
    const workspace = this.deps.requireWorkspace(workspaceName);
    const token = shortToken();
    await this.renderDirectory(message, workspace, {
      command: "file_browser",
      token,
      workspaceName: workspace.name,
      workspacePageIndex: normalizePageIndex(workspacePageIndex),
      dir: "",
      mode: "directory",
    }, 0);
  }

  async handleCallback(message: CallbackMessage, payload: string): Promise<void> {
    const parts = payload.split(":");
    const token = parts[1] ?? "";
    const action = parts[2] ?? "";
    const value = parts[3] ?? "";
    const state = this.stateForMessage(message, token);
    if (!state) {
      await this.deps.renderCallbackPage(message, messageWithTitle("File browser expired."), { inline_keyboard: [] });
      return;
    }
    const workspace = this.deps.requireWorkspace(state.workspaceName);

    switch (action) {
      case "pg":
        await this.renderDirectory(message, workspace, { ...state, mode: "directory" }, normalizePageIndex(value));
        return;
      case "up": {
        const parent = parentDir(state.dir);
        await this.renderDirectory(message, workspace, { ...state, dir: parent, mode: "directory" }, 0);
        return;
      }
      case "b":
        await this.renderDirectory(message, workspace, { ...state, mode: "directory" }, normalizePageIndex(value));
        return;
      case "d":
      case "o": {
        const index = Number(value);
        const trackedFiles = await listTrackedWorkspaceFiles(workspace.path);
        const entries = directoryEntries(trackedFiles, state.dir);
        const entry = Number.isInteger(index) ? entries[index] : undefined;
        if (!entry || entry.kind !== (action === "d" ? "directory" : "file")) {
          await this.deps.renderCallbackPage(message, messageWithTitle("File entry unavailable."), directoryKeyboard(state, [], 0, 1, workspace, this.isSelected(message.conversationId, workspace)));
          return;
        }
        if (entry.kind === "directory") {
          await this.renderDirectory(message, workspace, { ...state, dir: entry.path, mode: "directory" }, 0);
          return;
        }
        await this.renderFile(message, workspace, { ...state, mode: "file", filePath: entry.path }, 0);
        return;
      }
      case "fp":
        if (!state.filePath) {
          await this.deps.renderCallbackPage(message, messageWithTitle("File entry unavailable."), { inline_keyboard: [] });
          return;
        }
        await this.renderFile(message, workspace, state, normalizePageIndex(value));
        return;
      default:
        throw new Error("Unknown file browser action.");
    }
  }

  private async renderDirectory(message: CallbackMessage, workspace: WorkspaceRecord, state: FileBrowserState, rawPageIndex: number): Promise<void> {
    const trackedFiles = await listTrackedWorkspaceFiles(workspace.path);
    const entries = directoryEntries(trackedFiles, state.dir);
    const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
    const pageIndex = clampPage(rawPageIndex, totalPages);
    const pageEntries = entries.slice(pageIndex * LIST_PAGE_SIZE, pageIndex * LIST_PAGE_SIZE + LIST_PAGE_SIZE);
    const nextState = { ...state, mode: "directory" as const };
    const result = await this.deps.renderCallbackPage(
      message,
      formatDirectoryMessage(workspace, state.dir, pageEntries, pageIndex, totalPages, entries.length),
      directoryKeyboard(nextState, entries, pageIndex, totalPages, workspace, this.isSelected(message.conversationId, workspace)),
    );
    this.track(message.conversationId, result, nextState);
    this.deps.logger.info("router.workspace_files_rendered", {
      conversation_id: message.conversationId,
      workspace: workspace.name,
      dir: state.dir || "/",
      page_index: pageIndex,
      total_pages: totalPages,
      entries: entries.length,
      render_method: result.method,
    });
  }

  private async renderFile(message: CallbackMessage, workspace: WorkspaceRecord, state: FileBrowserState, rawPageIndex: number): Promise<void> {
    if (!state.filePath) throw new Error("File path is missing.");
    const trackedFiles = await listTrackedWorkspaceFiles(workspace.path);
    const text = await readTrackedTextFile(workspace.path, state.filePath, trackedFiles);
    const rendered = formatFileMessage(workspace, state.filePath, text);
    const pages = splitRenderedForTelegram(rendered, PAGE_MAX_CHARS);
    const pageIndex = clampPage(rawPageIndex, pages.length);
    const page = pages.length > 1 ? decoratePagedOutput(pages[pageIndex]!, pageIndex, pages.length) : pages[pageIndex]!;
    const nextState = { ...state, mode: "file" as const };
    const result = await this.deps.renderCallbackPage(
      message,
      page,
      fileKeyboard(nextState, pageIndex, pages.length),
    );
    this.track(message.conversationId, result, nextState);
    this.deps.logger.info("router.workspace_file_rendered", {
      conversation_id: message.conversationId,
      workspace: workspace.name,
      path: state.filePath,
      page_index: pageIndex,
      total_pages: pages.length,
      render_method: result.method,
    });
  }

  private stateForMessage(message: CallbackMessage, token: string): FileBrowserState | undefined {
    if (!message.messageId) return undefined;
    const pending = this.deps.store.getPendingPrompt(message.conversationId, message.messageId);
    if (!pending || pending.kind !== "relay_command" || isExpired(pending)) return undefined;
    const data = parseFileBrowserState(pending.payloadJson);
    if (!data || data.token !== token) return undefined;
    return data;
  }

  private track(conversationId: ConversationId, result: RenderCallbackPageResult, state: FileBrowserState): void {
    if (!result.messageId) return;
    this.deps.store.setConsoleMessageId(conversationId, result.messageId);
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify(state),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private isSelected(conversationId: ConversationId, workspace: WorkspaceRecord): boolean {
    return this.deps.currentWorkspace(conversationId)?.name === workspace.name;
  }
}

export async function listTrackedWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(detail ? `Unable to list tracked files: ${detail}` : "Unable to list tracked files. Ensure the workspace is a git repository.");
  }
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => normalizeBrowserPath(path))
    .sort((left, right) => left.localeCompare(right));
}

export function directoryEntries(trackedFiles: string[], dir: string): WorkspaceFileEntry[] {
  const normalizedDir = normalizeDirectoryPath(dir);
  const directoryPaths = new Map<string, WorkspaceFileEntry>();
  const fileEntries: WorkspaceFileEntry[] = [];

  for (const filePath of trackedFiles.map((path) => normalizeBrowserPath(path))) {
    const rest = relativeToDirectory(filePath, normalizedDir);
    if (rest === undefined || rest.length === 0) continue;
    const [first, ...remaining] = rest.split("/");
    if (!first) continue;
    if (remaining.length > 0) {
      const path = normalizedDir ? `${normalizedDir}/${first}` : first;
      directoryPaths.set(path, { kind: "directory", name: first, path });
    } else {
      fileEntries.push({ kind: "file", name: first, path: filePath });
    }
  }

  return [
    ...[...directoryPaths.values()].sort(compareEntries),
    ...fileEntries.sort(compareEntries),
  ];
}

export async function readTrackedTextFile(workspacePath: string, browserPath: string, trackedFiles: string[]): Promise<string> {
  const normalizedPath = normalizeBrowserPath(browserPath);
  if (!trackedFiles.includes(normalizedPath)) throw new Error("File is not tracked by git.");
  const absolutePath = resolveInsideWorkspace(workspacePath, normalizedPath);
  const stat = await lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("File is not a regular file.");
  if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error(`File is too large to preview (${formatBytes(stat.size)}; limit ${formatBytes(MAX_TEXT_FILE_BYTES)}).`);
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) throw new Error("File appears to be binary.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8 text.");
  }
}

function formatDirectoryMessage(workspace: WorkspaceRecord, dir: string, entries: WorkspaceFileEntry[], pageIndex: number, totalPages: number, totalEntries: number): RenderedTelegramText {
  const parts: TelegramTextPart[] = [
    bold("Files"),
    "\n\nWorkspace: ",
    code(workspace.name),
    "\nPath: ",
    code(displayPath(dir)),
    `\nPage ${pageIndex + 1}/${totalPages}`,
  ];
  if (totalEntries === 0) {
    parts.push("\n\nNo tracked files here.");
  } else {
    for (const entry of entries) {
      parts.push("\n", entry.kind === "directory" ? "[dir] " : "[file] ", code(entry.kind === "directory" ? `${entry.name}/` : entry.name));
    }
  }
  return renderTelegramText(parts);
}

function formatFileMessage(workspace: WorkspaceRecord, filePath: string, text: string): RenderedTelegramText {
  const displayText = text.length === 0 ? "(empty file)" : text;
  return renderTelegramText([
    bold("File"),
    "\n\nWorkspace: ",
    code(workspace.name),
    "\nPath: ",
    code(displayPath(filePath)),
    "\nSize: ",
    formatBytes(new TextEncoder().encode(text).byteLength),
    "\n\n",
    { text: displayText, entity: "pre" },
  ]);
}

function directoryKeyboard(state: FileBrowserState, entries: WorkspaceFileEntry[], pageIndex: number, totalPages: number, workspace: WorkspaceRecord, selected: boolean): InlineKeyboardMarkup {
  const start = pageIndex * LIST_PAGE_SIZE;
  const pageEntries = entries.slice(start, start + LIST_PAGE_SIZE);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = pageEntries.map((entry, offset) => [{
    text: buttonLabel(entry.kind === "directory" ? `${entry.name}/` : entry.name),
    callback_data: `ar:f:${state.token}:${entry.kind === "directory" ? "d" : "o"}:${start + offset}`,
  }]);
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.previousPage, callback_data: `ar:f:${state.token}:pg:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:f:${state.token}:pg:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }
  const footer = [
    { text: UI_BUTTON.back, callback_data: `ar:wl:${state.workspacePageIndex}` },
    ...(state.dir ? [{ text: "Up", callback_data: `ar:f:${state.token}:up` }] : []),
    { text: selected ? UI_BUTTON.selected : UI_BUTTON.unselected, callback_data: workspaceCallbackData(workspace.name) },
    { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(workspace.name, false) },
  ];
  rows.push(footer);
  return { inline_keyboard: rows };
}

function fileKeyboard(state: FileBrowserState, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.firstPage, callback_data: `ar:f:${state.token}:fp:0` },
      { text: UI_BUTTON.previousPage, callback_data: `ar:f:${state.token}:fp:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:f:${state.token}:fp:${Math.min(totalPages - 1, pageIndex + 1)}` },
      { text: UI_BUTTON.lastPage, callback_data: `ar:f:${state.token}:fp:${totalPages - 1}` },
    ]);
  }
  rows.push([{ text: UI_BUTTON.back, callback_data: `ar:f:${state.token}:b` }]);
  return { inline_keyboard: rows };
}

function parseFileBrowserState(payloadJson: string | undefined): FileBrowserState | undefined {
  if (!payloadJson) return undefined;
  try {
    const parsed = JSON.parse(payloadJson) as Partial<FileBrowserState>;
    if (parsed.command !== "file_browser") return undefined;
    if (!parsed.token || !parsed.workspaceName || parsed.mode !== "directory" && parsed.mode !== "file") return undefined;
    return {
      command: "file_browser",
      token: parsed.token,
      workspaceName: parsed.workspaceName,
      workspacePageIndex: normalizePageIndex(parsed.workspacePageIndex),
      dir: normalizeDirectoryPath(parsed.dir ?? ""),
      mode: parsed.mode,
      ...(parsed.filePath ? { filePath: normalizeBrowserPath(parsed.filePath) } : {}),
    };
  } catch {
    return undefined;
  }
}

function normalizeBrowserPath(value: string): string {
  const normalized = value.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("\\") || /[\0-\x1F\x7F]/u.test(normalized)) throw new Error("Invalid file path.");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid file path.");
  return parts.join("/");
}

function normalizeDirectoryPath(value: string): string {
  if (!value) return "";
  return normalizeBrowserPath(value);
}

function resolveInsideWorkspace(workspacePath: string, browserPath: string): string {
  const root = resolve(workspacePath);
  const absolutePath = resolve(join(root, ...browserPath.split("/")));
  const rel = relative(root, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("File path must stay inside the selected workspace.");
  return absolutePath;
}

function relativeToDirectory(filePath: string, dir: string): string | undefined {
  if (!dir) return filePath;
  if (filePath === dir) return "";
  const prefix = `${dir}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : undefined;
}

function parentDir(dir: string): string {
  if (!dir) return "";
  const parent = posix.dirname(dir);
  return parent === "." ? "" : parent;
}

function displayPath(path: string): string {
  return path ? `/${path}` : "/";
}

function compareEntries(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  return left.name.localeCompare(right.name);
}

function clampPage(value: number, totalPages: number): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(totalPages - 1, value));
}

function normalizePageIndex(value: unknown): number {
  const pageIndex = typeof value === "number" ? value : Number(value);
  return Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0;
}

function isExpired(prompt: { expiresAt?: number }): boolean {
  return typeof prompt.expiresAt === "number" && prompt.expiresAt <= Date.now();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimFixed(bytes / 1024)} KiB`;
  return `${trimFixed(bytes / (1024 * 1024))} MiB`;
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
