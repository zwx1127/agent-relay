import { lstat, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { isAuthorized, type AppConfig } from "../runtime/config.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentImageInput, AgentImageOutputEvent, AgentSessionStatus, AgentTaskInput } from "../ports/agent.ts";
import type { FileInboundMessage, ImAdapter, MediaInboundMessage } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import type { Logger, LogFields } from "../domain/logger.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { SendFileCapabilityRequest } from "./capabilities/send-file.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import type { WorkspaceRecord } from "./types.ts";
import { DEFAULT_IMAGE_PROMPT, MEDIA_GROUP_QUIET_MS } from "./ui/constants.ts";
import { bestPhoto, formatBytes, pathContains, truncateTelegramCaption } from "./ui/media-format.ts";
import { formatErrorMessage } from "./ui/messages.ts";
import { textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { extensionFromTelegramPath, fileBlobFromPath, imageBlobFromPath, safeFilename, saveGeneratedImage, saveRelayFile, saveRelayMedia } from "./media.ts";

interface MediaGroupState {
  conversationId: ConversationId;
  messages: MediaInboundMessage[];
  /** Reset on every album message so the group is submitted after a quiet window. */
  timer?: Timer;
}

export interface MediaRelayDeps {
  config: AppConfig;
  store: RelayStore;
  adapter: Pick<ImAdapter, "sendMessage" | "sendPhoto" | "sendFile" | "downloadFile">;
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
    const scope = parseChatScopeKey(String(message.conversationId));
    this.deps.logger.info("router.media_received", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      message_id: message.id,
      caption_len: message.caption?.length ?? 0,
      photo_count: message.photos.length,
      media_group_id: message.mediaGroupId,
    });

    if (!isAuthorized(this.deps.config, message.userId, scope.conversationId)) {
      this.deps.logger.warn("router.unauthorized_media", {
        conversation_id: scope.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.deps.sendRendered(scope.scopeKey, textMessage("Unauthorized."));
      return;
    }

    if (message.mediaGroupId) {
      this.bufferMediaGroup({ ...message, conversationId: scope.scopeKey });
      return;
    }

    try {
      await this.submitMediaMessages(scope.scopeKey, [message]);
    } catch (error) {
      await this.handleMediaError(scope.scopeKey, message.id, error);
    }
  }

  async handleFileMessage(message: FileInboundMessage): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    this.deps.logger.info("router.file_received", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      message_id: message.id,
      file_name: message.file.fileName,
      mime_type: message.file.mimeType,
      file_size: message.file.fileSize,
      caption_len: message.caption?.length ?? 0,
    });

    if (!isAuthorized(this.deps.config, message.userId, scope.conversationId)) {
      this.deps.logger.warn("router.unauthorized_file", {
        conversation_id: scope.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.deps.sendRendered(scope.scopeKey, textMessage("Unauthorized."));
      return;
    }

    try {
      await this.submitFileMessage({ ...message, conversationId: scope.scopeKey });
    } catch (error) {
      await this.handleFileError(scope.scopeKey, message.id, error);
    }
  }

  private bufferMediaGroup(message: MediaInboundMessage): void {
    const scope = parseChatScopeKey(String(message.conversationId));
    const key = `${scope.scopeKey}:${message.mediaGroupId}`;
    const existing = this.mediaGroups.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const state = existing ?? { conversationId: scope.scopeKey, messages: [] };
    state.messages.push(message);
    // Telegram/Lark album items arrive as separate updates. A short quiet window
    // lets the relay submit them to Codex as one prompt with multiple images.
    state.timer = setTimeout(() => {
      this.mediaGroups.delete(key);
      void this.submitMediaMessages(state.conversationId, state.messages)
        .catch((error) => this.handleMediaError(state.conversationId, message.id, error));
    }, MEDIA_GROUP_QUIET_MS);
    this.mediaGroups.set(key, state);
  }

  private async submitMediaMessages(conversationId: ConversationId, messages: MediaInboundMessage[]): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) {
      await this.deps.renderConsole(scope.scopeKey);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
    if (await this.deps.sendWaitingPromptNotice(scope.scopeKey, status)) return;

    // Preserve provider message order so image references in captions match the
    // order of localImage inputs sent to Codex.
    const sorted = [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
    const prompt = sorted.map((item) => item.caption?.trim()).find(Boolean) ?? DEFAULT_IMAGE_PROMPT;
    const images: AgentImageInput[] = [];
    for (const media of sorted) {
      images.push(await this.downloadAndSavePhoto(workspace, media));
    }
    await this.deps.submitTask(scope.scopeKey, prompt, sorted[0]?.messageId, "auto", { text: prompt, images });
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

  private async submitFileMessage(message: FileInboundMessage): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) {
      await this.deps.renderConsole(scope.scopeKey);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
    if (await this.deps.sendWaitingPromptNotice(scope.scopeKey, status)) return;

    const stored = await this.downloadAndSaveFile(workspace, message);
    const prompt = formatAttachedFilePrompt({
      path: stored.path,
      filename: stored.filename,
      fileSize: stored.fileSize,
      mimeType: stored.mimeType,
      caption: message.caption,
    });
    await this.deps.submitTask(scope.scopeKey, prompt, message.messageId);
  }

  private async downloadAndSaveFile(workspace: WorkspaceRecord, message: FileInboundMessage): Promise<{ path: string; filename: string; fileSize: number; mimeType?: string }> {
    if (message.file.fileSize && message.file.fileSize > this.deps.config.mediaMaxBytes) {
      throw new Error(`File is too large (${formatBytes(message.file.fileSize)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    if (!this.deps.adapter.downloadFile) throw new Error("IM adapter cannot download files.");
    const downloaded = await this.deps.adapter.downloadFile(message.file.fileId, { kind: "file" });
    const size = downloaded.fileSize ?? downloaded.bytes.byteLength;
    if (size > this.deps.config.mediaMaxBytes || downloaded.bytes.byteLength > this.deps.config.mediaMaxBytes) {
      throw new Error(`File is too large (${formatBytes(Math.max(size, downloaded.bytes.byteLength))}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    const filename = safeFilename(downloaded.fileName ?? message.file.fileName ?? (basename(downloaded.filePath ?? "") || "file.bin"));
    const path = await saveRelayFile(workspace.path, "incoming", downloaded.bytes, {
      filename,
      messageId: message.messageId,
    });
    return {
      path,
      filename,
      fileSize: size,
      ...(downloaded.mimeType ?? message.file.mimeType ? { mimeType: downloaded.mimeType ?? message.file.mimeType } : {}),
    };
  }

  private async handleFileError(conversationId: ConversationId, messageId: MessageId, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    this.deps.logger.error("router.file_failed", {
      conversation_id: conversationId,
      message_id: messageId,
      error: error instanceof Error ? error : new Error(detail),
    });
    await this.deps.trySendRendered(
      conversationId,
      formatErrorMessage(detail),
      "router.file_error_notice_failed",
      { message_id: messageId },
    );
    this.deps.appendSystem(conversationId, `Error: ${detail}\n`);
  }

  async sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const workspace = this.deps.currentWorkspace(parsed.scopeKey);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    try {
      // All outbound images are copied under the selected workspace before being
      // sent so the relay enforces one media location and size policy.
      const path = event.path ? await this.copyOutgoingImage(workspace.path, event.path) : event.data ? await saveGeneratedImage(workspace.path, event.data) : undefined;
      if (!path) throw new Error("Codex image output did not include image data.");
      await this.sendStoredImage(parsed.scopeKey, parsed.workspaceName, path, event.caption, this.deps.lastUserMessageId(event.sessionKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("router.agent_image_send_failed", {
        conversation_id: parsed.conversationId,
        session_key: event.sessionKey,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.deps.trySendRendered(
        parsed.scopeKey,
        formatErrorMessage(`Could not send image: ${detail}`),
        "router.agent_image_error_notice_failed",
        { session_key: event.sessionKey },
      );
      this.deps.appendSystem(parsed.scopeKey, `Error: Could not send image: ${detail}\n`);
    }
  }

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey: sessionKeyValue, workspace } = this.resolveCapabilitySession(input, "image");
    await this.validateDebugImagePath(input.path, workspace.path);
    const path = await this.copyOutgoingImage(workspace.path, input.path);
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredImage(parsed.scopeKey, parsed.workspaceName, path, input.caption, this.deps.lastUserMessageId(sessionKeyValue));
    this.deps.logger.info("router.debug_image_sent", {
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      session_key: sessionKeyValue,
      source_path: input.path,
      stored_path: path,
    });
    return { path };
  }

  async sendDebugFile(input: SendFileCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey: sessionKeyValue, workspace } = this.resolveCapabilitySession(input, "file");
    await this.validateDebugFilePath(input.path, workspace.path);
    const path = await this.copyOutgoingFile(workspace.path, input.path);
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredFile(parsed.scopeKey, parsed.workspaceName, path, input.caption, this.deps.lastUserMessageId(sessionKeyValue));
    this.deps.logger.info("router.debug_file_sent", {
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      session_key: sessionKeyValue,
      source_path: input.path,
      stored_path: path,
    });
    return { path };
  }

  private resolveCapabilitySession(input: SendImageCapabilityRequest | SendFileCapabilityRequest, kind: "image" | "file"): { sessionKey: string; workspace: WorkspaceRecord } {
    if (input.sessionKey) {
      const parsed = parseSessionKey(input.sessionKey);
      if (!parsed) throw new Error("sessionKey is invalid");
      const workspace = this.deps.store.getWorkspace(parsed.workspaceName);
      if (!workspace) throw new Error("session workspace was not found");
      const status = this.deps.agent.getStatus(input.sessionKey);
      if (!status?.running) throw new Error("session is not running");
      return { sessionKey: input.sessionKey, workspace };
    }

    // Capability helper calls usually identify a session by cwd. Accept that only
    // when it maps to exactly one running workspace to avoid cross-chat leaks.
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
    if (matches.length === 0) throw new Error(`No running relay session matches this ${kind} request.`);
    throw new Error(`Multiple running relay sessions match this ${kind} request; pass --session-key.`);
  }

  private async validateDebugImagePath(path: string, workspacePath: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error("Image path must be absolute.");
    const resolvedPath = resolve(path);
    // The control API is local-only, but still treats workspace containment as
    // the authorization boundary for agent-produced debug images.
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

  private async validateDebugFilePath(path: string, workspacePath: string): Promise<void> {
    if (!isAbsolute(path)) throw new Error("File path must be absolute.");
    const resolvedPath = resolve(path);
    if (!pathContains(workspacePath, resolvedPath)) throw new Error("File path must stay inside the selected workspace.");
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("File path must be a regular file.");
    if (stat.size > this.deps.config.mediaMaxBytes) {
      throw new Error(`File is too large (${formatBytes(stat.size)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
  }

  private async copyOutgoingImage(workspacePath: string, sourcePath: string): Promise<string> {
    return await saveRelayMedia(workspacePath, "outgoing", await readFile(sourcePath), { extension: extensionFromTelegramPath(sourcePath) });
  }

  private async copyOutgoingFile(workspacePath: string, sourcePath: string): Promise<string> {
    return await saveRelayFile(workspacePath, "outgoing", await readFile(sourcePath), { filename: basename(sourcePath) });
  }

  private async sendStoredImage(conversationId: ConversationId, workspaceName: string, path: string, caption?: string, replyToMessageId?: MessageId): Promise<void> {
    if (!this.deps.adapter.sendPhoto) throw new Error("IM adapter cannot send images.");
    const scope = parseChatScopeKey(String(conversationId));
    const blob = await imageBlobFromPath(path);
    await this.deps.adapter.sendPhoto(scope.conversationId, blob, {
      ...(caption ? { caption: truncateTelegramCaption(caption) } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(scope.topic ? { topic: scope.topic } : {}),
    });
    this.deps.store.appendTranscript({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      workspaceName,
      role: "agent",
      text: `[image: ${path}]\n`,
      createdAt: Date.now(),
    });
  }

  private async sendStoredFile(conversationId: ConversationId, workspaceName: string, path: string, caption?: string, replyToMessageId?: MessageId): Promise<void> {
    if (!this.deps.adapter.sendFile) throw new Error("IM adapter cannot send files.");
    const scope = parseChatScopeKey(String(conversationId));
    const blob = await fileBlobFromPath(path);
    await this.deps.adapter.sendFile(scope.conversationId, blob, {
      filename: basename(path),
      ...(caption ? { caption: truncateTelegramCaption(caption) } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(scope.topic ? { topic: scope.topic } : {}),
    });
    this.deps.store.appendTranscript({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      workspaceName,
      role: "agent",
      text: `[file: ${path}]\n`,
      createdAt: Date.now(),
    });
  }
}

function formatAttachedFilePrompt(input: { path: string; filename: string; fileSize: number; mimeType?: string; caption?: string }): string {
  return [
    "User attached a file for this Codex session.",
    "",
    `Local path: ${input.path}`,
    `Filename: ${input.filename}`,
    `Size: ${formatBytes(input.fileSize)}`,
    input.mimeType ? `MIME type: ${input.mimeType}` : undefined,
    input.caption?.trim() ? `User caption: ${input.caption.trim()}` : undefined,
    "",
    "Use the local path above to inspect or process the file if needed.",
  ].filter((line): line is string => line !== undefined).join("\n");
}
