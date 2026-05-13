import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../runtime/config.ts";
import type { AgentDriver, AgentSessionStatus } from "../ports/agent.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { sessionKey } from "../domain/session.ts";
import { createWorkspace, discoverWorkspaceDirectories, isRealDirectory, resolveWorkspacePath, validateWorkspaceName, workspaceDirectoryExists } from "../domain/workspace.ts";
import type { Logger } from "../domain/logger.ts";
import type { RelayStore } from "../storage/store.ts";
import type { InboundMessage, InlineKeyboardMarkup, SendMessageOptions, EditMessageTextOptions } from "../ports/im.ts";
import type { WorkspaceRecord } from "./types.ts";
import type { StatusView } from "./ui/status-view.ts";
import { workspaceCallbackToken } from "./ui/callback-data.ts";
import { confirmMessage, formatWorkspacesMessage } from "./ui/messages.ts";
import { consoleKeyboard, deleteWorkspaceConfirmKeyboard, workspaceIntroKeyboard, workspacesKeyboard } from "./ui/keyboards.ts";
import { paginateWorkspaces } from "./ui/pagination.ts";
import { parsePromptPayload } from "./ui/prompt-state.ts";
import { code, messageWithTitle, textMessage, bold } from "./ui/text-parts.ts";
import { formatHomeMessage } from "./ui/status-message.ts";
import { renderTelegramText, type RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";

const WORKSPACE_INTRO_FILES = ["README.md", "README", "README.markdown", "README.txt"];
const WORKSPACE_INTRO_MAX_CHARS = 2400;

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface WorkspaceFlowDeps {
  config: AppConfig;
  store: RelayStore;
  agent: Pick<AgentDriver, "stop">;
  logger: Logger;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string, options?: { resumePrevious?: boolean }): Promise<AgentSessionStatus>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  cancelActiveTasks(sessionKey: string): Promise<void>;
  statusView(conversationId: ConversationId): StatusView;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

export class WorkspaceFlow {
  constructor(private readonly deps: WorkspaceFlowDeps) {}

  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined {
    const binding = this.deps.store.getBinding(conversationId);
    return binding ? this.deps.store.getWorkspace(binding.workspaceName) : undefined;
  }

  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord {
    const workspace = this.currentWorkspace(conversationId);
    if (!workspace) throw new Error("No workspace selected. Open Relay Home and choose or create a workspace.");
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    return workspace;
  }

  requireWorkspace(name: string): WorkspaceRecord {
    validateWorkspaceName(name);
    const workspace = this.deps.store.getWorkspace(name) ?? {
      name,
      path: resolveWorkspacePath(this.deps.config.workspaceRoot, name),
      createdAt: Date.now(),
    };
    if (!isRealDirectory(workspace.path)) throw new Error(`workspace '${name}' does not exist. Create it from Relay Home.`);
    this.deps.store.upsertWorkspace(workspace);
    return workspace;
  }

  async listAvailableWorkspaces(): Promise<WorkspaceRecord[]> {
    const now = Date.now();
    for (const workspace of await discoverWorkspaceDirectories(this.deps.config.workspaceRoot)) {
      this.deps.store.upsertWorkspace({ ...workspace, createdAt: now });
    }
    return this.deps.store.listWorkspaces();
  }

  async workspaceNameForToken(token: string): Promise<string> {
    const matches = (await this.listAvailableWorkspaces()).filter((workspace) => workspaceCallbackToken(workspace.name) === token);
    if (matches.length === 1) return matches[0]!.name;
    if (matches.length > 1) throw new Error("workspace selection token is ambiguous. Refresh workspaces and try again.");
    throw new Error("workspace selection expired. Refresh workspaces and try again.");
  }

  async renderWorkspacesCallback(message: CallbackMessage, pageIndex: number): Promise<void> {
    const workspaces = await this.listAvailableWorkspaces();
    const selected = this.currentWorkspace(message.conversationId)?.name;
    const page = paginateWorkspaces(workspaces, selected, pageIndex);
    const result = await this.deps.renderCallbackPage(message, formatWorkspacesMessage(page.items.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    })), page.pageIndex, page.totalPages), workspacesKeyboard(page.items, selected, page.pageIndex, page.totalPages));
    this.trackControlMessage(message.conversationId, result);
    this.deps.logger.info("router.workspaces_rendered", {
      conversation_id: message.conversationId,
      message_id: message.messageId,
      selected_workspace: selected,
      page_index: page.pageIndex,
      total_pages: page.totalPages,
      workspace_count: workspaces.length,
      render_method: result.method,
      rendered_message_id: result.messageId,
      console_message_id: this.deps.store.getConsoleMessageId(message.conversationId),
    });
  }

  async renderWorkspaceIntroCallback(message: CallbackMessage, token: string, pageIndex: number): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    const selected = this.currentWorkspace(message.conversationId)?.name === workspace.name;
    const safePageIndex = Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0;
    const intro = await this.readWorkspaceIntro(workspace);
    const result = await this.deps.renderCallbackPage(message, formatWorkspaceIntroMessage(workspace, intro), workspaceIntroKeyboard(workspace, selected, safePageIndex));
    this.trackControlMessage(message.conversationId, result);
  }

  async selectWorkspaceFromToken(message: CallbackMessage, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Selecting workspace.", workspace.name), { inline_keyboard: [] });
    this.deps.store.bindConversation(message.conversationId, workspace.name);
    this.deps.logger.info("router.workspace_selected", { conversation_id: message.conversationId, workspace: workspace.name, path: workspace.path });
    await this.deps.ensureAgentStarted(message.conversationId, workspace, undefined, { resumePrevious: false });
    await this.renderHomeOnCallback(message);
  }

  async confirmDeleteWorkspaceCallback(message: CallbackMessage, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    const result = await this.deps.renderCallbackPage(
      message,
      confirmMessage("Delete workspace?", `This permanently deletes ${workspace.path}.`),
      deleteWorkspaceConfirmKeyboard(workspace.name),
    );
    this.trackControlMessage(message.conversationId, result);
  }

  async deleteWorkspaceCallback(message: CallbackMessage, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Deleting workspace.", workspace.name), { inline_keyboard: [] });
    const key = sessionKey(message.conversationId, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key).catch((error) => {
      this.deps.logger.warn("router.workspace_delete_stop_failed", {
        conversation_id: message.conversationId,
        workspace: workspace.name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    await this.deps.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    await rm(workspace.path, { recursive: true, force: true });
    this.deps.store.deleteWorkspace(workspace.name);
    this.deps.logger.info("router.workspace_deleted", { conversation_id: message.conversationId, workspace: workspace.name, path: workspace.path });
    await this.renderWorkspacesCallback(message, 0);
  }

  async stopFromCallback(message: CallbackMessage): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.conversationId);
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Stopping session.", workspace.name), { inline_keyboard: [] });
    const key = sessionKey(message.conversationId, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.deps.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearBinding(message.conversationId);
    this.deps.logger.info("router.session_stopped", { conversation_id: message.conversationId, workspace: workspace.name, session_key: key });
    await this.renderHomeOnCallback(message);
  }

  private async renderHomeOnCallback(message: CallbackMessage): Promise<void> {
    const status = this.deps.statusView(message.conversationId);
    const mode = this.deps.store.getHomeStatusMode(message.conversationId);
    const result = await this.deps.renderCallbackPage(message, formatHomeMessage(status, mode), consoleKeyboard(status, mode));
    this.trackControlMessage(message.conversationId, result);
    this.deps.logger.info("router.workspace_home_rendered", {
      conversation_id: message.conversationId,
      message_id: message.messageId,
      workspace: status.workspaceName,
      running: Boolean(status.running),
      thread_id: status.threadId,
      render_method: result.method,
      rendered_message_id: result.messageId,
      console_message_id: this.deps.store.getConsoleMessageId(message.conversationId),
    });
  }

  async promptForWorkspaceName(message: CallbackMessage, pageIndex: number): Promise<void> {
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Workspace name requested.", "Reply to the prompt below."), { inline_keyboard: [] });
    const result = await this.deps.sendRendered(message.conversationId, textMessage("Reply with the workspace name. Existing directories under WORKSPACE_ROOT are selected; missing names are created."), {
      forceReply: true,
      inputFieldPlaceholder: "repo name under WORKSPACE_ROOT",
      disableWebPagePreview: true,
    });
    if (!result.messageId) {
      throw new Error("IM adapter did not return a prompt message id.");
    }
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
      promptMessageId: result.messageId,
      kind: "workspace_name",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({
        sourceMessageId: message.messageId,
        pageIndex: normalizePageIndex(pageIndex),
      }),
    });
    this.deps.logger.info("router.workspace_prompt_created", { conversation_id: message.conversationId, prompt_message_id: result.messageId, source_message_id: message.messageId });
  }

  async createWorkspaceFromPrompt(conversationId: ConversationId, promptMessageId: MessageId, name: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const payload = parsePromptPayload(pending?.payloadJson);
    const { existed } = await this.selectOrCreateWorkspace(conversationId, name);
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    await this.deps.sendRendered(conversationId, renderTelegramText([
      "workspace ",
      code(name),
      ` ${existed ? "selected" : "created and selected"}.`,
    ]));
    await this.refreshWorkspacesMessageFromPrompt(conversationId, payload);
  }

  async selectOrCreateWorkspace(conversationId: ConversationId, name: string): Promise<{ name: string; path: string; existed: boolean }> {
    validateWorkspaceName(name);
    const existed = workspaceDirectoryExists(this.deps.config.workspaceRoot, name);
    const path = existed
      ? resolveWorkspacePath(this.deps.config.workspaceRoot, name)
      : await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindConversation(conversationId, name);
    this.deps.logger.info(existed ? "router.workspace_existing_selected" : "router.workspace_created", { conversation_id: conversationId, workspace: name, path });
    await this.deps.ensureAgentStarted(conversationId, { name, path, createdAt: Date.now() }, undefined, { resumePrevious: false });
    return { name, path, existed };
  }

  private async refreshWorkspacesMessageFromPrompt(conversationId: ConversationId, payload: Record<string, unknown> | undefined): Promise<void> {
    const sourceMessageId = payload?.sourceMessageId;
    if (typeof sourceMessageId !== "string" && typeof sourceMessageId !== "number") return;
    const pageIndex = normalizePageIndex(payload?.pageIndex);
    try {
      const workspaces = await this.listAvailableWorkspaces();
      const selected = this.currentWorkspace(conversationId)?.name;
      const page = paginateWorkspaces(workspaces, selected, pageIndex);
      await this.deps.editRendered(conversationId, formatWorkspacesMessage(page.items.map((workspace) => ({
        name: workspace.name,
        selected: workspace.name === selected,
      })), page.pageIndex, page.totalPages), {
        messageId: sourceMessageId,
        replyMarkup: workspacesKeyboard(page.items, selected, page.pageIndex, page.totalPages),
      });
      this.deps.store.setConsoleMessageId(conversationId, sourceMessageId);
    } catch (error) {
      this.deps.logger.warn("router.workspace_prompt_source_refresh_failed", {
        conversation_id: conversationId,
        message_id: sourceMessageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private trackControlMessage(conversationId: ConversationId, result: RenderCallbackPageResult): void {
    if (result.messageId) this.deps.store.setConsoleMessageId(conversationId, result.messageId);
  }

  private async readWorkspaceIntro(workspace: WorkspaceRecord): Promise<string> {
    for (const fileName of WORKSPACE_INTRO_FILES) {
      try {
        const text = await readFile(join(workspace.path, fileName), "utf8");
        return workspaceIntroExcerpt(text);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        this.deps.logger.warn("router.workspace_intro_read_failed", {
          workspace: workspace.name,
          path: join(workspace.path, fileName),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return "No README found.";
  }
}

function formatWorkspaceIntroMessage(workspace: WorkspaceRecord, intro: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Workspace"),
    "\n\nName: ",
    code(workspace.name),
    "\nPath: ",
    code(workspace.path),
    "\n\n",
    bold("README"),
    "\n\n",
    intro,
  ]);
}

function workspaceIntroExcerpt(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return "README is empty.";
  if (normalized.length <= WORKSPACE_INTRO_MAX_CHARS) return normalized;
  const window = normalized.slice(0, WORKSPACE_INTRO_MAX_CHARS);
  const candidates = [
    { index: window.lastIndexOf("\n\n"), minRatio: 0.45, width: 2 },
    { index: window.lastIndexOf("\n"), minRatio: 0.6, width: 1 },
    { index: window.lastIndexOf(" "), minRatio: 0.7, width: 1 },
  ];
  for (const candidate of candidates) {
    if (candidate.index > Math.floor(WORKSPACE_INTRO_MAX_CHARS * candidate.minRatio)) {
      return `${normalized.slice(0, candidate.index + candidate.width).trimEnd()}\n\n...`;
    }
  }
  return `${window.trimEnd()}\n\n...`;
}

function normalizePageIndex(value: unknown): number {
  const pageIndex = typeof value === "number" ? value : Number(value);
  return Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0;
}
