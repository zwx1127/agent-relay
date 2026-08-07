import { isAuthorized } from "../runtime/config.ts";
import type { SendImageCapabilityRequest } from "./capabilities/send-image.ts";
import type { SendFileCapabilityRequest } from "./capabilities/send-file.ts";
import type { MentionAgentCapabilityRequest } from "./capabilities/mention-agent.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import { chatScopeKey, parseChatScopeKey } from "../domain/scope.ts";
import type {
  AgentTaskInput,
  AgentOutputEvent,
  AgentSessionStatus,
} from "../ports/agent.ts";
import type {
  InboundMessage,
  InboundMessageContext,
  InlineKeyboardMarkup,
  SendMessageOptions,
} from "../ports/im.ts";
import type {
  HomeStatusMode,
  PendingPrompt,
  WorkspaceRecord,
} from "./types.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import { noopLogger, type Logger, type LogFields } from "../domain/logger.ts";
import { UI_BUTTON } from "./ui/constants.ts";
import { consoleKeyboard } from "./ui/keyboards.ts";
import { formatErrorMessage, formatHelpMessage } from "./ui/messages.ts";
import { formatHomeMessage } from "./ui/status-message.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { StatusView } from "./ui/status-view.ts";
import type { RelayControllerDeps, RenderCallbackPageResult } from "./controller-types.ts";
import { SlashCommandRouter } from "./command-router.ts";
import { CallbackRouter, isConsoleCallbackPayload } from "./callback-router.ts";
import { OutputStreamer } from "./output-streamer.ts";
import { ActivityStreamer } from "./activity-streamer.ts";
import { TaskCoordinator, type TaskSubmitPreference } from "./task-coordinator.ts";
import { MediaRelayService } from "./media-service.ts";
import { CodexPromptFlow } from "./codex-prompt-flow.ts";
import { ThreadCommandService } from "./thread-command-service.ts";
import { WorkspaceFlow } from "./workspace-flow.ts";
import { ConversationQueue } from "./conversation-queue.ts";
import { RelayMessageRenderer } from "./rendering.ts";
import { RelaySessionService } from "./session-service.ts";
import { RelayAgentEventRouter } from "./agent-event-router.ts";
import { RelayCapabilityService } from "./capability-service.ts";

interface InboundRoute {
  scopeKey: string;
  promptMessageId?: MessageId;
  promptScopeMismatch?: boolean;
}

export class RelayController {
  private readonly logger: Logger;
  private readonly slashCommands: SlashCommandRouter;
  private readonly callbacks: CallbackRouter;
  private readonly outputStreamer: OutputStreamer;
  private readonly activityStreamer: ActivityStreamer;
  private readonly taskCoordinator: TaskCoordinator;
  private readonly workspaceFlow: WorkspaceFlow;
  private readonly mediaRelay: MediaRelayService;
  private readonly codexPromptFlow: CodexPromptFlow;
  private readonly threadCommands: ThreadCommandService;
  private readonly renderer: RelayMessageRenderer;
  private readonly sessionService: RelaySessionService;
  private readonly agentEvents: RelayAgentEventRouter;
  private readonly capabilityService: RelayCapabilityService;
  // IM providers can deliver callbacks, text, and media concurrently. Serializing
  // per conversation keeps prompt state, task state, and home-message edits ordered.
  private readonly conversationQueue = new ConversationQueue();

