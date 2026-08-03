import { lstat, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { Logger, LogFields } from "../../domain/logger.ts";
import { parseSessionKey } from "../../domain/session.ts";
import { parseChatScopeKey } from "../../domain/scope.ts";
import type { AgentDriver, AgentImageOutputEvent } from "../../ports/agent.ts";
import type { ImAdapter } from "../../ports/im.ts";
import type { AppConfig } from "../../runtime/config.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { SendFileCapabilityRequest } from "../capabilities/send-file.ts";
import type { SendImageCapabilityRequest } from "../capabilities/send-image.ts";
import type { WorkspaceRecord } from "../types.ts";
import { formatErrorMessage } from "../ui/messages.ts";
import { formatBytes, pathContains, truncateTelegramCaption } from "../ui/media-format.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import {
  extensionFromTelegramPath,
  fileBlobFromPath,
  imageBlobFromPath,
  saveGeneratedImage,
  saveRelayFile,
  saveRelayMedia,
} from "../media.ts";

export interface OutboundMediaDeps {
  config: Pick<AppConfig, "mediaMaxBytes">;
  store: Pick<RelayStore, "getWorkspace" | "listRunningSessions" | "appendTranscript">;
  adapter: Pick<ImAdapter, "sendPhoto" | "sendFile">;
  agent: Pick<AgentDriver, "getStatus">;
  logger: Logger;
  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined;
  trySendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, failureEvent: string, fields?: LogFields): Promise<void>;
  appendSystem(conversationId: ConversationId, text: string): void;
  lastUserMessageId(sessionKey: string): MessageId | undefined;
}

export class OutboundMediaService {
  constructor(private readonly deps: OutboundMediaDeps) {}

  async sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const workspace = this.deps.currentWorkspace(parsed.scopeKey);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    try {
      const path = event.path ? await this.copyImage(workspace.path, event.path) : event.data ? await saveGeneratedImage(workspace.path, event.data) : undefined;
      if (!path) throw new Error("Codex image output did not include image data.");
      await this.sendStoredImage(parsed.scopeKey, parsed.workspaceName, path, event.caption, this.deps.lastUserMessageId(event.sessionKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("router.agent_image_send_failed", {
        conversation_id: parsed.conversationId,
        session_key: event.sessionKey,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.deps.trySendRendered(parsed.scopeKey, formatErrorMessage(`Could not send image: ${detail}`), "router.agent_image_error_notice_failed", { session_key: event.sessionKey });
      this.deps.appendSystem(parsed.scopeKey, `Error: Could not send image: ${detail}\n`);
    }
  }

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey, workspace } = this.resolveSession(input, "image");
    const sourcePath = this.resolvePath(input, workspace.path);
    await this.validateImagePath(sourcePath, workspace.path);
    const path = await this.copyImage(workspace.path, sourcePath);
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredImage(parsed.scopeKey, parsed.workspaceName, path, input.caption, this.deps.lastUserMessageId(sessionKey));
    this.deps.logger.info("router.debug_image_sent", {
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      session_key: sessionKey,
      source_path: input.path,
      resolved_source_path: sourcePath,
      stored_path: path,
    });
    return { path };
  }

  async sendDebugFile(input: SendFileCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey, workspace } = this.resolveSession(input, "file");
    const sourcePath = this.resolvePath(input, workspace.path);
    await this.validateFilePath(sourcePath, workspace.path);
    const path = await this.copyFile(workspace.path, sourcePath);
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredFile(parsed.scopeKey, parsed.workspaceName, path, input.caption, this.deps.lastUserMessageId(sessionKey));
    this.deps.logger.info("router.debug_file_sent", {
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      session_key: sessionKey,
      source_path: input.path,
      resolved_source_path: sourcePath,
      stored_path: path,
    });
    return { path };
  }

  private resolveSession(input: SendImageCapabilityRequest | SendFileCapabilityRequest, kind: "image" | "file"): { sessionKey: string; workspace: WorkspaceRecord } {
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
    const matches = this.deps.store.listRunningSessions().flatMap((session) => {
      const workspace = this.deps.store.getWorkspace(session.workspace_name);
      const key = session.session_key;
      const status = this.deps.agent.getStatus(key);
      if (!workspace || !status?.running || (cwd && !pathContains(workspace.path, cwd))) return [];
      return [{ sessionKey: key, workspace }];
    });
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No running relay session matches this ${kind} request.`);
    throw new Error(`Multiple running relay sessions match this ${kind} request; pass --session-key.`);
  }

  private resolvePath(input: Pick<SendImageCapabilityRequest | SendFileCapabilityRequest, "path" | "cwd">, workspacePath: string): string {
    return resolve(input.cwd ?? workspacePath, input.path);
  }

  private async validateImagePath(resolvedPath: string, workspacePath: string): Promise<void> {
    if (!pathContains(workspacePath, resolvedPath)) throw new Error("Image path must stay inside the selected workspace.");
    const extension = extname(resolvedPath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) throw new Error("Image must be a PNG, JPG, WEBP, or GIF file.");
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Image path must be a regular file.");
    if (stat.size > this.deps.config.mediaMaxBytes) throw new Error(`Image is too large (${formatBytes(stat.size)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
  }

  private async validateFilePath(resolvedPath: string, workspacePath: string): Promise<void> {
    if (!pathContains(workspacePath, resolvedPath)) throw new Error("File path must stay inside the selected workspace.");
    const stat = await lstat(resolvedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("File path must be a regular file.");
    if (stat.size > this.deps.config.mediaMaxBytes) throw new Error(`File is too large (${formatBytes(stat.size)}). Limit: ${formatBytes(this.deps.config.mediaMaxBytes)}.`);
  }

  private async copyImage(workspacePath: string, sourcePath: string): Promise<string> {
    return await saveRelayMedia(workspacePath, "outgoing", await readFile(sourcePath), { extension: extensionFromTelegramPath(sourcePath) });
  }

  private async copyFile(workspacePath: string, sourcePath: string): Promise<string> {
    return await saveRelayFile(workspacePath, "outgoing", await readFile(sourcePath), { filename: basename(sourcePath) });
  }

  private async sendStoredImage(conversationId: ConversationId, workspaceName: string, path: string, caption?: string, replyToMessageId?: MessageId): Promise<void> {
    if (!this.deps.adapter.sendPhoto) throw new Error("IM adapter cannot send images.");
    const scope = parseChatScopeKey(String(conversationId));
    await this.deps.adapter.sendPhoto(scope.conversationId, await imageBlobFromPath(path), {
      ...(caption ? { caption: truncateTelegramCaption(caption) } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(scope.topic ? { topic: scope.topic } : {}),
    });
    this.deps.store.appendTranscript({ conversationId: scope.conversationId, scopeKey: scope.scopeKey, workspaceName, role: "agent", text: `[image: ${path}]\n`, createdAt: Date.now() });
  }

  private async sendStoredFile(conversationId: ConversationId, workspaceName: string, path: string, caption?: string, replyToMessageId?: MessageId): Promise<void> {
    if (!this.deps.adapter.sendFile) throw new Error("IM adapter cannot send files.");
    const scope = parseChatScopeKey(String(conversationId));
    await this.deps.adapter.sendFile(scope.conversationId, await fileBlobFromPath(path), {
      filename: basename(path),
      ...(caption ? { caption: truncateTelegramCaption(caption) } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(scope.topic ? { topic: scope.topic } : {}),
    });
    this.deps.store.appendTranscript({ conversationId: scope.conversationId, scopeKey: scope.scopeKey, workspaceName, role: "agent", text: `[file: ${path}]\n`, createdAt: Date.now() });
  }
}
