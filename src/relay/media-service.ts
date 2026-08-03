import { basename } from "node:path";
import { isAuthorized, type AppConfig } from "../runtime/config.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { sessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentImageInput, AgentImageOutputEvent, AgentSessionStatus, AgentTaskInput } from "../ports/agent.ts";
import type { AudioInboundMessage, FileInboundMessage, ImAdapter, MediaInboundMessage, SendMessageOptions } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import type { Logger, LogFields } from "../domain/logger.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { SendFileCapabilityRequest } from "./capabilities/send-file.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import type { WorkspaceRecord } from "./types.ts";
import { CODEX_PROMPT_TTL_MS, MEDIA_GROUP_QUIET_MS } from "./ui/constants.ts";
import { bestPhoto, formatBytes } from "./ui/media-format.ts";
import { formatErrorMessage } from "./ui/messages.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { extensionFromTelegramPath, safeFilename, saveRelayFile, saveRelayMedia } from "./media.ts";
import { OutboundMediaService } from "./media/outbound.ts";

interface MediaGroupState {
  conversationId: ConversationId;
  messages: MediaInboundMessage[];
  /** Reset on every album message so the group is submitted after a quiet window. */
  timer?: Timer;
}

interface PendingImageActionPayload {
  kind: "image";
  images: AgentImageInput[];
  originalMessageId?: MessageId;
}

interface PendingFileActionPayload {
  kind: "file";
  path: string;
  filename: string;
  fileSize: number;
  mimeType?: string;
  originalMessageId?: MessageId;
}

interface PendingAudioActionPayload {
  kind: "audio";
  path: string;
  filename: string;
  fileSize: number;
  mimeType?: string;
  originalMessageId?: MessageId;
}

type PendingMediaActionPayload = PendingImageActionPayload | PendingFileActionPayload | PendingAudioActionPayload;

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
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  trySendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, failureEvent: string, fields?: LogFields): Promise<void>;
  appendSystem(conversationId: ConversationId, text: string): void;
  lastUserMessageId(sessionKey: string): MessageId | undefined;
}

export class MediaRelayService {
  private readonly mediaGroups = new Map<string, MediaGroupState>();
  private readonly outbound: OutboundMediaService;

  constructor(private readonly deps: MediaRelayDeps) {
    this.outbound = new OutboundMediaService(deps);
  }

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

