import { existsSync } from "node:fs";
import { lstat, readFile, rm } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { isAuthorized } from "../runtime/config.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import { extensionFromTelegramPath, imageBlobFromPath, saveGeneratedImage, saveRelayMedia } from "./media.ts";
import type {
  AgentImageInput,
  AgentImageOutputEvent,
  AgentTaskInput,
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentBuiltinCommand,
  AgentCollaborationMode,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
} from "../ports/agent.ts";
import type {
  EditMessageTextOptions,
  InboundMessage,
  InlineKeyboardMarkup,
  MediaInboundMessage,
  SendMessageOptions,
} from "../ports/im.ts";
import type {
  HomeStatusMode,
  PendingPrompt,
  WorkspaceRecord,
} from "./types.ts";
import { createWorkspace, discoverWorkspaceDirectories, isRealDirectory, resolveWorkspacePath, validateWorkspaceName, workspaceDirectoryExists } from "../domain/workspace.ts";
import { renderTelegramText, type RenderedTelegramText } from "../presentation/telegram/text.ts";
import { noopLogger, type Logger, type LogFields } from "../domain/logger.ts";
import { CODEX_PROMPT_TTL_MS, DEFAULT_IMAGE_PROMPT, LIST_PAGE_SIZE, MEDIA_GROUP_QUIET_MS, UI_BUTTON } from "./ui/constants.ts";
import { codexRequestKey, shortToken, workspaceCallbackToken } from "./ui/callback-data.ts";
import { commandArgs, parseReviewTarget } from "./ui/commands.ts";
import { approvalKeyboard, codexQuestionConfirmKeyboard, codexQuestionKeyboard, consoleKeyboard, deleteWorkspaceConfirmKeyboard, planReadyKeyboard, resumeKeyboard, workspaceIntroKeyboard, workspacesKeyboard } from "./ui/keyboards.ts";
import { bestPhoto, formatBytes, pathContains, truncateTelegramCaption } from "./ui/media-format.ts";
import { answeredMessage, confirmMessage, formatApprovalDecisionMessage, formatApprovalMessage, formatCodexAnswerNotePrompt, formatCodexQuestion, formatCodexSelectedAnswer, formatErrorMessage, formatResumeMessage, formatWorkspacesMessage } from "./ui/messages.ts";
import { paginateWorkspaces } from "./ui/pagination.ts";
import { approvalResponse, asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import { formatHomeMessage, statusViewFromParts } from "./ui/status-message.ts";
import { bold, code, ensureRendered, messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { StatusView } from "./ui/status-view.ts";
import { type MediaGroupState, type RelayControllerDeps } from "./controller-types.ts";
import { SlashCommandRouter } from "./command-router.ts";
import { CallbackRouter, isConsoleCallbackPayload } from "./callback-router.ts";
import { OutputStreamer } from "./output-streamer.ts";
import { TaskCoordinator, type TaskSubmitPreference } from "./task-coordinator.ts";

const WORKSPACE_INTRO_FILES = ["README.md", "README", "README.markdown", "README.txt"];
const WORKSPACE_INTRO_MAX_CHARS = 2400;

export class RelayController {
  private readonly logger: Logger;
  private readonly slashCommands: SlashCommandRouter;
  private readonly callbacks: CallbackRouter;
  private readonly outputStreamer: OutputStreamer;
  private readonly taskCoordinator: TaskCoordinator;

  constructor(private readonly deps: RelayControllerDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.outputStreamer = new OutputStreamer({
      store: deps.store,
      logger: this.logger,
      getReplyToMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
    });
    this.taskCoordinator = new TaskCoordinator({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: this.logger,
      currentWorkspace: (conversationId) => this.currentWorkspace(conversationId),
      renderConsole: (conversationId) => this.renderConsole(conversationId),
      ensureAgentStarted: (conversationId, workspace, threadId) => this.ensureAgentStarted(conversationId, workspace, threadId),
      finalizeSessionOutput: (sessionKeyValue) => this.finalizeSessionOutput(sessionKeyValue),
      setReplyToMessageId: (sessionKeyValue, messageId) => this.lastUserMessageIds.set(sessionKeyValue, messageId),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
    });
    this.slashCommands = new SlashCommandRouter({
      review: (conversationId, text) => this.runReviewCommand(conversationId, text),
      compact: (conversationId) => this.runBuiltinCommand(conversationId, { type: "compact" }),
      init: (conversationId, userMessageId) => this.runInitCommand(conversationId, userMessageId),
      newThread: (conversationId) => this.startFreshThread(conversationId),
      resume: (conversationId, searchTerm) => this.renderResumePicker(conversationId, searchTerm),
      fork: (conversationId) => this.forkCurrentThread(conversationId),
      rename: (conversationId, name) => this.renameCommand(conversationId, name),
      plan: (conversationId, prompt, userMessageId) => this.planCommand(conversationId, prompt, userMessageId),
      stop: (conversationId) => this.cleanBackgroundTerminals(conversationId),
    });
    this.callbacks = new CallbackRouter({
      isStaleConsoleCallback: (message, payload) => this.isStaleConsoleCallback(message, payload),
      renderStaleConsole: (message) => this.renderCallbackPage(message, messageWithTitle("Stale Relay Home.", "Open the latest Relay Home."), { inline_keyboard: [[{ text: UI_BUTTON.refresh, callback_data: "ar:home" }]] }),
      home: (message) => this.renderConsole(message.conversationId),
      status: (message) => this.renderHomeCallback(message),
      workspaces: (message, pageIndex) => this.renderWorkspacesCallback(message, pageIndex),
      newWorkspace: (message) => this.promptForWorkspaceName(message.conversationId),
      toggleStatusMode: (message) => this.toggleStatusModeCallback(message),
      approval: (message, payload) => this.answerCodexApproval(message, payload),
      codexQuestion: (message, payload) => this.answerCodexOptionCallback(message, payload),
      pagedOutput: (message, payload) => this.renderPagedOutputCallback(message, payload),
      command: (message, payload) => this.handleCommandCallback(message, payload),
      stop: (message) => this.stopFromCallback(message),
      workspaceIntro: (message, token, pageIndex) => this.renderWorkspaceIntroCallback(message, token, pageIndex),
      confirmDeleteWorkspace: (message, token) => this.confirmDeleteWorkspaceCallback(message, token),
      deleteWorkspace: (message, token) => this.deleteWorkspaceCallback(message, token),
      selectWorkspace: (message, token) => this.selectWorkspaceFromToken(message, token),
    });
  }

  async handle(message: InboundMessage): Promise<void> {
    if (message.kind === "callback_query") {
      await this.handleCallback(message);
      return;
    }
    if (message.kind === "media") {
      await this.handleMediaMessage(message);
      return;
    }

    const text = message.text.trim();
    const command = this.slashCommands.command(text);
    this.logger.info("router.message_received", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      message_id: message.id,
      text_len: message.text.length,
      command,
    });
    this.logger.debug("router.message_text", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      message_id: message.id,
      message_text: message.text,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.conversationId)) {
      this.logger.warn("router.unauthorized_message", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.sendRendered(message.conversationId, textMessage("Unauthorized."));
      return;
    }

    try {
      const pending = message.replyToMessageId
        ? this.deps.store.getPendingPrompt(message.conversationId, message.replyToMessageId)
        : undefined;
      if (pending?.kind === "workspace_name") {
        await this.createWorkspaceFromPrompt(message.conversationId, message.replyToMessageId!, text);
      } else if (pending?.kind === "codex_user_input") {
        await this.answerCodexFreeText(message.conversationId, message.replyToMessageId!, text);
      } else if (pending?.kind === "relay_command") {
        await this.answerRelayCommandPrompt(message.conversationId, message.replyToMessageId!, text);
      } else if (command === "/relay") {
        await this.renderConsole(message.conversationId, { forceNewMessage: true });
      } else if (command && await this.slashCommands.handle(message, command, text)) {
        return;
      } else {
        await this.submitTask(message.conversationId, text, message.messageId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("router.message_failed", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        message_id: message.id,
        command,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.trySendRendered(
        message.conversationId,
        formatErrorMessage(detail),
        "router.message_error_notice_failed",
        { message_id: message.id },
      );
      this.appendSystem(message.conversationId, `Error: ${detail}\n`);
    }
  }

  async handleAgentOutput(session: AgentOutputEvent): Promise<void> {
    if (session.type === "image") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.sendAgentImageOutput(session);
      return;
    }
    if (session.type === "turn_completed") {
      this.logger.info("router.turn_completed", {
        session_key: session.sessionKey,
        turn_id: session.turnId,
      });
      await this.finalizeSessionOutput(session.sessionKey);
      await this.sendPlanReadyPrompt(session.sessionKey, session.turnId);
      await this.completeTaskAndDispatchNext(session.sessionKey, session.turnId);
      return;
    }
    if (session.type === "user_input_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked", session.turnId);
      await this.handleCodexUserInputRequest(session);
      return;
    }
    if (session.type === "approval_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked", session.turnId);
      await this.handleCodexApprovalRequest(session);
      return;
    }
    const parsed = parseSessionKey(session.sessionKey);
    if (!parsed) {
      this.logger.warn("router.agent_output_invalid_session", { session_key: session.sessionKey, chunk_len: session.chunk.length });
      return;
    }
    this.logger.debug("router.agent_output_received", {
      session_key: session.sessionKey,
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
      chunk_len: session.chunk.length,
      agent_chunk: session.chunk,
    });
    this.deps.store.appendTranscript({
      conversationId: parsed.conversationId,
      workspaceName: parsed.workspaceName,
      role: "agent",
      text: session.chunk,
      createdAt: Date.now(),
    });
    await this.bufferAgentOutput(session.sessionKey, parsed.conversationId, session.chunk, session.turnId);
  }

  async handleAgentExit(sessionKeyValue: string, exitText: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) {
      this.logger.warn("router.agent_exit_invalid_session", { session_key: sessionKeyValue });
      return;
    }
    this.logger.info("router.agent_exit", {
      session_key: sessionKeyValue,
      conversation_id: parsed.conversationId,
      workspace: parsed.workspaceName,
    });
    this.deps.store.markSessionStopped(sessionKeyValue);
    await this.finalizeSessionOutput(sessionKeyValue);
    await this.failActiveTasks(sessionKeyValue);
    await this.sendRendered(parsed.conversationId, messageWithTitle(exitText));
  }

  private async handleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    this.logger.info("router.callback_received", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      callback_query_id: message.callbackQueryId,
      data: message.data,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.conversationId)) {
      this.logger.warn("router.unauthorized_callback", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        callback_query_id: message.callbackQueryId,
      });
      await this.answerCallback(message.callbackQueryId, "Unauthorized.");
      return;
    }

    try {
      const callbackText = await this.routeCallback(message);
      await this.answerCallback(message.callbackQueryId, callbackText);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("router.callback_failed", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        callback_query_id: message.callbackQueryId,
        data: message.data,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.answerCallback(message.callbackQueryId, detail.slice(0, 180));
      await this.tryRenderCallbackPage(
        message,
        formatErrorMessage(detail),
        this.consoleKeyboard(message.conversationId),
        "router.callback_error_notice_failed",
      );
      this.appendSystem(message.conversationId, `Error: ${detail}\n`);
    }
  }

  private async handleMediaMessage(message: MediaInboundMessage): Promise<void> {
    this.logger.info("router.media_received", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      message_id: message.id,
      caption_len: message.caption?.length ?? 0,
      photo_count: message.photos.length,
      media_group_id: message.mediaGroupId,
    });

    if (!isAuthorized(this.deps.config, message.userId, message.conversationId)) {
      this.logger.warn("router.unauthorized_media", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.sendRendered(message.conversationId, textMessage("Unauthorized."));
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
    const workspace = this.currentWorkspace(conversationId);
    if (!workspace) {
      await this.renderConsole(conversationId);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.ensureAgentStarted(conversationId, workspace);
    if (await this.sendWaitingPromptNotice(conversationId, status)) return;

    const sorted = [...messages].sort((a, b) => Number(a.messageId) - Number(b.messageId));
    const prompt = sorted.map((item) => item.caption?.trim()).find(Boolean) ?? DEFAULT_IMAGE_PROMPT;
    const images: AgentImageInput[] = [];
    for (const media of sorted) {
      images.push(await this.downloadAndSavePhoto(workspace, media));
    }
    await this.submitTask(conversationId, prompt, sorted[0]?.messageId, "auto", { text: prompt, images });
  }

  private async downloadAndSavePhoto(workspace: WorkspaceRecord, message: MediaInboundMessage): Promise<AgentImageInput> {
    const photo = bestPhoto(message.photos);
    if (!photo) throw new Error("Telegram photo is missing.");
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
    this.logger.error("router.media_failed", {
      conversation_id: conversationId,
      message_id: messageId,
      error: error instanceof Error ? error : new Error(detail),
    });
    await this.trySendRendered(
      conversationId,
      formatErrorMessage(detail),
      "router.media_error_notice_failed",
      { message_id: messageId },
    );
    this.appendSystem(conversationId, `Error: ${detail}\n`);
  }

  private async sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const workspace = this.currentWorkspace(parsed.conversationId);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    try {
      const path = event.path ? await this.copyOutgoingImage(workspace.path, event.path) : event.data ? await saveGeneratedImage(workspace.path, event.data) : undefined;
      if (!path) throw new Error("Codex image output did not include image data.");
      await this.sendStoredImage(parsed.conversationId, parsed.workspaceName, path, event.caption, this.lastUserMessageIds.get(event.sessionKey));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("router.agent_image_send_failed", {
        conversation_id: parsed.conversationId,
        session_key: event.sessionKey,
        error: error instanceof Error ? error : new Error(detail),
      });
      await this.trySendRendered(
        parsed.conversationId,
        formatErrorMessage(`Could not send image: ${detail}`),
        "router.agent_image_error_notice_failed",
        { session_key: event.sessionKey },
      );
      this.appendSystem(parsed.conversationId, `Error: Could not send image: ${detail}\n`);
    }
  }

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    const { sessionKey: sessionKeyValue, workspace } = this.resolveDebugImageSession(input);
    await this.validateDebugImagePath(input.path, workspace.path);
    const path = await this.copyOutgoingImage(workspace.path, input.path);
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) throw new Error("Invalid session key.");
    await this.sendStoredImage(parsed.conversationId, parsed.workspaceName, path, input.caption, this.lastUserMessageIds.get(sessionKeyValue));
    this.logger.info("router.debug_image_sent", {
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

  private async routeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<string | undefined> {
    return await this.callbacks.route(message);
  }

  private async runReviewCommand(conversationId: ConversationId, text: string): Promise<void> {
    const target = parseReviewTarget(commandArgs(text));
    await this.runBuiltinCommand(conversationId, { type: "review", target });
  }

  private async runBuiltinCommand(conversationId: ConversationId, command: AgentBuiltinCommand): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver does not support this command.");
    const result = await this.deps.agent.runBuiltinCommand(key, command);
    if (result.threadId && result.threadId !== status.threadId) this.deps.store.setSessionThreadId(key, result.threadId);
    this.logger.info("router.builtin_command_started", { conversation_id: conversationId, workspace: workspace.name, command: command.type });
    await this.sendRendered(conversationId, messageWithTitle(result.message));
  }

  private async runInitCommand(conversationId: ConversationId, userMessageId?: MessageId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(conversationId);
    if (existsSync(join(workspace.path, "AGENTS.md"))) {
      await this.sendRendered(conversationId, messageWithTitle("AGENTS.md already exists.", "Skipping /init to avoid overwriting it."));
      return;
    }
    await this.submitTask(conversationId, "Generate a file named AGENTS.md that serves as a contributor guide for this repository.", userMessageId, "immediate");
  }

  private async startFreshThread(conversationId: ConversationId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    const status = await this.ensureAgentStarted(conversationId, workspace);
    this.deps.store.setCollaborationMode(key, "default");
    await this.sendRendered(conversationId, messageWithTitle("Started a new chat.", `Thread: ${status.threadName ?? status.threadId ?? "new"}`));
  }

  private async renderResumePicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const workspace = this.requireCurrentWorkspace(conversationId);
    if (!this.deps.agent.listThreads) throw new Error("Agent driver cannot list threads.");
    const threads = await this.deps.agent.listThreads({
      workspacePath: workspace.path,
      limit: LIST_PAGE_SIZE,
      ...(searchTerm ? { searchTerm } : {}),
    });
    if (threads.length === 0) {
      await this.sendRendered(conversationId, messageWithTitle("No saved chats found."));
      return;
    }
    const token = shortToken();
    const result = await this.sendRendered(conversationId, formatResumeMessage(threads), {
      replyMarkup: resumeKeyboard(token, threads),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a resume picker message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "resume", token, threads: threads.map((thread) => ({ id: thread.id, name: thread.name })) }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async forkCurrentThread(conversationId: ConversationId): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.forkThread) throw new Error("Agent driver cannot fork threads.");
    const result = await this.deps.agent.forkThread(key);
    await this.cancelActiveTasks(key);
    this.deps.store.setSessionThreadId(key, result.threadId);
    await this.sendRendered(conversationId, messageWithTitle("Forked chat.", `Thread: ${result.threadName ?? result.threadId}`));
    this.logger.info("router.thread_forked", { conversation_id: conversationId, workspace: workspace.name, thread_id: result.threadId });
  }

  private async renameCommand(conversationId: ConversationId, name: string): Promise<void> {
    if (name.trim()) {
      await this.renameCurrentThread(conversationId, name.trim());
      return;
    }
    const result = await this.sendRendered(conversationId, textMessage("Reply with the new chat name."), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a rename prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      payloadJson: JSON.stringify({ command: "rename" }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async renameCurrentThread(conversationId: ConversationId, name: string): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
    await this.deps.agent.renameThread(key, name);
    await this.sendRendered(conversationId, messageWithTitle("Renamed chat.", name));
  }

  private async planCommand(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    const workspace = this.requireCurrentWorkspace(conversationId);
    const status = await this.ensureAgentStarted(conversationId, workspace);
    if (this.sessionBusy(status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    const key = sessionKey(conversationId, workspace.name);
    const current = this.deps.store.getCollaborationMode(key);
    if (!prompt.trim()) {
      const next: AgentCollaborationMode = current === "plan" ? "default" : "plan";
      this.deps.store.setCollaborationMode(key, next);
      await this.sendRendered(conversationId, messageWithTitle(next === "plan" ? "Plan mode enabled." : "Plan mode disabled."));
      return;
    }
    this.deps.store.setCollaborationMode(key, "plan");
    await this.submitTask(conversationId, prompt.trim(), userMessageId, "immediate");
  }

  private async cleanBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.cleanBackgroundTerminals) throw new Error("Agent driver cannot clean background terminals.");
    await this.deps.agent.cleanBackgroundTerminals(key);
    this.logger.info("router.background_terminals_cleaned", { conversation_id: conversationId, session_key: key });
    await this.sendRendered(conversationId, messageWithTitle("Background terminals stopped."));
  }

  private async commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }> {
    const workspace = this.requireCurrentWorkspace(conversationId);
    const status = await this.ensureAgentStarted(conversationId, workspace);
    return { workspace, status, key: sessionKey(conversationId, workspace.name) };
  }

  private sessionBusy(status: AgentSessionStatus): boolean {
    return Boolean(status.activeTurnId || status.waitingForApproval || status.waitingForUserInput);
  }

  private async sendBusyCommandNotice(conversationId: ConversationId): Promise<void> {
    await this.sendRendered(conversationId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
  }

  private async handleCommandCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, command, token, action] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
      return;
    }

    if (command === "resume") {
      await this.resumeFromCallback(message, pending, data, action);
      return;
    }
    if (command === "plan") {
      await this.planFromCallback(message, pending, data, action);
      return;
    }
    throw new Error("Unknown command callback.");
  }

  private async resumeFromCallback(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    rawIndex: string | undefined,
  ): Promise<void> {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) throw new Error("Resume thread is missing.");
    const threads = Array.isArray(data.threads) ? data.threads : [];
    const selected = asPromptRecord(threads[index]);
    const threadId = typeof selected?.id === "string" ? selected.id : undefined;
    if (!threadId) throw new Error("Resume selection expired.");
    const workspace = this.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    const status = await this.ensureAgentStarted(message.conversationId, workspace, threadId);
    this.deps.store.setSessionThreadId(key, status.threadId ?? threadId);
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.renderCallbackPage(message, messageWithTitle("Resumed chat.", status.threadName ?? status.threadId ?? threadId), { inline_keyboard: [] });
  }

  private async planFromCallback(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: PendingPrompt,
    _data: Record<string, unknown>,
    action: string | undefined,
  ): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    if (pending.sessionKey && pending.sessionKey !== key) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      this.logger.info("router.plan_callback_expired", {
        conversation_id: message.conversationId,
        session_key: pending.sessionKey,
        reason: "session_mismatch",
      });
      await this.renderCallbackPage(message, messageWithTitle("Plan action expired.", "Open the latest Plan ready card."), { inline_keyboard: [] });
      return;
    }
    if (action === "implement") {
      const status = this.deps.agent.getStatus(key);
      if (!status?.running) {
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        this.logger.info("router.plan_callback_expired", {
          conversation_id: message.conversationId,
          session_key: key,
          reason: "session_not_running",
        });
        await this.renderCallbackPage(message, messageWithTitle("Plan action expired.", "The Codex session is no longer running."), { inline_keyboard: [] });
        return;
      }
      if (this.sessionBusy(status) || this.hasTaskCreatedAfter(message.conversationId, workspace.name, pending.createdAt)) {
        this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
        this.logger.info("router.plan_callback_busy", {
          conversation_id: message.conversationId,
          session_key: key,
          active_turn_id: status.activeTurnId,
          waiting_for_approval: status.waitingForApproval,
          waiting_for_user_input: status.waitingForUserInput,
        });
        await this.renderCallbackPage(message, messageWithTitle("Plan action expired.", "A newer turn is already active or has been submitted."), { inline_keyboard: [] });
        return;
      }
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      this.deps.store.setCollaborationMode(key, "default");
      this.logger.info("router.plan_callback_implemented", { conversation_id: message.conversationId, session_key: key });
      await this.renderCallbackPage(message, messageWithTitle("Implementing plan."), { inline_keyboard: [] });
      await this.submitTask(message.conversationId, "Implement the approved plan.", message.messageId, "immediate");
      return;
    }
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.renderCallbackPage(message, messageWithTitle("Continuing in Plan mode."), { inline_keyboard: [] });
  }

  private async renderHomeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.conversationId);
    const mode = this.deps.store.getHomeStatusMode(message.conversationId);
    await this.renderCallbackPage(message, formatHomeMessage(status, mode), consoleKeyboard(status, mode));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.conversationId, message.messageId);
  }

  private async toggleStatusModeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const nextMode: HomeStatusMode = this.deps.store.getHomeStatusMode(message.conversationId) === "compact" ? "details" : "compact";
    this.deps.store.setHomeStatusMode(message.conversationId, nextMode);
    const status = this.statusView(message.conversationId);
    await this.renderCallbackPage(message, formatHomeMessage(status, nextMode), consoleKeyboard(status, nextMode));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.conversationId, message.messageId);
  }

  private async renderWorkspacesCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, pageIndex: number): Promise<void> {
    const workspaces = await this.listAvailableWorkspaces();
    const selected = this.currentWorkspace(message.conversationId)?.name;
    const page = paginateWorkspaces(workspaces, selected, pageIndex);
    await this.renderCallbackPage(message, formatWorkspacesMessage(page.items.map((workspace) => ({
      name: workspace.name,
      selected: workspace.name === selected,
    })), page.pageIndex, page.totalPages), workspacesKeyboard(page.items, selected, page.pageIndex, page.totalPages));
  }

  private async renderWorkspaceIntroCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string, pageIndex: number): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    const selected = this.currentWorkspace(message.conversationId)?.name === workspace.name;
    const safePageIndex = Number.isFinite(pageIndex) && pageIndex >= 0 ? Math.floor(pageIndex) : 0;
    const intro = await this.readWorkspaceIntro(workspace);
    await this.renderCallbackPage(message, formatWorkspaceIntroMessage(workspace, intro), workspaceIntroKeyboard(workspace, selected, safePageIndex));
  }

  private async selectWorkspaceFromToken(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    this.deps.store.bindConversation(message.conversationId, workspace.name);
    this.logger.info("router.workspace_selected", { conversation_id: message.conversationId, workspace: workspace.name, path: workspace.path });
    await this.ensureAgentStarted(message.conversationId, workspace);
    const status = this.statusView(message.conversationId);
    const mode = this.deps.store.getHomeStatusMode(message.conversationId);
    await this.renderCallbackPage(message, formatHomeMessage(status, mode), consoleKeyboard(status, mode));
    if (message.messageId) this.deps.store.setConsoleMessageId(message.conversationId, message.messageId);
  }

  private async confirmDeleteWorkspaceCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    await this.renderCallbackPage(
      message,
      confirmMessage("Delete workspace?", `This permanently deletes ${workspace.path}.`),
      deleteWorkspaceConfirmKeyboard(workspace.name),
    );
  }

  private async deleteWorkspaceCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, token: string): Promise<void> {
    const name = await this.workspaceNameForToken(token);
    const workspace = this.requireWorkspace(name);
    const key = sessionKey(message.conversationId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key).catch((error) => {
      this.logger.warn("router.workspace_delete_stop_failed", {
        conversation_id: message.conversationId,
        workspace: workspace.name,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    await this.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    await rm(workspace.path, { recursive: true, force: true });
    this.deps.store.deleteWorkspace(workspace.name);
    this.logger.info("router.workspace_deleted", { conversation_id: message.conversationId, workspace: workspace.name, path: workspace.path });
    await this.renderWorkspacesCallback(message, 0);
  }

  private async stopFromCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const workspace = this.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    await this.finalizeSessionOutput(key);
    await this.deps.agent.stop(key);
    await this.cancelActiveTasks(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearBinding(message.conversationId);
    this.logger.info("router.session_stopped", { conversation_id: message.conversationId, workspace: workspace.name, session_key: key });
    const status = this.statusView(message.conversationId);
    const mode = this.deps.store.getHomeStatusMode(message.conversationId);
    await this.renderCallbackPage(message, formatHomeMessage(status, mode), consoleKeyboard(status, mode));
  }

  private async readWorkspaceIntro(workspace: WorkspaceRecord): Promise<string> {
    for (const fileName of WORKSPACE_INTRO_FILES) {
      try {
        const text = await readFile(join(workspace.path, fileName), "utf8");
        return workspaceIntroExcerpt(text);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        this.logger.warn("router.workspace_intro_read_failed", {
          workspace: workspace.name,
          path: join(workspace.path, fileName),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return "No README found.";
  }

  private async renderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    const rendered = ensureRendered(body);
    if (!message.messageId) {
      await this.sendRendered(message.conversationId, rendered, { replyMarkup });
      return;
    }
    try {
      await this.editRendered(message.conversationId, rendered, {
        messageId: message.messageId,
        replyMarkup,
      });
    } catch (error) {
      this.logger.warn("router.callback_edit_fallback", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.sendRendered(message.conversationId, rendered, { replyMarkup });
    }
  }

  private async tryRenderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
    failureEvent: string,
  ): Promise<void> {
    try {
      await this.renderCallbackPage(message, body, replyMarkup);
    } catch (error) {
      this.logger.warn(failureEvent, {
        conversation_id: message.conversationId,
        callback_query_id: message.callbackQueryId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.deps.adapter.answerCallbackQuery) return;
    try {
      await this.deps.adapter.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      this.logger.warn("router.callback_answer_failed", {
        callback_query_id: callbackQueryId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<SendMessageOptions, "entities" | "parseMode"> = {}): Promise<{ messageId?: MessageId }> {
    return await this.deps.adapter.sendMessage(conversationId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  private async trySendRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    failureEvent: string,
    fields: LogFields = {},
    options: Omit<SendMessageOptions, "entities" | "parseMode"> = {},
  ): Promise<void> {
    try {
      await this.sendRendered(conversationId, rendered, options);
    } catch (error) {
      this.logger.warn(failureEvent, {
        conversation_id: conversationId,
        ...fields,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async editRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options: Omit<EditMessageTextOptions, "entities" | "parseMode">,
  ): Promise<void> {
    if (!this.deps.adapter.editMessageText) throw new Error("IM adapter cannot edit messages.");
    await this.deps.adapter.editMessageText(conversationId, rendered.text, {
      ...options,
      entities: rendered.entities,
      disableWebPagePreview: options.disableWebPagePreview ?? true,
    });
  }

  private consoleKeyboard(conversationId: ConversationId): InlineKeyboardMarkup {
    return consoleKeyboard(this.statusView(conversationId), this.deps.store.getHomeStatusMode(conversationId));
  }

  private async renderConsole(conversationId: ConversationId, options: { forceNewMessage?: boolean } = {}): Promise<void> {
    const status = this.statusView(conversationId);
    this.logger.info("router.console_rendered", {
      conversation_id: conversationId,
      workspace: status.workspaceName,
      running: Boolean(status.running),
    });
    const previousMessageId = options.forceNewMessage ? undefined : this.deps.store.getConsoleMessageId(conversationId);
    const mode = this.deps.store.getHomeStatusMode(conversationId);
    const body = formatHomeMessage(status, mode);
    if (previousMessageId) {
      try {
        await this.editRendered(conversationId, body, {
          messageId: previousMessageId,
          replyMarkup: consoleKeyboard(status, mode),
        });
        return;
      } catch (error) {
        this.logger.warn("router.console_edit_fallback", {
          conversation_id: conversationId,
          message_id: previousMessageId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    const result = await this.sendRendered(conversationId, body, { replyMarkup: consoleKeyboard(status, mode) });
    if (result.messageId) this.deps.store.setConsoleMessageId(conversationId, result.messageId);
  }

  private async promptForWorkspaceName(conversationId: ConversationId): Promise<void> {
    const result = await this.sendRendered(conversationId, textMessage("Reply with the workspace name. Existing directories under WORKSPACE_ROOT are selected; missing names are created."), {
      forceReply: true,
      inputFieldPlaceholder: "repo name under WORKSPACE_ROOT",
      disableWebPagePreview: true,
    });
    if (!result.messageId) {
      throw new Error("Telegram did not return a prompt message id.");
    }
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "workspace_name",
      createdAt: Date.now(),
    });
    this.logger.info("router.workspace_prompt_created", { conversation_id: conversationId, prompt_message_id: result.messageId });
  }

  private async createWorkspaceFromPrompt(conversationId: ConversationId, promptMessageId: MessageId, name: string): Promise<void> {
    await this.selectOrCreateWorkspace(conversationId, name);
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
  }

  private async selectOrCreateWorkspace(conversationId: ConversationId, name: string): Promise<void> {
    validateWorkspaceName(name);
    const existed = workspaceDirectoryExists(this.deps.config.workspaceRoot, name);
    const path = existed
      ? resolveWorkspacePath(this.deps.config.workspaceRoot, name)
      : await createWorkspace(this.deps.config.workspaceRoot, name);
    this.deps.store.upsertWorkspace({ name, path, createdAt: Date.now() });
    this.deps.store.bindConversation(conversationId, name);
    this.logger.info(existed ? "router.workspace_existing_selected" : "router.workspace_created", { conversation_id: conversationId, workspace: name, path });
    await this.ensureAgentStarted(conversationId, { name, path, createdAt: Date.now() });
    await this.sendRendered(conversationId, renderTelegramText([
      "workspace ",
      code(name),
      ` ${existed ? "selected" : "created and selected"}.`,
    ]), {
      replyMarkup: this.consoleKeyboard(conversationId),
    });
  }

  private async submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference: TaskSubmitPreference = "auto", input?: AgentTaskInput): Promise<void> {
    await this.taskCoordinator.submit(conversationId, text, userMessageId, preference, input);
  }

  private async sendWaitingPromptNotice(conversationId: ConversationId, status: AgentSessionStatus): Promise<boolean> {
    return await this.taskCoordinator.sendWaitingPromptNotice(conversationId, status);
  }

  private async ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string): Promise<AgentSessionStatus> {
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const key = sessionKey(conversationId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (existing?.running && !threadId) return existing;

    this.logger.info("router.session_starting", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: threadId });
    const previous = threadId ? undefined : this.deps.store.getSession(key);
    const status = await this.deps.agent.start({
      conversationId,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      threadId: threadId ?? previous?.thread_id ?? undefined,
    });
    this.deps.store.markSessionStarted(key, conversationId, workspace.name, Date.now(), status.threadId);
    this.logger.info("router.session_started", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: status.threadId });
    return status;
  }

  private async markActiveTask(sessionKeyValue: string, status: "blocked" | "running", turnId?: string): Promise<void> {
    await this.taskCoordinator.markActive(sessionKeyValue, status, turnId);
  }

  private async completeTaskAndDispatchNext(sessionKeyValue: string, turnId: string | undefined): Promise<void> {
    await this.taskCoordinator.completeAndDispatchNext(sessionKeyValue, turnId);
  }

  private async cancelActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.cancelActive(sessionKeyValue);
  }

  private async failActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.failActive(sessionKeyValue);
  }

  private async sendPlanReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || this.deps.store.getCollaborationMode(sessionKeyValue) !== "plan") return;
    const token = shortToken();
    const result = await this.sendRendered(parsed.conversationId, messageWithTitle("Plan ready.", "Choose whether to implement it now or keep refining the plan."), {
      replyMarkup: planReadyKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) return;
    this.logger.info("router.plan_ready_prompt_sent", {
      conversation_id: parsed.conversationId,
      session_key: sessionKeyValue,
      turn_id: completedTurnId,
      prompt_message_id: result.messageId,
    });
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify({ command: "plan", token, completedTurnId }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private isStaleConsoleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): boolean {
    if (!message.messageId || !isConsoleCallbackPayload(payload)) return false;
    const latest = this.deps.store.getConsoleMessageId(message.conversationId);
    return Boolean(latest && String(latest) !== String(message.messageId));
  }

  private currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined {
    const binding = this.deps.store.getBinding(conversationId);
    return binding ? this.deps.store.getWorkspace(binding.workspaceName) : undefined;
  }

  private requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord {
    const workspace = this.currentWorkspace(conversationId);
    if (!workspace) throw new Error("No workspace selected. Open Relay Home and choose or create a workspace.");
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    return workspace;
  }

  private requireWorkspace(name: string): WorkspaceRecord {
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

  private async listAvailableWorkspaces(): Promise<WorkspaceRecord[]> {
    const now = Date.now();
    for (const workspace of await discoverWorkspaceDirectories(this.deps.config.workspaceRoot)) {
      this.deps.store.upsertWorkspace({ ...workspace, createdAt: now });
    }
    return this.deps.store.listWorkspaces();
  }

  private async workspaceNameForToken(token: string): Promise<string> {
    const matches = (await this.listAvailableWorkspaces()).filter((workspace) => workspaceCallbackToken(workspace.name) === token);
    if (matches.length === 1) return matches[0]!.name;
    if (matches.length > 1) throw new Error("workspace selection token is ambiguous. Refresh workspaces and try again.");
    throw new Error("workspace selection expired. Refresh workspaces and try again.");
  }

  private appendSystem(conversationId: ConversationId, text: string): void {
    const workspace = this.currentWorkspace(conversationId);
    if (!workspace) return;
    this.deps.store.appendTranscript({ conversationId, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  private statusView(conversationId: ConversationId): StatusView {
    const workspace = this.currentWorkspace(conversationId);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(conversationId, workspace.name));
    const recentOutput = this.deps.store.latestTranscriptEvent(conversationId, workspace.name, "agent");
    const recentError = this.deps.store.latestTranscriptEvent(conversationId, workspace.name, "system");
    return statusViewFromParts(
      workspace,
      status,
      recentOutput?.createdAt,
      recentError?.text,
      this.deps.store.countTasks(conversationId, workspace.name, ["waiting"]),
      this.deps.store.countTasks(conversationId, workspace.name, ["queued"]),
      this.deps.store.countTasks(conversationId, workspace.name, ["blocked"]),
      this.deps.store.activeTask(conversationId, workspace.name),
    );
  }

  private hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean {
    return this.deps.store.listTasks(conversationId, workspaceName, undefined, 1)
      .some((task) => task.createdAt > timestamp);
  }

  private readonly mediaGroups = new Map<string, MediaGroupState>();

  private readonly lastUserMessageIds = new Map<string, MessageId>();

  private readonly codexRequests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    questions: AgentUserInputQuestion[];
    answers: Record<string, { answers: string[] }>;
  }>();

  private async handleCodexUserInputRequest(event: AgentUserInputRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const key = codexRequestKey(event.sessionKey, event.requestId);
    this.codexRequests.set(key, { sessionKey: event.sessionKey, requestId: event.requestId, questions: event.questions, answers: {} });

    const first = event.questions[0];
    if (!first) throw new Error("Codex requested user input without questions.");
    await this.sendCodexQuestion(parsed.conversationId, event.sessionKey, event.requestId, first, 0, token, expiresAt);
  }

  private async handleCodexApprovalRequest(event: AgentApprovalRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const result = await this.sendRendered(parsed.conversationId, formatApprovalMessage(event.title, event.body), {
      replyMarkup: approvalKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return an approval prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      promptMessageId: result.messageId,
      kind: "codex_approval",
      createdAt: Date.now(),
      sessionKey: event.sessionKey,
      payloadJson: JSON.stringify({
        token,
        requestId: event.requestId,
        method: event.method,
        approvalKind: event.approvalKind,
        title: event.title,
        body: event.body,
        params: event.params,
      }),
      expiresAt,
    });
  }

  private async sendCodexQuestion(
    conversationId: ConversationId,
    sessionKeyValue: string,
    requestId: string | number,
    question: AgentUserInputQuestion,
    questionIndex: number,
    token: string,
    expiresAt: number,
  ): Promise<void> {
    const options = question.options ?? [];
    const request = this.codexRequests.get(codexRequestKey(sessionKeyValue, requestId));
    const totalQuestions = request?.questions.length ?? 1;
    const payload = JSON.stringify({
      token,
      requestId,
      questionIndex,
      questionId: question.id,
      header: question.header,
      question: question.question,
      isSecret: Boolean(question.isSecret),
      isOther: Boolean(question.isOther),
      options,
      totalQuestions,
    });
    const useInlineOptions = !question.isSecret && options.length > 0 && this.deps.adapter.capabilities.inlineActions;
    const result = await this.sendRendered(conversationId, formatCodexQuestion(question, questionIndex, totalQuestions), {
      ...(useInlineOptions ? { replyMarkup: codexQuestionKeyboard(token, options, Boolean(question.isOther)) } : { forceReply: true }),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: payload,
      expiresAt,
    });
  }

  private async answerCodexOptionCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, rawAction] = parts;
    if (!token) throw new Error("Question selection is missing.");
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
      return;
    }

    if (rawAction === "submit") {
      const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
      if (!selectedAnswer) throw new Error("Question selection expired.");
      const response = await this.recordCodexAnswer(pending, data, [selectedAnswer]);
      if (response === "expired") return;
      if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
      await this.renderCallbackPage(message, answeredMessage(selectedAnswer), { inline_keyboard: [] });
      if (response) await this.respondToCodexPrompt(response);
      return;
    }

    if (rawAction === "note") {
      const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
      if (!selectedAnswer) throw new Error("Question selection expired.");
      await this.promptForCodexAnswerNote(message, pending, data, selectedAnswer);
      return;
    }

    if (rawAction === "change") {
      const options = Array.isArray(data.options)
        ? data.options.map((option) => {
          const record = asPromptRecord(option);
          return record && typeof record.label === "string"
            ? { label: record.label, description: typeof record.description === "string" ? record.description : "" }
            : undefined;
        }).filter(Boolean) as AgentUserInputOption[]
        : [];
      const question = {
        id: typeof data.questionId === "string" ? data.questionId : "question",
        header: typeof data.header === "string" ? data.header : "Question",
        question: typeof data.question === "string" ? data.question : "Pick one.",
        isOther: Boolean(data.isOther),
        options,
      };
      const questionIndex = typeof data.questionIndex === "number" ? data.questionIndex : 0;
      const totalQuestions = typeof data.totalQuestions === "number" ? data.totalQuestions : 1;
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: undefined, answerMode: undefined }),
      });
      await this.renderCallbackPage(message, formatCodexQuestion(question, questionIndex, totalQuestions), codexQuestionKeyboard(token, options, Boolean(data.isOther)));
      return;
    }

    if (rawAction === "other") {
      await this.promptForCodexOtherAnswer(message, pending, data);
      return;
    }

    const optionIndex = Number(rawAction);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) throw new Error("Question selection is missing.");
    const option = Array.isArray(data.options) ? asPromptRecord(data.options[optionIndex]) : undefined;
    const answer = typeof option?.label === "string" ? option.label : undefined;
    if (!answer) throw new Error("Question selection expired.");

    if (this.deps.store.getCollaborationMode(pending.sessionKey ?? "") === "plan") {
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: answer }),
      });
      await this.renderCallbackPage(message, formatCodexSelectedAnswer(answer), codexQuestionConfirmKeyboard(token));
      return;
    }

    const response = await this.recordCodexAnswer(pending, data, [answer]);
    if (response === "expired") return;
    if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
    await this.renderCallbackPage(message, answeredMessage(answer), { inline_keyboard: [] });
    if (response) await this.respondToCodexPrompt(response);
  }

  private async promptForCodexAnswerNote(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    selectedAnswer: string,
  ): Promise<void> {
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.renderCallbackPage(message, formatCodexSelectedAnswer(selectedAnswer), { inline_keyboard: [] });
    const result = await this.sendRendered(message.conversationId, formatCodexAnswerNotePrompt(selectedAnswer), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return a note prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: pending.sessionKey,
      payloadJson: JSON.stringify({ ...data, selectedAnswer, answerMode: "note" }),
      expiresAt: pending.expiresAt,
    });
  }

  private async promptForCodexOtherAnswer(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    pending: PendingPrompt,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.renderCallbackPage(message, messageWithTitle("Other answer", "Reply with the answer to use."), { inline_keyboard: [] });
    const result = await this.sendRendered(message.conversationId, messageWithTitle("Other answer", "Reply with the answer to use."), {
      forceReply: true,
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("Telegram did not return an other-answer prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: pending.sessionKey,
      payloadJson: JSON.stringify({ ...data, answerMode: "other" }),
      expiresAt: pending.expiresAt,
    });
  }

  private async sendNextCodexQuestion(
    conversationId: ConversationId,
    pending: PendingPrompt,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    if (!pending.sessionKey) return false;
    const requestId = data.requestId as string | number | undefined;
    if (requestId === undefined) return false;
    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) return false;
    const currentIndex = typeof data.questionIndex === "number" ? data.questionIndex : -1;
    const nextIndex = request.questions.findIndex((question, index) => index > currentIndex && !request.answers[question.id]);
    const next = nextIndex >= 0 ? request.questions[nextIndex] : undefined;
    if (!next) return false;
    const token = typeof data.token === "string" ? data.token : shortToken();
    await this.sendCodexQuestion(conversationId, pending.sessionKey, requestId, next, nextIndex, token, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS);
    return true;
  }

  private async answerCodexFreeText(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.sendRendered(conversationId, textMessage("Question expired."));
      return;
    }
    const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
    const answerMode = typeof data.answerMode === "string" ? data.answerMode : undefined;
    const answers = answerMode === "note" && selectedAnswer ? [selectedAnswer, text] : [text];
    const response = await this.recordCodexAnswer(pending, data, answers);
    if (response === "expired") return;
    const hasNext = !response && await this.sendNextCodexQuestion(conversationId, pending, data);
    if (!hasNext) await this.sendRendered(conversationId, data.isSecret ? messageWithTitle("Answered.") : answeredMessage(answers.join("\n")));
    if (response) await this.respondToCodexPrompt(response);
  }

  private async answerRelayCommandPrompt(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.sendRendered(conversationId, textMessage("Command prompt expired."));
      return;
    }
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    if (data.command === "rename") {
      await this.renameCurrentThread(conversationId, text.trim());
      return;
    }
    await this.sendRendered(conversationId, textMessage("Command prompt expired."));
  }

  private async recordCodexAnswer(
    pending: PendingPrompt,
    data: Record<string, unknown>,
    answers: string[],
  ): Promise<{ sessionKey: string; requestId: string | number; result: unknown } | "expired" | undefined> {
    if (!pending.sessionKey) throw new Error("Question session is missing.");
    const requestId = data.requestId as string | number | undefined;
    const questionId = typeof data.questionId === "string" ? data.questionId : undefined;
    if (requestId === undefined || !questionId) throw new Error("Question payload is invalid.");

    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) {
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.sendRendered(pending.conversationId, textMessage("Question expired."));
      return "expired";
    }

    request.answers[questionId] = { answers };
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    if (Object.keys(request.answers).length !== request.questions.length) return undefined;
    this.codexRequests.delete(codexRequestKey(pending.sessionKey, requestId));
    return { sessionKey: pending.sessionKey, requestId, result: { answers: request.answers } };
  }

  private async respondToCodexPrompt(response: { sessionKey: string; requestId: string | number; result: unknown }): Promise<void> {
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer Codex prompts.");
    await this.deps.agent.respond(response.sessionKey, response.requestId, response.result);
    await this.markActiveTask(response.sessionKey, "running");
  }

  private async answerCodexApproval(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, decision] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_approval" || !data || data.token !== token || isExpired(pending)) {
      await this.expireCallbackPrompt(message);
      return;
    }
    if (!pending.sessionKey || !this.deps.agent.respond) throw new Error("Approval session is missing.");
    const approved = decision === "y";
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.renderCallbackPage(
      message,
      formatApprovalDecisionMessage(
        approved ? "Approved." : "Denied.",
        typeof data.title === "string" ? data.title : "Approval request",
        typeof data.body === "string" ? data.body : "",
      ),
      { inline_keyboard: [] },
    );
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, approved, data.params));
    await this.markActiveTask(pending.sessionKey, "running");
  }

  private async expireCallbackPrompt(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    await this.renderCallbackPage(message, messageWithTitle("Question expired."), { inline_keyboard: [] });
  }

  private async bufferAgentOutput(sessionKeyValue: string, conversationId: ConversationId, chunk: string, turnId?: string): Promise<void> {
    await this.outputStreamer.buffer(sessionKeyValue, conversationId, chunk, turnId);
  }

  private async finalizeSessionOutput(sessionKeyValue: string): Promise<void> {
    await this.outputStreamer.finalize(sessionKeyValue);
  }

  private async renderPagedOutputCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): Promise<void> {
    await this.outputStreamer.renderPagedOutputCallback(message, payload);
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