  constructor(private readonly deps: RelayControllerDeps) {
    this.logger = deps.logger ?? noopLogger;
    this.renderer = new RelayMessageRenderer(deps.adapter, this.logger);
    this.outputStreamer = new OutputStreamer({
      store: deps.store,
      logger: this.logger,
      getReplyToMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      timing: deps.streamTiming,
    });
    this.activityStreamer = new ActivityStreamer({
      store: deps.store,
      logger: this.logger,
      canEdit: deps.adapter.capabilities.editMessage,
      getReplyToMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
      onReplyTargetClaimed: (sessionKeyValue, messageId) => this.lastUserMessageIds.set(sessionKeyValue, messageId),
      getSessionContext: (sessionKeyValue) => {
        const status = deps.agent.getStatus(sessionKeyValue);
        const stored = deps.store.getSession(sessionKeyValue);
        return {
          threadId: status?.threadId ?? stored?.thread_id ?? undefined,
          threadName: status?.threadName,
          collaborationMode: status?.collaborationMode ?? deps.store.getCollaborationMode(sessionKeyValue),
          goal: status?.threadGoal,
          activeTurnId: status?.activeTurnId,
        };
      },
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
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
      setReplyToMessageId: (sessionKeyValue, messageId) => {
        this.lastUserMessageIds.set(sessionKeyValue, messageId);
        this.activityStreamer.registerUserReplyTarget(
          sessionKeyValue,
          messageId,
          deps.agent.getStatus(sessionKeyValue)?.activeTurnId,
        );
      },
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
    });
    this.workspaceFlow = new WorkspaceFlow({
      config: deps.config,
      store: deps.store,
      agent: deps.agent,
      logger: this.logger,
      ensureAgentStarted: (conversationId, workspace, threadId, options) => this.ensureAgentStarted(conversationId, workspace, threadId, options),
      resetSessionPresentation: (sessionKeyValue, options) => this.resetSessionPresentation(sessionKeyValue, options),
      cancelActiveTasks: (sessionKeyValue) => this.cancelActiveTasks(sessionKeyValue),
      statusView: (conversationId) => this.statusView(conversationId),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      renderStrictCallbackPage: (message, body, replyMarkup) => this.renderStrictCallbackPage(message, body, replyMarkup),
    });
    this.sessionService = new RelaySessionService({
      store: deps.store,
      agent: deps.agent,
      logger: this.logger,
      currentWorkspace: (conversationId) => this.workspaceFlow.currentWorkspace(conversationId),
      experimentalRelayWorkEnabled: deps.config.experimentalRelayWorkEnabled,
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
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      trySendRendered: (conversationId, rendered, failureEvent, fields) => this.trySendRendered(conversationId, rendered, failureEvent, fields),
      appendSystem: (conversationId, text) => this.appendSystem(conversationId, text),
      lastUserMessageId: (sessionKeyValue) => this.lastUserMessageIds.get(sessionKeyValue),
    });
    this.codexPromptFlow = new CodexPromptFlow({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: this.logger,
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
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
      bootstrapResumedActivity: (status) => this.bootstrapResumedActivity(status),
      finalizeSessionOutput: (sessionKeyValue) => this.finalizeSessionOutput(sessionKeyValue),
      resetSessionPresentation: (sessionKeyValue, options) => this.resetSessionPresentation(sessionKeyValue, options),
      refreshActivityContext: (sessionKeyValue) => this.activityStreamer.refreshContext(sessionKeyValue),
      finalizeActivityInterrupt: (sessionKeyValue) => this.activityStreamer.terminate(
        sessionKeyValue,
        "interrupted",
        undefined,
        { appendTranscript: false },
      ),
      registerGoalReplyTarget: (sessionKeyValue, messageId, activeTurnId) => this.activityStreamer.registerGoalReplyTarget(sessionKeyValue, messageId, activeTurnId),
      clearGoalReplyTarget: (sessionKeyValue) => this.activityStreamer.clearGoalReplyTarget(sessionKeyValue),
      isCurrentControlCard: (sessionKeyValue, messageId) => this.activityStreamer.isCurrentControlCard(sessionKeyValue, messageId),
      activateControlCard: (sessionKeyValue, scopeKey, messageId, rendered) => this.activityStreamer.activateControlCard(sessionKeyValue, scopeKey, messageId, rendered),
      retireControlCard: (sessionKeyValue, messageId) => this.activityStreamer.retireControlCard(sessionKeyValue, messageId),
      releaseControlCard: (sessionKeyValue, messageId) => this.activityStreamer.releaseControlCard(sessionKeyValue, messageId),
      resumeActivityControls: (sessionKeyValue, messageId) => this.activityStreamer.resumeActivityControls(sessionKeyValue, messageId),
      interruptActiveTasks: (sessionKeyValue) => this.interruptActiveTasks(sessionKeyValue),
      submitTask: (conversationId, text, userMessageId, preference, input) => this.submitTask(conversationId, text, userMessageId, preference, input),
      sendRendered: (conversationId, rendered, options) => this.sendRendered(conversationId, rendered, options),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      renderCallbackPage: (message, body, replyMarkup) => this.renderCallbackPage(message, body, replyMarkup),
      renderStrictCallbackPage: (message, body, replyMarkup) => this.renderStrictCallbackPage(message, body, replyMarkup),
      expireCallbackPrompt: (message) => this.expireCallbackPrompt(message),
      clearCodexPromptsForSession: (sessionKeyValue) => this.clearCodexPromptsForSession(sessionKeyValue),
      hasTaskCreatedAfter: (conversationId, workspaceName, timestamp) => this.hasTaskCreatedAfter(conversationId, workspaceName, timestamp),
    });
    this.agentEvents = new RelayAgentEventRouter({
      logger: this.logger,
      store: deps.store,
      activity: this.activityStreamer,
      media: this.mediaRelay,
      prompts: this.codexPromptFlow,
      finalizeOutput: (sessionKeyValue) => this.finalizeSessionOutput(sessionKeyValue),
      sendPlanReadyPrompt: (sessionKeyValue, turnId) => this.threadCommands.sendPlanReadyPrompt(sessionKeyValue, turnId),
      appendSystem: (conversationId, text) => this.appendSystem(conversationId, text),
      sendRendered: (conversationId, rendered) => this.sendRendered(conversationId, rendered),
      editRendered: (conversationId, rendered, options) => this.editRendered(conversationId, rendered, options),
      completeTask: (sessionKeyValue, turnId, status) => this.completeTaskAndDispatchNext(sessionKeyValue, turnId, status),
      markActiveTask: (sessionKeyValue, status, turnId) => this.markActiveTask(sessionKeyValue, status, turnId),
      cancelActiveTasks: (sessionKeyValue) => this.cancelActiveTasks(sessionKeyValue),
      failActiveTasks: (sessionKeyValue) => this.failActiveTasks(sessionKeyValue),
      currentThreadId: (sessionKeyValue) => deps.agent.getStatus(sessionKeyValue)?.threadId ?? deps.store.getSession(sessionKeyValue)?.thread_id ?? undefined,
      resetSessionPresentation: (sessionKeyValue, options) => this.resetSessionPresentation(sessionKeyValue, options),
    });
    this.capabilityService = new RelayCapabilityService({
      config: deps.config,
      store: deps.store,
      adapter: deps.adapter,
      agent: deps.agent,
      logger: this.logger,
    });
    this.slashCommands = new SlashCommandRouter({
      help: async (conversationId) => {
        await this.sendRendered(conversationId, formatHelpMessage());
      },
      review: (conversationId, text) => this.threadCommands.runReviewCommand(conversationId, text),
      compact: (conversationId) => this.threadCommands.requestCompactConfirmation(conversationId),
      init: (conversationId, userMessageId) => this.threadCommands.runInitCommand(conversationId, userMessageId),
      newThread: (conversationId, name, clearDisplay) => this.threadCommands.startFreshThread(conversationId, name, clearDisplay),
      resume: (conversationId, searchTerm) => this.threadCommands.renderResumePicker(conversationId, searchTerm),
      fork: (conversationId) => this.threadCommands.forkCurrentThread(conversationId),
      side: (conversationId, prompt, userMessageId) => this.threadCommands.sideConversationCommand(conversationId, prompt, userMessageId),
      rename: (conversationId, name) => this.threadCommands.renameCommand(conversationId, name),
      plan: (conversationId, prompt, userMessageId) => this.threadCommands.planCommand(conversationId, prompt, userMessageId),
      goal: (conversationId, args, userMessageId) => this.threadCommands.goalCommand(conversationId, args, userMessageId),
      retiredInterrupt: (conversationId) => this.threadCommands.retiredInterruptCommand(conversationId),
      ps: (conversationId) => this.threadCommands.renderBackgroundTerminals(conversationId),
      stop: (conversationId) => this.threadCommands.cleanBackgroundTerminals(conversationId),
      skills: (conversationId, searchTerm) => this.threadCommands.renderSkillPicker(conversationId, searchTerm),
      mention: (conversationId, searchTerm) => this.threadCommands.renderMentionPicker(conversationId, searchTerm),
      archive: (conversationId) => this.threadCommands.requestArchiveConfirmation(conversationId),
      deleteThread: (conversationId) => this.threadCommands.requestDeleteConfirmation(conversationId),
      unknown: async (conversationId, command) => {
        await this.sendRendered(conversationId, textMessage(`Unknown command: ${command}. Send /help to see supported commands.`));
      },
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
      mcpElicitation: (message, payload) => this.codexPromptFlow.answerMcpCallback(message, payload),
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
    const route = this.routeForInbound(message);
    await this.conversationQueue.run(route.scopeKey, () => this.handleSerial(this.scopedMessage(message, route.scopeKey), route));
  }

  private async handleSerial(message: InboundMessage, route: InboundRoute): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    if (message.kind === "callback_query") {
      await this.handleCallback(message);
      return;
    }
    if (this.shouldIgnoreUnmentionedGroupMessage(message) && !route.promptMessageId && !route.promptScopeMismatch) {
      this.logger.info("router.group_message_ignored", {
        conversation_id: scope.conversationId,
        scope_key: scope.scopeKey,
        user_id: message.userId,
        message_id: message.id,
        kind: message.kind,
      });
      return;
    }
    if (message.kind === "media") {
      await this.mediaRelay.handleMediaMessage(message);
      return;
    }
    if (message.kind === "audio") {
      await this.mediaRelay.handleAudioMessage(message);
      return;
    }
    if (message.kind === "file") {
      await this.mediaRelay.handleFileMessage(message);
      return;
    }

    const text = message.text.trim();
    const command = this.slashCommands.command(text);
    this.logger.info("router.message_received", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      message_id: message.id,
      text_len: message.text.length,
      command,
    });
    this.logger.debug("router.message_text", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      message_id: message.id,
      message_text: message.text,
    });

