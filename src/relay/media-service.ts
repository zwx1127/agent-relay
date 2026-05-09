import { lstat, readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { isAuthorized, type AppConfig } from "../runtime/config.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentImageInput, AgentImageOutputEvent, AgentSessionStatus, AgentTaskInput } from "../ports/agent.ts";
import type { ImAdapter, MediaInboundMessage } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import type { Logger, LogFields } from "../domain/logger.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import type { WorkspaceRecord } from "./types.ts";
import { DEFAULT_IMAGE_PROMPT, MEDIA_GROUP_QUIET_MS } from "./ui/constants.ts";
import { bestPhoto, formatBytes, pathContains, truncateTelegramCaption } from "./ui/media-format.ts";
import { formatErrorMessage } from "./ui/messages.ts";
import { textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { extensionFromTelegramPath, imageBlobFromPath, saveGeneratedImage, saveRelayMedia } from "./media.ts";

interface MediaGroupState {
  conversationId: ConversationId;
  messages: MediaInboundMessage[];
  timer?: Timer;
}

export interface MediaRelayDeps {
  config: AppConfig;
  store: RelayStore;
  adapter: Pick<ImAdapter, "sendMessage" | "sendPhoto" | "downloadFile">;
  agent: Pick<AgentDriver, "getStatus">;
  logger: Logger;
  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined;
  renderConsole(conversationId: ConversationId): Promise<void>;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord): Promise<AgentSessionStatus>;
  sendWaitingPromptNotice(conversationId: ConversationId, status: AgentSessionStatus): Promise<boolean>;
  submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference?: TaskSubmitPreference, input?: AgentTaskInput): Promise<void>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText): Promise<{ messageId?: MessageId }>;
  trySendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, failureEvent: string, fields?: LogFields): Promise<void>;
  appendSystem(conversationId: ConversationId, text: string): void;
  lastUserMessageId(sessionKey: string): MessageId | undefined;
}

export class MediaRelayService {
  private readonly mediaGroups = new Map<string, MediaGroupState>();

  constructor(private readonly deps: MediaRelayDeps) {}

  async handleMediaMessage(message: MediaInboundMessage): Promise<void> {
    this.deps.logger.info("router.media_received", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      message_id: message.id,
      caption_len: message.caption?.length ?? 0,
      photo_count: message.photos.length,
      media_group_id: message.mediaGroupId,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.conversationId)) {
      this.deps.logger.warn("router.unauthorized_media", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.deps.sendRendered(message.conversationId, textMessage("Unauthorized."));
      return;
    }

    if (message.mediaGroupId) {
      this.bufferMediaGroup(message);
      return;
    }

    try {
      await this.submitMediaMessages(message.conversationId, [message]);
    } catch (error) {
      await this.handleMediaError(message.conversationId, message.id, error);
    }
  }

  private bufferMediaGroup(message: MediaInboundMessage): void {
    const key = `${message.conversationId}:${message.mediaGroupId}`;
    const existing = this.mediaGroups.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const state = existing ?? { conversationId: message.conversationId, messages: [] };
    state.messages.push(message);
    state.timer = setTimeout(() => {
      this.mediaGroups.delete(key);
      void this.submitMediaMessages(state.conversationId, state.messages)
        .catch((error) => this.handleMediaError(state.conversationId, message.id, error));
    }, MEDIA_GROUP_QUIET_MS);
    this.mediaGroups.set(key, state);
  }

