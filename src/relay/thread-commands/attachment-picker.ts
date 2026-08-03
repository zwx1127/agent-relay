import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ConversationId } from "../../domain/ids.ts";
import { sessionKey } from "../../domain/session.ts";
import type { AgentDriver, AgentInputAttachment, AgentSessionStatus } from "../../ports/agent.ts";
import type { InboundMessage } from "../../ports/im.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { PendingPrompt, WorkspaceRecord } from "../types.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "../controller-types.ts";
import { CODEX_PROMPT_TTL_MS, LIST_PAGE_SIZE } from "../ui/constants.ts";
import { shortToken } from "../ui/callback-data.ts";
import { attachmentPickerKeyboard } from "../ui/keyboards.ts";
import { asPromptRecord } from "../ui/prompt-state.ts";
import { messageWithTitle } from "../ui/text-parts.ts";
import { pathContains } from "../ui/media-format.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface AttachmentPickerDeps {
  store: Pick<RelayStore, "setPendingPrompt" | "deletePendingPrompt">;
  agent: Pick<AgentDriver, "listSkills" | "searchFiles" | "getStatus">;
  commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }>;
  commandBusy(conversationId: ConversationId, workspaceName: string, status: AgentSessionStatus | undefined): boolean;
  sendBusyCommandNotice(conversationId: ConversationId): Promise<void>;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Record<string, unknown>): Promise<{ messageId?: string | number }>;
  renderStrictCallbackPage(message: CallbackMessage, body: RenderedTelegramText, replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }): Promise<RenderCallbackPageResult>;
  expireCallbackPrompt(message: CallbackMessage): Promise<void>;
}

export class AttachmentPicker {
  constructor(private readonly deps: AttachmentPickerDeps) {}

  async renderSkills(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const { workspace, status, key } = await this.deps.commandSession(conversationId);
    if (this.deps.commandBusy(conversationId, workspace.name, status)) {
      await this.deps.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.listSkills) throw new Error("Agent driver cannot list skills.");
    const query = searchTerm.trim().toLocaleLowerCase();
    const skills = (await this.deps.agent.listSkills(workspace.path))
      .filter((skill) => skill.enabled)
      .filter((skill) => !query || `${skill.name} ${skill.description ?? ""} ${skill.shortDescription ?? ""}`.toLocaleLowerCase().includes(query))
      .map((skill) => ({ label: skill.name, type: "skill" as const, name: skill.name, path: skill.path }));
    await this.render(conversationId, key, status.threadId, "skill", skills, searchTerm);
  }

  async renderMentions(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const { workspace, status, key } = await this.deps.commandSession(conversationId);
    if (this.deps.commandBusy(conversationId, workspace.name, status)) {
      await this.deps.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.searchFiles) throw new Error("Agent driver cannot search workspace files.");
    const results = await this.deps.agent.searchFiles(workspace.path, searchTerm.trim(), { limit: 100 });
    const entries = results.flatMap((file) => {
      const path = resolve(file.root, file.path);
      if (!isWorkspaceMentionPath(workspace.path, path)) return [];
      return [{ label: file.path, type: "mention" as const, name: file.fileName || basename(path), path }];
    });
    await this.render(conversationId, key, status.threadId, "mention", entries, searchTerm);
  }