    if (!isAuthorized(this.deps.config, message.userId, scope.conversationId)) {
      this.logger.warn("router.unauthorized_message", {
        conversation_id: message.conversationId,
        user_id: message.userId,
        message_id: message.id,
      });
      await this.sendRendered(message.conversationId, textMessage("Unauthorized."));
      return;
    }

    try {
      if (route.promptScopeMismatch) {
        await this.sendRendered(message.conversationId, textMessage("This prompt belongs to another topic. Reply in that topic to continue."));
        return;
      }
      if (command === "/relay") {
        await this.renderConsole(message.conversationId, { forceNewMessage: true });
      } else if (command && await this.slashCommands.handle(message, command, text)) {
        return;
      } else {
        // ForceReply answers are keyed by the prompt message id. Ordinary text is
        // never treated as an answer to a Codex question unless it replies to the
        // prompt, which avoids accidentally submitting direct messages as secrets.
        const promptMessageId = route.promptMessageId ?? message.replyToMessageId;
        const pending = promptMessageId
          ? this.deps.store.getPendingPrompt(message.conversationId, promptMessageId)
          : this.latestNextMessagePrompt(message.conversationId);
        if (pending?.kind === "workspace_name") {
          await this.workspaceFlow.createWorkspaceFromPrompt(message.conversationId, pending.promptMessageId, text);
        } else if (pending?.kind === "codex_user_input") {
          await this.codexPromptFlow.answerFreeText(message.conversationId, pending.promptMessageId, text);
        } else if (pending?.kind === "codex_mcp_elicitation") {
          await this.codexPromptFlow.answerMcpFreeText(message.conversationId, pending.promptMessageId, text);
        } else if (pending?.kind === "media_action") {
          await this.mediaRelay.answerMediaActionPrompt(message.conversationId, pending.promptMessageId, text);
        } else if (pending?.kind === "relay_command") {
          await this.threadCommands.answerRelayCommandPrompt(message.conversationId, pending.promptMessageId, text, message.messageId);
        } else {
          // While Codex is blocked on an explicit question or approval, new
          // direct prompts are held back so they do not bypass the requested gate.
          const codexPending = this.deps.store.latestPendingPrompt(message.conversationId, ["codex_user_input", "codex_approval", "codex_mcp_elicitation"]);
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

  private shouldIgnoreUnmentionedGroupMessage(message: InboundMessageContext): boolean {
    return message.conversationType === "group" && message.mentionedBot !== true;
  }

  private async sendPendingCodexPromptNotice(conversationId: ConversationId, pending: PendingPrompt): Promise<void> {
    if (pending.kind === "codex_approval") {
      await this.sendRendered(
        conversationId,
        messageWithTitle(
          "Codex is waiting for approval.",
          "Use the approval buttons before sending another instruction. Direct messages are not submitted while approval is pending; use Interrupt on the latest activity card to stop the blocked turn.",
        ),
      );
      return;
    }
    if (pending.kind === "codex_mcp_elicitation") {
      await this.sendRendered(conversationId, messageWithTitle("Codex is waiting for MCP input.", "Open the latest MCP request card or reply to it. Direct messages are not submitted as answers; use Interrupt on the latest activity card to cancel the blocked turn."));
      return;
    }
    await this.sendRendered(
      conversationId,
      messageWithTitle(
        "Codex is waiting for your answer.",
        "Open the latest question card or reply to it. Direct messages are not submitted as answers; use Interrupt on the latest activity card if the question expired.",
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
    if (this.isInactiveRelayWorkSession(session.sessionKey, session.type ?? "message")) return;
    if (await this.agentEvents.handle(session)) return;
    if (session.type !== undefined && session.type !== "message") return;
    const parsed = parseSessionKey(session.sessionKey);
    if (!parsed) {
      this.logger.warn("router.agent_output_invalid_session", { session_key: session.sessionKey, chunk_len: session.chunk.length });
      return;
    }
    this.logger.debug("router.agent_output_received", {
      session_key: session.sessionKey,
      conversation_id: parsed.conversationId,
      scope_key: parsed.scopeKey,
      workspace: parsed.workspaceName,
      chunk_len: session.chunk.length,
      agent_chunk: session.chunk,
    });
    this.deps.store.appendTranscript({
      conversationId: parsed.conversationId,
      scopeKey: parsed.scopeKey,
      workspaceName: parsed.workspaceName,
      role: "agent",
      text: session.chunk,
      createdAt: Date.now(),
    });
    await this.bufferAgentOutput(session.sessionKey, parsed.scopeKey, session.chunk, session.turnId);
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
    if (this.isInactiveRelayWorkSession(sessionKeyValue, "agent_exit")) return;
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
    await this.activityStreamer.terminate(sessionKeyValue, "failed", exitText).catch((error) => {
      this.logger.warn("router.agent_exit_activity_finalize_failed", { session_key: sessionKeyValue, error: error instanceof Error ? error : new Error(String(error)) });
    });
    await this.resetSessionPresentation(sessionKeyValue, { deletePages: true });
    this.deps.store.markSessionStopped(sessionKeyValue);
    await this.failActiveTasks(sessionKeyValue);
    await this.sendRendered(parsed.scopeKey, messageWithTitle(exitText));
  }

  private async handleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>): Promise<void> {
    const scope = parseChatScopeKey(String(message.conversationId));
    const consoleMessageId = this.deps.store.getConsoleMessageId(message.conversationId);
    this.logger.info("router.callback_received", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      user_id: message.userId,
      callback_query_id: message.callbackQueryId,
      message_id: message.messageId,
      console_message_id: consoleMessageId,
      current_control_card: Boolean(message.messageId && consoleMessageId && String(message.messageId) === String(consoleMessageId)),
      data: message.data,
    });

    if (!isAuthorized(this.deps.config, message.userId, scope.conversationId)) {
      this.logger.warn("router.unauthorized_callback", {
        conversation_id: scope.conversationId,
        scope_key: scope.scopeKey,
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
        conversation_id: scope.conversationId,
        scope_key: scope.scopeKey,
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

  async sendDebugFile(input: SendFileCapabilityRequest): Promise<{ path: string }> {
    return await this.mediaRelay.sendDebugFile(input);
  }

  async mentionPeerAgent(input: MentionAgentCapabilityRequest): Promise<{ peerId: string }> {
    return await this.capabilityService.mentionPeerAgent(input);
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
    const result = await this.renderer.renderCallbackPage(message, body, replyMarkup);
    this.trackControlMessageForScope(message.conversationId, result.messageId, "control");
    return result;
  }

  private async renderStrictCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<RenderCallbackPageResult> {
    const result = await this.renderer.renderStrictCallbackPage(message, body, replyMarkup);
    this.trackControlMessageForScope(message.conversationId, result.messageId, "control");
    return result;
  }

  private async tryRenderCallbackPage(
    message: Extract<InboundMessage, { kind: "callback_query" }>,
    body: string | RenderedTelegramText,
    replyMarkup: InlineKeyboardMarkup,
    failureEvent: string,
  ): Promise<void> {
    await this.renderer.tryRenderCallbackPage(message, body, replyMarkup, failureEvent);
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.renderer.answerCallback(callbackQueryId, text);
  }

  private async sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<SendMessageOptions, "entities" | "parseMode"> = {}): Promise<{ messageId?: MessageId }> {
    const result = await this.renderer.sendRendered(conversationId, rendered, options);
    if (result.messageId) {
      const scope = parseChatScopeKey(String(conversationId));
      this.deps.store.setControlMessage(scope.conversationId, result.messageId, scope.scopeKey, options.replyMarkup ? "control" : "message");
    }
    return result;
  }

  private async trySendRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    failureEvent: string,
    fields: LogFields = {},
    options: Omit<SendMessageOptions, "entities" | "parseMode"> = {},
  ): Promise<void> {
    await this.renderer.trySendRendered(conversationId, rendered, failureEvent, fields, options);
  }

  private async editRendered(
    conversationId: ConversationId,
    rendered: RenderedTelegramText,
    options: Parameters<RelayMessageRenderer["editRendered"]>[2],
  ): Promise<void> {
    await this.renderer.editRendered(conversationId, rendered, options);
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
    return await this.sessionService.ensureStarted(conversationId, workspace, threadId, options);
  }

  private async markActiveTask(sessionKeyValue: string, status: "blocked" | "running", turnId?: string): Promise<void> {
    await this.taskCoordinator.markActive(sessionKeyValue, status, turnId);
    if (status === "running") await this.activityStreamer.setPhase(sessionKeyValue, "working");
  }

  private async completeTaskAndDispatchNext(sessionKeyValue: string, turnId: string | undefined, status: "done" | "interrupted" | "failed" = "done"): Promise<void> {
    await this.taskCoordinator.completeAndDispatchNext(sessionKeyValue, turnId, status);
  }

  private async cancelActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.cancelActive(sessionKeyValue);
  }

  private async interruptActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.interruptActive(sessionKeyValue);
  }

  private async failActiveTasks(sessionKeyValue: string): Promise<void> {
    await this.taskCoordinator.failActive(sessionKeyValue);
  }

  private clearCodexPromptsForSession(sessionKeyValue: string): void {
    this.codexPromptFlow.clearForSession(sessionKeyValue);
  }

  private async bootstrapResumedActivity(status: AgentSessionStatus): Promise<void> {
    try {
      await this.activityStreamer.bootstrapResume(status);
    } catch (error) {
      this.logger.warn("router.resume_activity_snapshot_failed", {
        session_key: status.sessionKey,
        thread_id: status.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async resetSessionPresentation(sessionKeyValue: string, options: { deletePages?: boolean } = {}): Promise<void> {
    await this.activityStreamer.invalidateSession(sessionKeyValue, options.deletePages ?? false);
    await this.finalizeSessionOutput(sessionKeyValue);
    this.clearCodexPromptsForSession(sessionKeyValue);
    this.deps.store.deletePendingPromptsForSession(sessionKeyValue);
    this.lastUserMessageIds.delete(sessionKeyValue);
    this.activityStreamer.clearReplyTargets(sessionKeyValue);
    this.threadCommands?.clearSessionState(sessionKeyValue);
  }

  private isStaleConsoleCallback(message: Extract<InboundMessage, { kind: "callback_query" }>, payload: string): boolean {
    if (!message.messageId || !isConsoleCallbackPayload(payload)) return false;
    const latest = this.deps.store.getConsoleMessageId(message.conversationId);
    return Boolean(latest && String(latest) !== String(message.messageId));
  }

  private currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined {
    return this.workspaceFlow.currentWorkspace(conversationId);
  }

  private isInactiveRelayWorkSession(sessionKeyValue: string, eventType: string): boolean {
    if (!this.deps.config.experimentalRelayWorkEnabled) return false;
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return false;
    const binding = this.deps.store.getBinding(parsed.scopeKey);
    const stored = this.deps.store.getSession(sessionKeyValue);
    const runtime = this.deps.agent.getStatus(sessionKeyValue);
    const active = binding?.workspaceName === parsed.workspaceName
      && (stored?.status === "running" || runtime?.running === true);
    if (active) return false;
    this.logger.info("router.agent_event_inactive_workspace", {
      session_key: sessionKeyValue,
      scope_key: parsed.scopeKey,
      event_workspace: parsed.workspaceName,
      current_workspace: binding?.workspaceName,
      stored_status: stored?.status,
      runtime_running: Boolean(runtime?.running),
      event_type: eventType,
    });
    return true;
  }

  private appendSystem(conversationId: ConversationId, text: string): void {
    this.sessionService.appendSystem(conversationId, text);
  }

  private statusView(conversationId: ConversationId): StatusView {
    return this.sessionService.statusView(conversationId);
  }

  private hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean {
    return this.sessionService.hasTaskCreatedAfter(conversationId, workspaceName, timestamp);
  }

  private conversationIdForSessionKey(sessionKeyValue: string): ConversationId | undefined {
    return parseSessionKey(sessionKeyValue)?.scopeKey;
  }

  private trackControlMessageForScope(scopeKey: ConversationId, messageId: MessageId | undefined, kind = "control"): void {
    if (!messageId) return;
    const scope = parseChatScopeKey(String(scopeKey));
    this.deps.store.setControlMessage(scope.conversationId, messageId, scope.scopeKey, kind);
  }

  private readonly lastUserMessageIds = new Map<string, MessageId>();

  private routeForInbound(message: InboundMessage): InboundRoute {
    if (message.scopeKey) return { scopeKey: message.scopeKey };
    const currentScopeKey = message.topic ? chatScopeKey(message.conversationId, message.topic) : chatScopeKey(message.conversationId);
    const managed = this.managedControlForInbound(message);
    if (managed) {
      if (message.kind === "callback_query") return { scopeKey: managed.scopeKey, promptMessageId: managed.messageId };
      if (sameChatLocation(managed.scopeKey, currentScopeKey)) return { scopeKey: managed.scopeKey, promptMessageId: managed.messageId };
      return { scopeKey: currentScopeKey, promptScopeMismatch: true };
    }
    if (message.kind === "callback_query" && message.messageId) {
      return {
        scopeKey: this.deps.store.getControlMessageScopeKey(message.conversationId, message.messageId)
          ?? currentScopeKey,
      };
    }
    return { scopeKey: currentScopeKey };
  }

  private managedControlForInbound(message: InboundMessage): { scopeKey: string; messageId: MessageId } | undefined {
    for (const messageId of this.promptCandidateMessageIds(message)) {
      const control = this.deps.store.getControlMessage(message.conversationId, messageId);
      if (control && this.isManagedPromptKind(control.kind)) {
        return { scopeKey: control.scopeKey, messageId };
      }
    }
    return undefined;
  }

  private promptCandidateMessageIds(message: InboundMessage): MessageId[] {
    const ids: MessageId[] = [];
    if ("replyToMessageId" in message && message.replyToMessageId) ids.push(message.replyToMessageId);
    if ("replyRootMessageId" in message && message.replyRootMessageId) ids.push(message.replyRootMessageId);
    if (message.topic?.rootMessageId) ids.push(message.topic.rootMessageId);
    if (message.kind === "callback_query" && message.messageId) ids.push(message.messageId);
    return [...new Map(ids.map((id) => [String(id), id])).values()];
  }

  private isManagedPromptKind(kind: string | undefined): boolean {
    return kind === "workspace_name"
      || kind === "codex_user_input"
      || kind === "codex_approval"
      || kind === "relay_command"
      || kind === "media_action";
  }

  private latestNextMessagePrompt(conversationId: ConversationId): PendingPrompt | undefined {
    const pending = this.deps.store.latestPendingPrompt(conversationId, ["media_action", "workspace_name", "relay_command"]);
    if (!pending) return undefined;
    if (pending.kind === "media_action" || pending.kind === "workspace_name") return pending;
    const data = parseJsonRecord(pending.payloadJson);
    return data?.command === "side" || data?.command === "rename" || data?.command === "attachment_task" ? pending : undefined;
  }

  private scopedMessage<T extends InboundMessage>(message: T, scopeKey: string): T {
    return { ...message, conversationId: scopeKey, scopeKey } as T;
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

function parseJsonRecord(json: string | undefined): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function sameChatLocation(leftScopeKey: string, rightScopeKey: string): boolean {
  if (leftScopeKey === rightScopeKey) return true;
  const left = parseChatScopeKey(leftScopeKey);
  const right = parseChatScopeKey(rightScopeKey);
  if (String(left.conversationId) !== String(right.conversationId)) return false;
  if (!left.topic && !right.topic) return true;
  return Boolean(left.topic && right.topic && left.topic.provider === right.topic.provider && left.topic.id === right.topic.id);
}
