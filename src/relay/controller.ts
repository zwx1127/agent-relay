import { isAuthorized } from "../runtime/config.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import type {
  AgentTaskInput,
  AgentOutputEvent,
  AgentSessionStatus,
} from "../ports/agent.ts";
import type {
  EditMessageTextOptions,
  InboundMessage,
  InlineKeyboardMarkup,
  SendMessageOptions,
} from "../ports/im.ts";
import type {
  HomeStatusMode,
  PendingPrompt,
  TaskStatus,
  WorkspaceRecord,
} from "./types.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { noopLogger, type Logger, type LogFields } from "../domain/logger.ts";
import { UI_BUTTON } from "./ui/constants.ts";
import { consoleKeyboard } from "./ui/keyboards.ts";
import { formatErrorMessage } from "./ui/messages.ts";
import { formatHomeMessage, statusViewFromParts } from "./ui/status-message.ts";
import { ensureRendered, messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { StatusView } from "./ui/status-view.ts";
import type { RelayControllerDeps, RenderCallbackPageResult } from "./controller-types.ts";
import { SlashCommandRouter } from "./command-router.ts";
import { CallbackRouter, isConsoleCallbackPayload } from "./callback-router.ts";
import { OutputStreamer } from "./output-streamer.ts";
import { TaskCoordinator, type TaskSubmitPreference } from "./task-coordinator.ts";
import { MediaRelayService } from "./media-service.ts";
import { CodexPromptFlow } from "./codex-prompt-flow.ts";
import { ThreadCommandService } from "./thread-command-service.ts";
import { WorkspaceFlow } from "./workspace-flow.ts";
import { ConversationQueue } from "./conversation-queue.ts";

export class RelayController {
  private readonly logger: Logger;
  private readonly slashCommands: SlashCommandRouter;
  private readonly callbacks: CallbackRouter;
  private readonly outputStreamer: OutputStreamer;
  private readonly taskCoordinator: TaskCoordinator;
  private readonly workspaceFlow: WorkspaceFlow;
  private readonly mediaRelay: MediaRelayService;
  private readonly codexPromptFlow: CodexPromptFlow;
  private readonly threadCommands: ThreadCommandService;
  private readonly conversationQueue = new ConversationQueue();

  constructor(private readonly deps: RelayControllerDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.outputStreamer = new OutputStreamer({
      store: deps.store,
      logger: this.logger,
      getReplyToMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      timing: deps.streamTiming,
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
    this.workspaceFlow = new WorkspaceFlow({
      config: deps.config,
      store: deps.store,
      agent: deps.agent,
      logger: this.logger,
      ensureAgentStarted: (conversationId, workspace, threadId, options) => this.ensureAgentStarted(conversationId, workspace, threadId, options),
      finalizeSessionOutput: (sessionKeyValue) => this.finalizeSessionOutput(sessionKeyValue),
      cancelActiveTasks: (sessionKeyValue) => this.cancelActiveTasks(sessionKeyValue),
      statusView: (conversationId) => this.statusView(conversationId),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      renderStrictCallbackPage: (message, body, replyMarkup) => this.renderStrictCallbackPage(message, body, replyMarkup),
    });
    this.mediaRelay = new MediaRelayService({
      config: deps.config,
      store: deps.store,
      adapter: deps.adapter,
      agent: deps.agent,
      logger: this.logger,
      currentWorkspace: (conversationId) => this.workspaceFlow.currentWorkspace(conversationId),
      renderConsole: (conversationId) => this.renderConsole(conversationId),
      ensureAgentStarted: (conversationId, workspace) => this.ensureAgentStarted(conversationId, workspace),
      sendWaitingPromptNotice: (conversationId, status) => this.sendWaitingPromptNotice(conversationId, status),
      submitTask: (conversationId, text, userMessageId, preference, input) => this.submitTask(conversationId, text, userMessageId, preference, input),
      sendRendered: (conversationId, rendered) => this.sendRendered(conversationId, rendered),
      trySendRendered: (conversationId, rendered, failureEvent, fields) => this.trySendRendered(conversationId, rendered, failureEvent, fields),
      appendSystem: (conversationId, text) => this.appendSystem(conversationId, text),
      lastUserMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
    });
    this.codexPromptFlow = new CodexPromptFlow({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      renderStrictCallbackPage: (message, body, replyMarkup) => this.renderStrictCallbackPage(message, body, replyMarkup),
      markActiveTask: (sessionKeyValue, status, turnId) => this.markActiveTask(sessionKeyValue, status, turnId),
    });
    this.threadCommands = new ThreadCommandService({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: this.logger,
      requireCurrentWorkspace: (conversationId) => this.workspaceFlow.requireCurrentWorkspace(conversationId),
      ensureAgentStarted: (conversationId, workspace, threadId, options) => this.ensureAgentStarted(conversationId, workspace, threadId, options),
      finalizeSessionOutput: (sessionKeyValue) => this.finalizeSessionOutput(sessionKeyValue),
      cancelActiveTasks: (sessionKeyValue) => this.cancelActiveTasks(sessionKeyValue),
      interruptActiveTasks: (sessionKeyValue) => this.interruptActiveTasks(sessionKeyValue),
      interruptTasksByStatus: (sessionKeyValue, statuses) => this.interruptTasksByStatus(sessionKeyValue, statuses),
      submitTask: (conversationId, text, userMessageId, preference, input) => this.submitTask(conversationId, text, userMessageId, preference, input),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      renderStrictCallbackPage: (message, body, replyMarkup) => this.renderStrictCallbackPage(message, body, replyMarkup),
      expireCallbackPrompt: (message) => this.expireCallbackPrompt(message),
      clearCodexPromptsForSession: (sessionKeyValue) => this.clearCodexPromptsForSession(sessionKeyValue),
      hasTaskCreatedAfter: (conversationId, workspaceName, timestamp) => this.hasTaskCreatedAfter(conversationId, workspaceName, timestamp),
    });
    this.slashCommands = new SlashCommandRouter({
      review: (conversationId, text) => this.threadCommands.runReviewCommand(conversationId, text),
      compact: (conversationId) => this.threadCommands.runBuiltinCommand(conversationId, { type: "compact" }),
      init: (conversationId, userMessageId) => this.threadCommands.runInitCommand(conversationId, userMessageId),
      newThread: (conversationId) => this.threadCommands.startFreshThread(conversationId),
      resume: (conversationId, searchTerm) => this.threadCommands.renderResumePicker(conversationId, searchTerm),
      fork: (conversationId) => this.threadCommands.forkCurrentThread(conversationId),
      rename: (conversationId, name) => this.threadCommands.renameCommand(conversationId, name),
      plan: (conversationId, prompt, userMessageId) => this.threadCommands.planCommand(conversationId, prompt, userMessageId),
      goal: (conversationId, args) => this.threadCommands.goalCommand(conversationId, args),
      interrupt: (conversationId, args) => this.threadCommands.interruptCommand(conversationId, args),
      ps: (conversationId) => this.threadCommands.renderBackgroundTerminals(conversationId),
      stop: (conversationId) => this.threadCommands.cleanBackgroundTerminals(conversationId),
    });
    this.callbacks = new CallbackRouter({
      isStaleConsoleCallback: (message, payload) => this.isStaleConsoleCallback(message, payload),
      renderStaleConsole: async (message) => {
        await this.renderCallbackPage(message, messageWithTitle("Stale Relay Home.", "Open the latest Relay Home."), { inline_keyboard: [[{ text: UI_BUTTON.refresh, callback_data: "ar:home" }]] });
      },
      home: (message) => this.renderConsole(message.conversationId),
      status: (message) => this.renderHomeCallback(message),
      workspaces: (message, pageIndex) => this.workspaceFlow.renderWorkspacesCallback(message, pageIndex),
      newWorkspace: (message, pageIndex) => this.workspaceFlow.promptForWorkspaceName(message, pageIndex),
      toggleStatusMode: (message) => this.toggleStatusModeCallback(message),
      approval: (message, payload) => this.codexPromptFlow.answerApproval(message, payload),
      codexQuestion: (message, payload) => this.codexPromptFlow.answerOptionCallback(message, payload),
      pagedOutput: (message, payload) => this.renderPagedOutputCallback(message, payload),
      command: (message, payload) => this.threadCommands.handleCommandCallback(message, payload),
      fileBrowser: (message, payload) => this.workspaceFlow.renderFileBrowserCallback(message, payload),
      stop: (message) => this.workspaceFlow.stopFromCallback(message),
      workspaceIntro: (message, token, pageIndex) => this.workspaceFlow.renderWorkspaceIntroCallback(message, token, pageIndex),
      confirmDeleteWorkspace: (message, token) => this.workspaceFlow.confirmDeleteWorkspaceCallback(message, token),
      deleteWorkspace: (message, token) => this.workspaceFlow.deleteWorkspaceCallback(message, token),
      selectWorkspace: (message, token) => this.workspaceFlow.selectWorkspaceFromToken(message, token),
    });
  }

  async handle(message: InboundMessage): Promise<void> {
    await this.conversationQueue.run(message.conversationId, () => this.handleSerial(message));
  }

  private async handleSerial(message: InboundMessage): Promise<void> {
    if (message.kind === "callback_query") {
      await this.handleCallback(message);
      return;
    }
    if (message.kind === "media") {
      await this.mediaRelay.handleMediaMessage(message);
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
      if (command === "/relay") {
        await this.renderConsole(message.conversationId, { forceNewMessage: true });
      } else if (command && await this.slashCommands.handle(message, command, text)) {
        return;
      } else {
        const pending = message.replyToMessageId
          ? this.deps.store.getPendingPrompt(message.conversationId, message.replyToMessageId)
          : undefined;
        if (pending?.kind === "workspace_name") {
          await this.workspaceFlow.createWorkspaceFromPrompt(message.conversationId, message.replyToMessageId!, text);
        } else if (pending?.kind === "codex_user_input") {
          await this.codexPromptFlow.answerFreeText(message.conversationId, message.replyToMessageId!, text);
        } else if (pending?.kind === "relay_command") {
          await this.threadCommands.answerRelayCommandPrompt(message.conversationId, message.replyToMessageId!, text);
        } else {
          const codexPending = this.deps.store.latestPendingPrompt(message.conversationId, ["codex_user_input", "codex_approval"]);
          if (codexPending) {
            await this.sendPendingCodexPromptNotice(message.conversationId, codexPending);
            return;
          }
          await this.submitTask(message.conversationId, text, message.messageId);
        }
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

  private async sendPendingCodexPromptNotice(conversationId: ConversationId, pending: PendingPrompt): Promise<void> {
    if (pending.kind === "codex_approval") {
      await this.sendRendered(
        conversationId,
        messageWithTitle(
          "Codex is waiting for approval.",
          "Use the approval buttons before sending another instruction. Direct messages are not submitted while approval is pending; send /interrupt to stop the blocked turn.",
        ),
      );
      return;
    }
    await this.sendRendered(
      conversationId,
      messageWithTitle(
        "Codex is waiting for your answer.",
        "Open the latest question card or reply to it. Direct messages are not submitted as answers; send /interrupt if the question expired.",
      ),
    );
  }

  async handleAgentOutput(session: AgentOutputEvent): Promise<void> {
    const conversationId = this.conversationIdForSessionKey(session.sessionKey);
    if (conversationId !== undefined) {
      await this.conversationQueue.run(conversationId, () => this.handleAgentOutputSerial(session));
      return;
    }
    await this.handleAgentOutputSerial(session);
  }

  private async handleAgentOutputSerial(session: AgentOutputEvent): Promise<void> {
    if (session.type === "image") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.mediaRelay.sendAgentImageOutput(session);
      return;
    }
    if (session.type === "turn_completed") {
      this.logger.info("router.turn_completed", {
        session_key: session.sessionKey,
        turn_id: session.turnId,
      });
      await this.finalizeSessionOutput(session.sessionKey);
      await this.threadCommands.sendPlanReadyPrompt(session.sessionKey, session.turnId);
      await this.completeTaskAndDispatchNext(session.sessionKey, session.turnId);
      return;
    }
    if (session.type === "user_input_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked", session.turnId);
      await this.codexPromptFlow.handleUserInputRequest(session);
      return;
    }
    if (session.type === "approval_request") {
      await this.finalizeSessionOutput(session.sessionKey);
      await this.markActiveTask(session.sessionKey, "blocked", session.turnId);
      await this.codexPromptFlow.handleApprovalRequest(session);
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
    const conversationId = this.conversationIdForSessionKey(sessionKeyValue);
    if (conversationId !== undefined) {
      await this.conversationQueue.run(conversationId, () => this.handleAgentExitSerial(sessionKeyValue, exitText));
      return;
    }
    await this.handleAgentExitSerial(sessionKeyValue, exitText);
  }

  private async handleAgentExitSerial(sessionKeyValue: string, exitText: string): Promise<void> {
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
    const consoleMessageId = this.deps.store.getConsoleMessageId(message.conversationId);
    this.logger.info("router.callback_received", {
      conversation_id: message.conversationId,
      user_id: message.userId,
      callback_query_id: message.callbackQueryId,
      message_id: message.messageId,
      console_message_id: consoleMessageId,
      current_control_card: Boolean(message.messageId && consoleMessageId && String(message.messageId) === String(consoleMessageId)),
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

  async sendDebugImage(input: SendImageCapabilityRequest): Promise<{ path: string }> {
    return await this.mediaRelay.sendDebugImage(input);
  }

  private async routeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<string | undefined> {
    return await this.callbacks.route(message);
  }

  private async renderHomeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const status = this.statusView(message.conversationId);
    const mode = this.deps.store.getHomeStatusMode(message.conversationId);
    const previousConsoleMessageId = this.deps.store.getConsoleMessageId(message.conversationId);
    const result = await this.renderCallbackPage(message, formatHomeMessage(status, mode), consoleKeyboard(status, mode));
    if (result.messageId) this.deps.store.setConsoleMessageId(message.conversationId, result.messageId);
    this.logger.info("router.home_callback_rendered", {
      conversation_id: message.conversationId,
      message_id: message.messageId,
      workspace: status.workspaceName,
      session_key: status.workspaceName ? sessionKey(message.conversationId, status.workspaceName) : undefined,
      running: Boolean(status.running),
      thread_id: status.threadId,
      previous_console_message_id: previousConsoleMessageId,
      console_message_id: this.deps.store.getConsoleMessageId(message.conversationId),
      render_method: result.method,
      rendered_message_id: result.messageId,
    });
  }

  private async toggleStatusModeCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const previousMode = this.deps.store.getHomeStatusMode(message.conversationId);
    const nextMode: HomeStatusMode = previousMode === "compact" ? "details" : "compact";
    const previousConsoleMessageId = this.deps.store.getConsoleMessageId(message.conversationId);
    this.deps.store.setHomeStatusMode(message.conversationId, nextMode);
    const status = this.statusView(message.conversationId);
    try {
      const result = await this.renderCallbackPage(message, formatHomeMessage(status, nextMode), consoleKeyboard(status, nextMode));
      if (result.messageId) this.deps.store.setConsoleMessageId(message.conversationId, result.messageId);
      this.logger.info("router.home_status_mode_toggled", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        previous_mode: previousMode,
        next_mode: nextMode,
        previous_console_message_id: previousConsoleMessageId,
        console_message_id: this.deps.store.getConsoleMessageId(message.conversationId),
        render_method: result.method,
        rendered_message_id: result.messageId,
      });
    } catch (error) {
      this.deps.store.setHomeStatusMode(message.conversationId, previousMode);
      this.logger.warn("router.home_status_mode_toggle_failed", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        previous_mode: previousMode,
        next_mode: nextMode,
        console_message_id: previousConsoleMessageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  private async renderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<RenderCallbackPageResult> {
    const rendered = ensureRendered(body);
    if (!message.messageId) {
      const result = await this.sendRendered(message.conversationId, rendered, { replyMarkup });
      return { method: "send", messageId: result.messageId };
    }
    try {
      await this.editRendered(message.conversationId, rendered, {
        messageId: message.messageId,
        replyMarkup,
      });
      return { method: "edit", messageId: message.messageId };
    } catch (error) {
      this.logger.warn("router.callback_edit_fallback", {
        conversation_id: message.conversationId,
        message_id: message.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      const result = await this.sendRendered(message.conversationId, rendered, { replyMarkup });
      return { method: "send", messageId: result.messageId };
    }
  }

  private async renderStrictCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<RenderCallbackPageResult> {
    const rendered = ensureRendered(body);
    if (!message.messageId) throw new Error("Callback message is missing.");
    await this.editRendered(message.conversationId, rendered, {
      messageId: message.messageId,
      replyMarkup,
    });
    return { method: "edit", messageId: message.messageId };
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

  private async submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference: TaskSubmitPreference = "auto", input?: AgentTaskInput): Promise<void> {
    await this.taskCoordinator.submit(conversationId, text, userMessageId, preference, input);
  }

  private async sendWaitingPromptNotice(conversationId: ConversationId, status: AgentSessionStatus): Promise<boolean> {
    return await this.taskCoordinator.sendWaitingPromptNotice(conversationId, status);
  }

  private async ensureAgentStarted(
    conversationId: ConversationId,
    workspace: WorkspaceRecord,
    threadId?: string,
    options: { resumePrevious?: boolean } = {},
  ): Promise<AgentSessionStatus> {
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const key = sessionKey(conversationId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (existing?.running && !threadId) return existing;

    const resumePrevious = options.resumePrevious ?? true;
    const previous = threadId || !resumePrevious ? undefined : this.deps.store.getSession(key);
    const resumeThreadId = threadId ?? previous?.thread_id ?? undefined;
    this.logger.info("router.session_starting", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: resumeThreadId });
    let status: AgentSessionStatus;
    try {
      status = await this.deps.agent.start({
        conversationId,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        threadId: resumeThreadId,
      });
    } catch (error) {
      if (threadId || !previous?.thread_id || !isMissingCodexThreadError(error)) throw error;
      this.logger.warn("router.session_auto_resume_failed_starting_fresh", {
        conversation_id: conversationId,
        workspace: workspace.name,
        session_key: key,
        thread_id: previous.thread_id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.deps.store.clearSessionThreadId(key);
      status = await this.deps.agent.start({
        conversationId,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      });
    }
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

  private async interruptActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.interruptActive(sessionKeyValue);
  }

  private async interruptTasksByStatus(sessionKeyValue: string, statuses: TaskStatus[]): Promise<void> {
    await this.taskCoordinator.interruptByStatus(sessionKeyValue, statuses);
  }

  private async failActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.failActive(sessionKeyValue);
  }

  private clearCodexPromptsForSession(sessionKeyValue: string): void {
    this.codexPromptFlow.clearForSession(sessionKeyValue);
  }

  private isStaleConsoleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): boolean {
    if (!message.messageId || !isConsoleCallbackPayload(payload)) return false;
    const latest = this.deps.store.getConsoleMessageId(message.conversationId);
    return Boolean(latest && String(latest) !== String(message.messageId));
  }

  private currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined {
    return this.workspaceFlow.currentWorkspace(conversationId);
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

  private conversationIdForSessionKey(sessionKeyValue: string): ConversationId | undefined {
    return parseSessionKey(sessionKeyValue)?.conversationId;
  }

  private readonly lastUserMessageIds = new Map<string, MessageId>();

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

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no rollout found");
}