  async handleAudioMessage(message: AudioInboundMessage): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    this.deps.logger.info("router.audio_received", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      message_id: message.id,
      file_name: message.audio.fileName,
      mime_type: message.audio.mimeType,
      file_size: message.audio.fileSize,
      duration_seconds: message.durationSeconds,
      caption_len: message.caption?.length ?? 0,
    });
    if (!isAuthorized(this.deps.config, message.userId, scope.conversationId)) {
      await this.deps.sendRendered(scope.scopeKey, textMessage("Unauthorized."));
      return;
    }
    try {
      await this.submitAudioMessage({ ...message, conversationId: scope.scopeKey });
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

    // Preserve provider message order so image references in captions match the
    // order of localImage inputs sent to Codex.
    const sorted = [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
    const rawPrompt = sorted.map((item) => item.caption?.trim()).find(Boolean);
    const planMatch = rawPrompt ? /^\/plan(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(rawPrompt) : undefined;
    const prompt = planMatch ? planMatch[1]?.trim() || "Create a plan based on the attached image(s)." : rawPrompt;
    if (prompt) {
      const status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
      if (await this.deps.sendWaitingPromptNotice(scope.scopeKey, status)) return;
    }
    const images: AgentImageInput[] = [];
    for (const media of sorted) {
      images.push(await this.downloadAndSavePhoto(workspace, media));
    }
    if (!prompt) {
      await this.promptForMediaAction(scope.scopeKey, {
        kind: "image",
        images,
        ...(sorted[0]?.messageId ? { originalMessageId: sorted[0].messageId } : {}),
      });
      return;
    }
    if (planMatch) this.deps.store.setCollaborationMode(sessionKey(scope.scopeKey, workspace.name), "plan");
    await this.deps.submitTask(scope.scopeKey, prompt, sorted[0]?.messageId, "auto", {
      text: prompt,
      attachments: images.map((image) => ({ type: "localImage", path: image.path, ...(image.caption ? { caption: image.caption } : {}) })),
    });
  }

  private async downloadAndSavePhoto(workspace: WorkspaceRecord, message: MediaInboundMessage): Promise<AgentImageInput> {
    const photo = bestPhoto(message.photos);
    if (!photo) throw new Error("IM photo is missing.");
    if (photo.fileSize && photo.fileSize > this.deps.config.mediaMaxBytes) {
      throw new Error(`Image is too large (${formatBytes(photo.fileSize)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    if (!this.deps.adapter.downloadFile) throw new Error("IM adapter cannot download media.");
    const downloaded = await this.deps.adapter.downloadFile(photo.fileId, { messageId: message.messageId });
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

    const caption = message.caption?.trim();
    if (caption) {
      const status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
      if (await this.deps.sendWaitingPromptNotice(scope.scopeKey, status)) return;
    }
    const stored = await this.downloadAndSaveFile(workspace, message);
    if (!caption) {
      await this.promptForMediaAction(scope.scopeKey, {
        kind: "file",
        path: stored.path,
        filename: stored.filename,
        fileSize: stored.fileSize,
        ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
        originalMessageId: message.messageId,
      });
      return;
    }
    await this.deps.submitTask(scope.scopeKey, caption, message.messageId, "auto", {
      text: caption,
      attachments: [{ type: "mention", name: stored.filename, path: stored.path }],
    });
  }

  private async submitAudioMessage(message: AudioInboundMessage): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) {
      await this.deps.renderConsole(scope.scopeKey);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const caption = message.caption?.trim();
    if (caption) {
      const status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
      if (await this.deps.sendWaitingPromptNotice(scope.scopeKey, status)) return;
    }
    const stored = await this.downloadAndSaveAudio(workspace, message);
    if (!caption) {
      await this.promptForMediaAction(scope.scopeKey, {
        kind: "audio",
        path: stored.path,
        filename: stored.filename,
        fileSize: stored.fileSize,
        ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
        originalMessageId: message.messageId,
      });
      return;
    }
    await this.deps.submitTask(scope.scopeKey, caption, message.messageId, "auto", {
      text: caption,
      attachments: [{ type: "localAudio", path: stored.path, ...(stored.mimeType ? { mimeType: stored.mimeType } : {}) }],
    });
  }

  private async downloadAndSaveFile(workspace: WorkspaceRecord, message: FileInboundMessage): Promise<{ path: string; filename: string; fileSize: number; mimeType?: string }> {
    if (message.file.fileSize && message.file.fileSize > this.deps.config.mediaMaxBytes) {
      throw new Error(`File is too large (${formatBytes(message.file.fileSize)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    if (!this.deps.adapter.downloadFile) throw new Error("IM adapter cannot download files.");
    const downloaded = await this.deps.adapter.downloadFile(message.file.fileId, { kind: "file", messageId: message.messageId });
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

  private async downloadAndSaveAudio(workspace: WorkspaceRecord, message: AudioInboundMessage): Promise<{ path: string; filename: string; fileSize: number; mimeType?: string }> {
    if (message.audio.fileSize && message.audio.fileSize > this.deps.config.mediaMaxBytes) {
      throw new Error(`Audio is too large (${formatBytes(message.audio.fileSize)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    if (!this.deps.adapter.downloadFile) throw new Error("IM adapter cannot download audio.");
    const downloaded = await this.deps.adapter.downloadFile(message.audio.fileId, { kind: "file", messageId: message.messageId });
    const size = downloaded.fileSize ?? downloaded.bytes.byteLength;
    if (size > this.deps.config.mediaMaxBytes || downloaded.bytes.byteLength > this.deps.config.mediaMaxBytes) {
      throw new Error(`Audio is too large (${formatBytes(Math.max(size, downloaded.bytes.byteLength))}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
    }
    const filename = safeFilename(downloaded.fileName ?? message.audio.fileName ?? (basename(downloaded.filePath ?? "") || "audio.bin"));
    const path = await saveRelayFile(workspace.path, "incoming", downloaded.bytes, { filename, messageId: message.messageId });
    const mimeType = downloaded.mimeType ?? message.audio.mimeType;
    return { path, filename, fileSize: size, ...(mimeType ? { mimeType } : {}) };
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

  async answerMediaActionPrompt(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    const pending = this.deps.store.getPendingPrompt(scope.scopeKey, promptMessageId);
    const payload = parseMediaActionPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "media_action" || !payload || isPromptExpired(pending)) {
      this.deps.store.deletePendingPrompt(scope.scopeKey, promptMessageId);
      await this.deps.sendRendered(scope.scopeKey, messageWithTitle("Attachment prompt expired.", "Resend the image or file with a description."));
      return;
    }
    this.deps.store.deletePendingPrompt(scope.scopeKey, promptMessageId);
    const prompt = text.trim();
    if (!prompt) {
      await this.deps.sendRendered(scope.scopeKey, messageWithTitle("Attachment not submitted.", "Reply to the attachment prompt with what you want Codex to do."));
      return;
    }
    if (payload.kind === "image") {
      await this.deps.submitTask(scope.scopeKey, prompt, payload.originalMessageId ?? promptMessageId, "auto", {
        text: prompt,
        attachments: payload.images.map((image) => ({ type: "localImage", path: image.path, ...(image.caption ? { caption: image.caption } : {}) })),
      });
      return;
    }
    await this.deps.submitTask(scope.scopeKey, prompt, payload.originalMessageId ?? promptMessageId, "auto", {
      text: prompt,
      attachments: payload.kind === "audio"
        ? [{ type: "localAudio", path: payload.path, ...(payload.mimeType ? { mimeType: payload.mimeType } : {}) }]
        : [{ type: "mention", name: payload.filename, path: payload.path }],
    });
  }

  async sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> {
    await this.outbound.sendAgentImageOutput(event);
  }

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    return await this.outbound.sendDebugImage(input);
  }

  async sendDebugFile(input: SendFileCapabilityRequest): Promise<{ path: string }> {
    return await this.outbound.sendDebugFile(input);
  }

  private async promptForMediaAction(conversationId: ConversationId, payload: PendingMediaActionPayload): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    const title = payload.kind === "image"
      ? `Received ${payload.images.length === 1 ? "an image" : `${payload.images.length} images`}.`
      : payload.kind === "audio"
        ? `Received audio: ${payload.filename}`
        : `Received file: ${payload.filename}`;
    const result = await this.deps.sendRendered(scope.scopeKey, messageWithTitle(title), {
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt, or send your next message with what you want Codex to do.",
      disableWebPagePreview: true,
      inputFieldPlaceholder: "What should Codex do?",
    });
    if (!result.messageId) throw new Error("IM adapter did not return an attachment prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      promptMessageId: result.messageId,
      kind: "media_action",
      createdAt: Date.now(),
      payloadJson: JSON.stringify(payload),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }
}

function parseMediaActionPayload(payloadJson: string | undefined): PendingMediaActionPayload | undefined {
  if (!payloadJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.kind === "image") {
    const images = Array.isArray(record.images)
      ? record.images
        .filter((image): image is Record<string, unknown> => Boolean(image) && typeof image === "object")
        .map((image) => ({
          path: typeof image.path === "string" ? image.path : "",
          ...(typeof image.caption === "string" && image.caption ? { caption: image.caption } : {}),
        }))
        .filter((image): image is AgentImageInput => image.path.length > 0)
      : [];
    if (images.length === 0) return undefined;
    return {
      kind: "image",
      images,
      ...(isMessageId(record.originalMessageId) ? { originalMessageId: record.originalMessageId } : {}),
    };
  }
  if (record.kind === "file" || record.kind === "audio") {
    if (typeof record.path !== "string" || typeof record.filename !== "string" || typeof record.fileSize !== "number") return undefined;
    return {
      kind: record.kind,
      path: record.path,
      filename: record.filename,
      fileSize: record.fileSize,
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
      ...(isMessageId(record.originalMessageId) ? { originalMessageId: record.originalMessageId } : {}),
    };
  }
  return undefined;
}

function isPromptExpired(prompt: { expiresAt?: number }): boolean {
  return typeof prompt.expiresAt === "number" && prompt.expiresAt < Date.now();
}

function isMessageId(value: unknown): value is MessageId {
  return typeof value === "string" || typeof value === "number";
}