  async handleCallback(message: CallbackMessage, pending: PendingPrompt, data: Record<string, unknown>, action: string | undefined): Promise<void> {
    if (data.command !== "attachment_select" || !action) {
      await this.deps.expireCallbackPrompt(message);
      return;
    }
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || pending.sessionKey !== key || status.threadId !== data.threadId || this.deps.commandBusy(message.conversationId, workspace.name, status)) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Attachment selection expired.", "The active chat changed or Codex is busy."), { inline_keyboard: [] });
      return;
    }
    const entries = Array.isArray(data.entries) ? data.entries.map(asPromptRecord).filter(Boolean) as Record<string, unknown>[] : [];
    const kind = data.kind === "skill" ? "skill" : "mention";
    if (action.startsWith("p")) {
      const requestedPage = Number(action.slice(1));
      const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
      const pageIndex = Math.min(totalPages - 1, Math.max(0, Number.isInteger(requestedPage) ? requestedPage : 0));
      const page = entries.slice(pageIndex * LIST_PAGE_SIZE, (pageIndex + 1) * LIST_PAGE_SIZE).map((entry) => ({ label: typeof entry.label === "string" ? entry.label : "Attachment" }));
      await this.deps.renderStrictCallbackPage(
        message,
        attachmentPickerMessage(kind, typeof data.searchTerm === "string" ? data.searchTerm : "", pageIndex, totalPages),
        attachmentPickerKeyboard(String(data.token), page, pageIndex, totalPages),
      );
      this.deps.store.setPendingPrompt({ ...pending, payloadJson: JSON.stringify({ ...data, pageIndex }) });
      return;
    }
    if (!action.startsWith("i")) throw new Error("Attachment selection is unavailable.");
    const index = Number(action.slice(1));
    const selected = entries[index];
    const name = typeof selected?.name === "string" ? selected.name : undefined;
    const path = typeof selected?.path === "string" ? selected.path : undefined;
    if (!name || !path) throw new Error("Attachment selection expired.");
    if (kind === "mention" && !isWorkspaceMentionPath(workspace.path, path)) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Attachment rejected.", "The selected path is outside the workspace."), { inline_keyboard: [] });
      return;
    }
    const attachment: AgentInputAttachment = { type: kind, name, path };
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${kind === "skill" ? "Skill" : "File"} selected.`, name), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    const promptToken = shortToken();
    const result = await this.deps.sendRendered(message.conversationId, messageWithTitle("What should Codex do?", `${kind === "skill" ? "Skill" : "Mention"}: ${name}`), {
      forceReply: true,
      forceReplyInstruction: "Reply with the task for this attachment.",
      inputFieldPlaceholder: "Task description",
    });
    if (!result.messageId) throw new Error("IM adapter did not return an attachment prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "attachment_task", token: promptToken, threadId: status.threadId, attachment }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async render(
    conversationId: ConversationId,
    key: string,
    threadId: string | undefined,
    kind: "skill" | "mention",
    entries: Array<{ label: string; type: "skill" | "mention"; name: string; path: string }>,
    searchTerm: string,
  ): Promise<void> {
    if (entries.length === 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle(kind === "skill" ? "No matching skills." : "No matching files.", searchTerm ? `Search: ${searchTerm}` : undefined));
      return;
    }
    const token = shortToken();
    const totalPages = Math.ceil(entries.length / LIST_PAGE_SIZE);
    const result = await this.deps.sendRendered(conversationId, attachmentPickerMessage(kind, searchTerm, 0, totalPages), {
      replyMarkup: attachmentPickerKeyboard(token, entries.slice(0, LIST_PAGE_SIZE), 0, totalPages),
    });
    if (!result.messageId) throw new Error("IM adapter did not return an attachment picker message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "attachment_select", token, kind, searchTerm, pageIndex: 0, threadId, entries }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }
}

function attachmentPickerMessage(kind: "skill" | "mention", searchTerm: string, pageIndex: number, totalPages: number): RenderedTelegramText {
  const target = kind === "skill" ? "skill" : "file or directory";
  return messageWithTitle(`Select a ${target}.`, `${searchTerm ? `Search: ${searchTerm}\n` : ""}Page ${pageIndex + 1}/${totalPages}`);
}

export function parseAttachmentRecord(value: unknown): AgentInputAttachment | undefined {
  const record = asPromptRecord(value);
  if (!record || (record.type !== "skill" && record.type !== "mention") || typeof record.name !== "string" || typeof record.path !== "string") return undefined;
  return { type: record.type, name: record.name, path: record.path };
}

export function isWorkspaceMentionPath(workspacePath: string, candidatePath: string): boolean {
  try {
    return pathContains(realpathSync(workspacePath), realpathSync(resolve(candidatePath)));
  } catch {
    return false;
  }
}