  private async submitMediaMessages(conversationId: ConversationId, messages: MediaInboundMessage[]): Promise<void> {
    const workspace = this.deps.currentWorkspace(conversationId);
    if (!workspace) {
      await this.deps.renderConsole(conversationId);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (await this.deps.sendWaitingPromptNotice(conversationId, status)) return;

    const sorted = [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
    const prompt = sorted.map((item) => item.caption?.trim()).find(Boolean) ?? DEFAULT_IMAGE_PROMPT;
    const images: AgentImageInput[] = [];
    for (const media of sorted) {
      images.push(await this.downloadAndSavePhoto(workspace, media));
    }
    await this.deps.submitTask(conversationId, prompt, sorted[0]?.messageId, "auto", { text: prompt, images });
  }

  private async downloadAndSavePhoto(workspace: WorkspaceRecord, message: MediaInboundMessage): Promise<AgentImageInput> {
    const photo = bestPhoto(message.photos);
    if (!photo) throw new Error("IM photo is missing.");
    if (photo.fileSize && photo.fileSize > this.deps.config.mediaMaxBytes) {
      throw new Error(`Image is too large (${formatBytes(photo.fileSize)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    if (!this.deps.adapter.downloadFile) throw new Error("IM adapter cannot download media.");
    const downloaded = await this.deps.adapter.downloadFile(photo.fileId);
    const size = downloaded.fileSize ?? downloaded.bytes.byteLength;
    if (size > this.deps.config.mediaMaxBytes || downloaded.bytes.byteLength > this.deps.config.mediaMaxBytes) {
      throw new Error(`Image is too large (${formatBytes(Math.max(size, downloaded.bytes.byteLength))}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    const path = await saveRelayMedia(workspace.path, "incoming", downloaded.bytes, {
      extension: extensionFromTelegramPath(downloaded.filePath),
      messageId: message.messageId,
    });
    return { path, ...(message.caption ? { caption: message.caption } : {}) };
  }

  private async handleMediaError(conversationId: ConversationId, messageId: MessageId, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    this.deps.logger.error("router.media_failed", {
      conversation_id: conversationId,
      message_id: messageId,
      error: error instanceof Error ? error : new Error(detail),
    });
    await this.deps.trySendRendered(
      conversationId,
      formatErrorMessage(detail),
      "router.media_error_notice_failed",
      { message_id: messageId },
    );
    this.deps.appendSystem(conversationId, `Error: ${detail}\n`);
  }

  async sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const workspace = this.deps.currentWorkspace(parsed.conversationId);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    try {
      const path = event.path ? await this.copyOutgoingImage(workspace.path, event.path) : event.data ? await saveGeneratedImage(workspace.path, event.data) : undefined;
      if (!path) throw new Error("Codex image output did not include image data.");
      await this.sendStoredImage(parsed.conversationId, parsed.workspaceName, path, event.caption, this.deps.lastUserMessageId(event.sessionKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("router.agent_image_send_failed", {
        conversation_id: parsed.conversationId,
        session_key: event.sessionKey,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.deps.trySendRendered(
        parsed.conversationId,
        formatErrorMessage(`Could not send image: ${detail}`),
        "router.agent_image_error_notice_failed",
        { session_key: event.sessionKey },
      );
      this.deps.appendSystem(parsed.conversationId, `Error: Could not send image: ${detail}\n`);
    }
  }

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey: sessionKeyValue, workspace } = this.resolveDebugImageSession(input);
    await this.validateDebugImagePath(input.path, workspace.path);
    const path = await this.copyOutgoingImage(workspace.path, input.path);
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredImage(parsed.conversationId, parsed.workspaceName, path, input.caption, this.deps.lastUserMessageId(sessionKeyValue));
    this.deps.logger.info("router.debug_image_sent", {
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      session_key: sessionKeyValue,
      source_path: input.path,
      stored_path: path,
    });
    return { path };
  }

  private resolveDebugImageSession(input: SendImageCapabilityRequest): { sessionKey: string; workspace: WorkspaceRecord } {
    if (input.sessionKey) {
      const parsed = parseSessionKey(input.sessionKey);
      if (!parsed) throw new Error("sessionKey is invalid");
      const workspace = this.deps.store.getWorkspace(parsed.workspaceName);
      if (!workspace) throw new Error("session workspace was not found");
      const status = this.deps.agent.getStatus(input.sessionKey);
      if (!status?.running) throw new Error("session is not running");
      return { sessionKey: input.sessionKey, workspace };
    }

    const cwd = input.cwd ? resolve(input.cwd) : undefined;
    const matches = this.deps.store.listRunningSessions()
      .flatMap((session) => {
        const workspace = this.deps.store.getWorkspace(session.workspace_name);
        const key = session.session_key;
        const status = this.deps.agent.getStatus(key);
        if (!workspace || !status?.running) return [];
        if (cwd && !pathContains(workspace.path, cwd)) return [];
        return [{ sessionKey: key, workspace }];
      });
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error("No running relay session matches this image request.");
    throw new Error("Multiple running relay sessions match this image request; pass --session-key.");
  }

  private async validateDebugImagePath(path: string, workspacePath: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error("Image path must be absolute.");
    const resolvedPath = resolve(path);
    if (!pathContains(workspacePath, resolvedPath)) throw new Error("Image path must stay inside the selected workspace.");
    const extension = extname(resolvedPath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
      throw new Error("Image must be a PNG, JPG, WEBP, or GIF file.");
    }
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Image path must be a regular file.");
    if (stat.size > this.deps.config.mediaMaxBytes) {
      throw new Error(`Image is too large (${formatBytes(stat.size)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
  }

  private async copyOutgoingImage(workspacePath: string, sourcePath: string): Promise<string> {
    return await saveRelayMedia(workspacePath, "outgoing", await readFile(sourcePath), { extension: extensionFromTelegramPath(sourcePath) });
  }

  private async sendStoredImage(conversationId: ConversationId, workspaceName: string, path: string, caption?: string, replyToMessageId?: MessageId): Promise<void> {
    if (!this.deps.adapter.sendPhoto) throw new Error("IM adapter cannot send images.");
    const blob = await imageBlobFromPath(path);
    await this.deps.adapter.sendPhoto(conversationId, blob, {
      ...(caption ? { caption: truncateTelegramCaption(caption) } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });
    this.deps.store.appendTranscript({
      conversationId,
      workspaceName,
      role: "agent",
      text: `[image: ${path}]\n`,
      createdAt: Date.now(),
    });
  }
}
