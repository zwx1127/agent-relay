import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentImageOutputEvent,
  AgentBuiltinCommand,
  AgentDriver,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentSideConversationResult,
  AgentTaskInput,
} from "../ports/agent.ts";
import type { EditMessageTextOptions, InlineKeyboardMarkup, SendMessageOptions, ImAdapter } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { sessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { Logger } from "../domain/logger.ts";
import type { RelayStore } from "../storage/store.ts";
import type { PendingPrompt, WorkspaceRecord } from "./types.ts";
import { CODEX_PROMPT_TTL_MS, LIST_PAGE_SIZE } from "./ui/constants.ts";
import { shortToken } from "./ui/callback-data.ts";
import { commandArgs, parseReviewTarget } from "./ui/commands.ts";
import { commandConfirmKeyboard, resumeKeyboard } from "./ui/keyboards.ts";
import {
  formatResumeMessage,
} from "./ui/messages.ts";
import { asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";
import type { TaskSubmitPreference } from "./task-coordinator.ts";
import { AttachmentPicker, isWorkspaceMentionPath, parseAttachmentRecord } from "./thread-commands/attachment-picker.ts";
import { BackgroundTerminalService } from "./thread-commands/background-terminals.ts";
import { GoalCommandService } from "./thread-commands/goal.ts";
import { PlanCommandService } from "./thread-commands/plan.ts";
import type { CallbackMessage } from "./thread-commands/types.ts";
import { isActivityControlAction, type ActivityControlAction } from "./activity-controls.ts";
import { hasBusyWorkspaceWork, isAgentSessionBusy } from "./session-busy.ts";
import { SideConversationPresenter, type SideConversationPresentation } from "./side-conversation-presenter.ts";

export interface ThreadCommandDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "deleteMessage" | "setMessageReaction" | "capabilities">;
  logger: Logger;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string, options?: { resumePrevious?: boolean }): Promise<AgentSessionStatus>;
  bootstrapResumedActivity(status: AgentSessionStatus): Promise<void>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  resetSessionPresentation(sessionKey: string, options?: { deletePages?: boolean }): Promise<void>;
  refreshActivityContext(sessionKey: string): Promise<void>;
  finalizeActivityInterrupt(sessionKey: string): Promise<void>;
  registerGoalReplyTarget(sessionKey: string, messageId: MessageId, activeTurnId?: string): void;
  clearGoalReplyTarget(sessionKey: string): void;
  isCurrentControlCard(sessionKey: string, messageId: MessageId): boolean;
  activateControlCard(sessionKey: string, scopeKey: string, messageId: MessageId, rendered: RenderedTelegramText): Promise<void>;
  retireControlCard(sessionKey: string, messageId?: MessageId): Promise<boolean>;
  releaseControlCard(sessionKey: string, messageId: MessageId): boolean;
  resumeActivityControls(sessionKey: string, messageId?: MessageId): Promise<boolean>;
  interruptActiveTasks(sessionKey: string): Promise<void>;
  submitTask(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference?: TaskSubmitPreference, input?: AgentTaskInput): Promise<void>;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  expireCallbackPrompt(message: CallbackMessage): Promise<void>;
  clearCodexPromptsForSession(sessionKey: string): void;
  enqueueSideEvent(scopeKey: string, task: () => Promise<void>): void;
  handleSidePromptEvent(event: AgentOutputEvent): Promise<void>;
  sendSideImage(event: AgentImageOutputEvent, replyToMessageId?: MessageId): Promise<void>;
  hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean;
}

interface ActiveSideConversation {
  token: string;
  scopeKey: string;
  conversationId: ConversationId;
  workspaceName: string;
  ownerSessionKey: string;
  eventSessionKey: string;
  threadId: string;
  controlMessageId?: MessageId;
  activeTurnId?: string;
  presentation?: SideConversationPresentation;
  answer: string;
  pendingRequestIds: Set<string>;
  closing: boolean;
}

export class ThreadCommandService {
  private readonly attachments: AttachmentPicker;
  private readonly backgroundTerminals: BackgroundTerminalService;
  private readonly goals: GoalCommandService;
  private readonly plans: PlanCommandService;
  private readonly sideConversations: SideConversationPresenter;
  private readonly activeSideConversations = new Map<string, ActiveSideConversation>();

  constructor(private readonly deps: ThreadCommandDeps) {
    this.sideConversations = new SideConversationPresenter({
      store: deps.store,
      adapter: deps.adapter,
      logger: deps.logger,
      canEdit: deps.adapter.capabilities.editMessage,
      sendRendered: deps.sendRendered,
      editRendered: deps.editRendered,
    });
    this.attachments = new AttachmentPicker({
      store: deps.store,
      agent: deps.agent,
      commandSession: (conversationId) => this.commandSession(conversationId),
      commandBusy: (conversationId, workspaceName, status) => this.commandBusy(conversationId, workspaceName, status),
      sendBusyCommandNotice: (conversationId) => this.sendBusyCommandNotice(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
      expireCallbackPrompt: deps.expireCallbackPrompt,
    });
    this.backgroundTerminals = new BackgroundTerminalService({
      store: deps.store,
      agent: deps.agent,
      logger: deps.logger,
      commandSession: (conversationId) => this.commandSession(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
    });
    this.goals = new GoalCommandService({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: deps.logger,
      commandSession: (conversationId) => this.commandSession(conversationId),
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      registerGoalReplyTarget: deps.registerGoalReplyTarget,
      clearGoalReplyTarget: deps.clearGoalReplyTarget,
      isCurrentControlCard: deps.isCurrentControlCard,
      activateControlCard: deps.activateControlCard,
      retireControlCard: deps.retireControlCard,
      releaseControlCard: deps.releaseControlCard,
      resumeActivityControls: deps.resumeActivityControls,
      sendRendered: deps.sendRendered,
      editRendered: deps.editRendered,
      refreshActivityContext: deps.refreshActivityContext,
    });
    this.plans = new PlanCommandService({
      store: deps.store,
      agent: deps.agent,
      adapter: deps.adapter,
      logger: deps.logger,
      requireCurrentWorkspace: deps.requireCurrentWorkspace,
      ensureAgentStarted: deps.ensureAgentStarted,
      sessionBusy: (status) => this.sessionBusy(status),
      hasTaskCreatedAfter: deps.hasTaskCreatedAfter,
      submitTask: deps.submitTask,
      sendRendered: deps.sendRendered,
      renderStrictCallbackPage: deps.renderStrictCallbackPage,
    });
  }

  async clearSessionState(sessionKeyValue: string): Promise<void> {
    this.plans.clearSession(sessionKeyValue);
    const active = [...this.activeSideConversations.values()].find((side) => side.ownerSessionKey === sessionKeyValue);
    if (active) await this.closeSideConversationState(active, undefined, true);
  }

  hasActiveSideConversation(conversationId: ConversationId): boolean {
    return this.activeSideConversations.has(String(conversationId));
  }

  activeSideConversationId(conversationId: ConversationId): string | undefined {
    return this.activeSideConversations.get(String(conversationId))?.token;
  }

  async rejectNavigationDuringSideConversation(conversationId: ConversationId): Promise<boolean> {
    if (!this.hasActiveSideConversation(conversationId)) return false;
    await this.deps.sendRendered(conversationId, messageWithTitle(
      "BTW mode is active.",
      "Use Return to main on the latest BTW control card before switching, renaming, archiving, or deleting the main chat.",
    ));
    return true;
  }

  async runReviewCommand(conversationId: ConversationId, text: string): Promise<void> {
    const target = parseReviewTarget(commandArgs(text));
    await this.runBuiltinCommand(conversationId, { type: "review", target });
  }

  async runBuiltinCommand(conversationId: ConversationId, command: AgentBuiltinCommand): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver does not support this command.");
    const result = await this.deps.agent.runBuiltinCommand(key, command);
    if (result.threadId && result.threadId !== status.threadId) this.deps.store.setSessionThreadId(key, result.threadId);
    this.deps.logger.info("router.builtin_command_started", { conversation_id: conversationId, workspace: workspace.name, command: command.type });
    await this.deps.sendRendered(conversationId, messageWithTitle(result.message));
  }

  async runInitCommand(conversationId: ConversationId, userMessageId?: MessageId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    if (existsSync(join(workspace.path, "AGENTS.md"))) {
      await this.deps.sendRendered(conversationId, messageWithTitle("AGENTS.md already exists.", "Skipping /init to avoid overwriting it."));
      return;
    }
    await this.deps.submitTask(conversationId, "Generate a file named AGENTS.md that serves as a contributor guide for this repository.", userMessageId, "immediate");
  }

  async startFreshThread(conversationId: ConversationId, name = "", clearDisplay = false): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (this.commandBusy(conversationId, workspace.name, existing)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    const sourceThreadId = existing?.threadId ?? this.deps.store.getSession(key)?.thread_id ?? undefined;
    const sourceThreadName = existing?.threadName;
    const sourceMode = this.deps.store.getCollaborationMode(key);
    await this.deps.resetSessionPresentation(key, { deletePages: false });
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    let status: AgentSessionStatus;
    try {
      status = await this.deps.ensureAgentStarted(conversationId, workspace);
    } catch (error) {
      await this.restoreThreadAfterFailedSwitch(conversationId, workspace, key, sourceThreadId, sourceThreadName, sourceMode, "start a new chat", error);
      return;
    }
    if (name.trim()) {
      if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
      await this.deps.agent.renameThread(key, name.trim());
      status.threadName = name.trim();
    }
    if (clearDisplay) {
      this.deps.store.clearTranscript(conversationId, workspace.name);
      this.deps.store.deletePagedOutputsForSession(key);
    }
    this.deps.store.setCollaborationMode(key, "default");
    await this.deps.sendRendered(conversationId, messageWithTitle(clearDisplay ? "Cleared Relay display and started a new chat." : "Started a new chat.", `Thread: ${status.threadName ?? status.threadId ?? "new"}`));
  }

  async renderResumePicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    if (this.commandBusy(conversationId, workspace.name, this.deps.agent.getStatus(key))) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.listThreads) throw new Error("Agent driver cannot list threads.");
    const threads = await this.deps.agent.listThreads({
      workspacePath: workspace.path,
      limit: LIST_PAGE_SIZE,
      ...(searchTerm ? { searchTerm } : {}),
    });
    if (threads.length === 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle("No saved chats found."));
      return;
    }
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatResumeMessage(threads), {
      replyMarkup: resumeKeyboard(token, threads),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a resume picker message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      scopeKey: String(conversationId),
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({
        command: "resume",
        token,
        sourceWorkspace: workspace.name,
        sourceThreadId: this.deps.agent.getStatus(key)?.threadId ?? this.deps.store.getSession(key)?.thread_id ?? null,
        threads: threads.map((thread) => ({ id: thread.id, name: thread.name })),
      }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  async forkCurrentThread(conversationId: ConversationId): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    if (!this.deps.agent.forkThread) throw new Error("Agent driver cannot fork threads.");
    const result = await this.deps.agent.forkThread(key);
    await this.deps.resetSessionPresentation(key, { deletePages: false });
    this.deps.store.setSessionThreadId(key, result.threadId);
    await this.deps.sendRendered(conversationId, messageWithTitle("Forked chat.", `Thread: ${result.threadName ?? result.threadId}`));
    this.deps.logger.info("router.thread_forked", { conversation_id: conversationId, workspace: workspace.name, thread_id: result.threadId });
  }

  async sideConversationCommand(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    const normalized = prompt.trim();
    const active = this.activeSideConversations.get(String(conversationId));
    if (active) {
      if (!normalized) await this.renderSideControlCard(active);
      else await this.submitActiveSideInput(conversationId, { text: normalized }, userMessageId);
      return;
    }

    const side = await this.openSideConversation(conversationId);
    try {
      await this.renderSideControlCard(side);
    } catch (error) {
      await this.closeSideConversationState(side, undefined, true);
      throw error;
    }
    if (normalized) await this.submitActiveSideInput(conversationId, { text: normalized }, userMessageId);
  }

  async submitActiveSideInput(
    conversationId: ConversationId,
    input: AgentTaskInput,
    userMessageId?: MessageId,
  ): Promise<void> {
    const side = this.activeSideConversations.get(String(conversationId));
    if (!side || side.closing) {
      await this.deps.sendRendered(conversationId, messageWithTitle("BTW mode ended.", "Run /btw to start another side conversation."));
      return;
    }
    const prompt = input.text.trim();
    if (!prompt && !input.attachments?.length && !input.images?.length) {
      await this.deps.sendRendered(conversationId, messageWithTitle("BTW input not submitted.", "Add a question or an attachment."));
      return;
    }
    if (side.pendingRequestIds.size > 0) {
      await this.deps.sendRendered(conversationId, messageWithTitle(
        "BTW is waiting for your answer.",
        "Reply to the latest Codex question or use its buttons before sending another follow-up.",
      ));
      return;
    }
    if (!this.deps.agent.sendSideConversationInput) throw new Error("Agent driver cannot continue side conversations.");

    const existingPresentation = side.presentation;
    if (existingPresentation) {
      existingPresentation.appendInput(prompt || "Attachment", userMessageId);
    } else {
      side.answer = "";
      side.presentation = await this.sideConversations.begin({
        conversationId,
        sessionKey: side.eventSessionKey,
        question: prompt || "Attachment",
        sourceMessageId: userMessageId,
      });
    }
    const presentation = side.presentation;
    try {
      const result = await this.deps.agent.sendSideConversationInput(side.ownerSessionKey, side.threadId, input);
      if (side.presentation === presentation && result.turnId) side.activeTurnId = result.turnId;
      this.deps.logger.info(result.steered ? "router.side_conversation_steered" : "router.side_conversation_turn_started", {
        conversation_id: conversationId,
        workspace: side.workspaceName,
        session_key: side.ownerSessionKey,
        child_thread_id: side.threadId,
        turn_id: result.turnId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (side.presentation === presentation) {
        side.presentation = undefined;
        side.activeTurnId = undefined;
        await presentation?.fail(detail);
      }
      this.deps.logger.error("router.side_conversation_send_failed", {
        conversation_id: side.conversationId,
        scope_key: side.scopeKey,
        child_thread_id: side.threadId,
        error: error instanceof Error ? error : new Error(detail),
      });
    }
  }

  async answerSideConversationPrompt(
    conversationId: ConversationId,
    promptMessageId: MessageId,
    text: string,
    userMessageId?: MessageId,
  ): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    const side = this.activeSideConversations.get(String(conversationId));
    if (!pending || pending.kind !== "side_conversation" || !data || !side || data.token !== side.token || side.closing) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.deps.sendRendered(conversationId, messageWithTitle("BTW mode ended.", "Run /btw to start another side conversation."));
      return;
    }
    await this.submitActiveSideInput(conversationId, { text: text.trim() }, userMessageId);
  }

  private async openSideConversation(conversationId: ConversationId): Promise<ActiveSideConversation> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const ownerSessionKey = sessionKey(conversationId, workspace.name);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (!status.threadId) throw new Error("Send a normal message first, then try /btw again.");
    if (!this.deps.agent.openSideConversation || !this.deps.agent.sendSideConversationInput
      || !this.deps.agent.interruptSideConversation || !this.deps.agent.closeSideConversation) {
      throw new Error("Agent driver cannot start multi-turn side conversations.");
    }
    const token = shortToken();
    const scope = parseChatScopeKey(String(conversationId));
    const eventSessionKey = sessionKey(scope.scopeKey, workspace.name, `codex-side-${token}`);
    const opened = await this.deps.agent.openSideConversation(ownerSessionKey, {
      eventSessionKey,
      onEvent: (event) => {
        this.deps.enqueueSideEvent(scope.scopeKey, () => this.handleSideConversationEvent(scope.scopeKey, token, event));
      },
    });
    const side: ActiveSideConversation = {
      token,
      scopeKey: scope.scopeKey,
      conversationId: scope.conversationId,
      workspaceName: workspace.name,
      ownerSessionKey,
      eventSessionKey,
      threadId: opened.threadId,
      answer: "",
      pendingRequestIds: new Set(),
      closing: false,
    };
    this.activeSideConversations.set(scope.scopeKey, side);
    this.deps.logger.info("router.side_conversation_opened", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      workspace: workspace.name,
      session_key: ownerSessionKey,
      child_thread_id: opened.threadId,
    });
    return side;
  }

  private async renderSideControlCard(side: ActiveSideConversation): Promise<void> {
    if (side.controlMessageId !== undefined) {
      this.deps.store.deletePendingPrompt(side.scopeKey, side.controlMessageId);
      await this.deps.editRendered(
        side.scopeKey,
        messageWithTitle("BTW mode is active.", "Controls moved to the latest BTW card."),
        { messageId: side.controlMessageId, replyMarkup: { inline_keyboard: [] } },
      ).catch(() => undefined);
    }
    const result = await this.deps.sendRendered(side.scopeKey, messageWithTitle(
      "BTW mode is active.",
      "Send ordinary messages to continue this side conversation. The main chat stays unchanged.",
    ), {
      forceReply: true,
      forceReplyInstruction: "Reply here, or send your next message, to ask BTW.",
      inputFieldPlaceholder: "Ask a side question",
      replyMarkup: { inline_keyboard: [[{ text: "Return to main", callback_data: `ar:cmd:side:${side.token}:close` }]] },
      disableWebPagePreview: true,
      deliveryMode: "at-most-once",
    });
    if (!result.messageId) throw new Error("IM adapter did not return a BTW control card message id.");
    side.controlMessageId = result.messageId;
    this.deps.store.setPendingPrompt({
      conversationId: side.conversationId,
      scopeKey: side.scopeKey,
      promptMessageId: result.messageId,
      kind: "side_conversation",
      createdAt: Date.now(),
      sessionKey: side.eventSessionKey,
      payloadJson: JSON.stringify({ command: "side", token: side.token }),
    });
  }

  private async handleSideConversationEvent(scopeKey: string, token: string, event: AgentOutputEvent): Promise<void> {
    const side = this.activeSideConversations.get(scopeKey);
    if (!side || side.token !== token || side.eventSessionKey !== event.sessionKey || side.closing) return;
    if (!event.type || event.type === "message") {
      side.answer += event.chunk;
      side.presentation?.appendDelta(event.chunk);
      return;
    }
    if (event.type === "activity") {
      side.presentation?.updateActivity(event.activity);
      return;
    }
    if (event.type === "image") {
      await this.deps.sendSideImage(event, side.presentation?.messageId());
      return;
    }
    if (event.type === "user_input_request" || event.type === "approval_request" || event.type === "mcp_elicitation_request") {
      side.pendingRequestIds.add(sideRequestKey(event.requestId));
      await this.deps.handleSidePromptEvent(event);
      return;
    }
    if (event.type === "server_request_resolved") {
      side.pendingRequestIds.delete(sideRequestKey(event.requestId));
      await this.deps.handleSidePromptEvent(event);
      return;
    }
    if (event.type === "turn_completed") {
      if (event.turnId && side.activeTurnId && event.turnId !== side.activeTurnId) return;
      const presentation = side.presentation;
      side.presentation = undefined;
      side.activeTurnId = undefined;
      side.pendingRequestIds.clear();
      if (!presentation) return;
      const result: AgentSideConversationResult = {
        message: side.answer,
        status: event.status === "interrupted" || event.status === "failed" ? event.status : "completed",
        threadId: side.threadId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.error ? { error: event.error } : {}),
      };
      await presentation.complete(result);
      side.answer = "";
      this.deps.logger.info("router.side_conversation_turn_completed", {
        conversation_id: side.conversationId,
        scope_key: side.scopeKey,
        child_thread_id: side.threadId,
        turn_id: event.turnId,
        status: result.status,
      });
      return;
    }
    if (event.type === "thread_lifecycle") {
      await side.presentation?.fail("The BTW child chat ended.");
      if (side.controlMessageId !== undefined) {
        await this.deps.editRendered(
          side.scopeKey,
          messageWithTitle("BTW mode ended.", "The ephemeral child chat is no longer available. Run /btw to start another one."),
          { messageId: side.controlMessageId, replyMarkup: { inline_keyboard: [] } },
        ).catch(() => undefined);
      }
      await this.clearSideConversationState(side);
    }
  }

  async renameCommand(conversationId: ConversationId, name: string): Promise<void> {
    if (name.trim()) {
      await this.renameCurrentThread(conversationId, name.trim());
      return;
    }
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const key = sessionKey(conversationId, workspace.name);
    const result = await this.deps.sendRendered(conversationId, textMessage("New chat name requested."), {
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt, or send your next message with the new chat name.",
      inputFieldPlaceholder: "New chat name",
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a rename prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command: "rename" }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  async renameCurrentThread(conversationId: ConversationId, name: string): Promise<void> {
    const { key } = await this.commandSession(conversationId);
    if (!this.deps.agent.renameThread) throw new Error("Agent driver cannot rename threads.");
    await this.deps.agent.renameThread(key, name);
    await this.deps.sendRendered(conversationId, messageWithTitle("Renamed chat.", name));
  }

  async planCommand(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void> {
    await this.plans.run(conversationId, prompt, userMessageId);
  }

  async goalCommand(conversationId: ConversationId, args: string, userMessageId?: MessageId): Promise<void> {
    await this.goals.run(conversationId, args, userMessageId);
  }

  async cleanBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    await this.backgroundTerminals.clean(conversationId);
  }

  async retiredInterruptCommand(conversationId: ConversationId): Promise<void> {
    await this.deps.sendRendered(conversationId, messageWithTitle("Interrupt command removed.", "Use Interrupt on the latest activity card."));
  }

  async renderBackgroundTerminals(conversationId: ConversationId): Promise<void> {
    await this.backgroundTerminals.render(conversationId);
  }

  async renderSkillPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    await this.attachments.renderSkills(conversationId, searchTerm);
  }

  async renderMentionPicker(conversationId: ConversationId, searchTerm: string): Promise<void> {
    await this.attachments.renderMentions(conversationId, searchTerm);
  }

  async requestCompactConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "compact", "Compact chat?", "Codex will replace earlier turns with a summary.", "Compact");
  }

  async requestArchiveConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "archive", "Archive chat?", "The transcript stays stored and can be restored with Codex CLI.", "Archive");
  }

  async requestDeleteConfirmation(conversationId: ConversationId): Promise<void> {
    await this.requestThreadConfirmation(conversationId, "delete", "Permanently delete chat?", "Deletion also removes descendant sessions. This requires two confirmations.", "Continue", "first");
  }

  private async requestThreadConfirmation(
    conversationId: ConversationId,
    command: "compact" | "archive" | "delete",
    title: string,
    body: string,
    confirmLabel: string,
    stage = "confirm",
  ): Promise<void> {
    const { workspace, status, key } = await this.commandSession(conversationId);
    if (this.commandBusy(conversationId, workspace.name, status)) {
      await this.sendBusyCommandNotice(conversationId);
      return;
    }
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, messageWithTitle(title, body), {
      replyMarkup: commandConfirmKeyboard(token, command, confirmLabel, stage),
    });
    if (!result.messageId) throw new Error("IM adapter did not return a command confirmation message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
      promptMessageId: result.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: key,
      payloadJson: JSON.stringify({ command, token, stage, threadId: status.threadId }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  private async commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    return { workspace, status, key: sessionKey(conversationId, workspace.name) };
  }

  private sessionBusy(status: AgentSessionStatus): boolean {
    return isAgentSessionBusy(status);
  }

  private async sendBusyCommandNotice(conversationId: ConversationId): Promise<void> {
    await this.deps.sendRendered(conversationId, messageWithTitle("Codex is busy.", "Wait for the current turn, answer the pending question, or handle the approval request before running this command."));
  }

  async handleCommandCallback(message: CallbackMessage, payload: string): Promise<string | void> {
    const parts = payload.split(":");
    const [, command, token, action] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (command === "side") {
      const side = this.activeSideConversations.get(String(message.conversationId));
      if (!pending || pending.kind !== "side_conversation" || !data || !side || data.token !== token
        || side.token !== token || action !== "close" || side.closing) {
        if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
        await this.deps.renderCallbackPage(
          message,
          messageWithTitle("BTW mode ended.", "Run /btw to start another side conversation."),
          { inline_keyboard: [] },
        );
        return "BTW mode already ended.";
      }
      await this.closeSideConversationState(side, message);
      return "Returned to main chat.";
    }
    if (!pending || pending.kind !== "relay_command" || !data || data.token !== token || isExpired(pending)) {
      if (command === "terminal") {
        if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
        await this.renderBackgroundTerminals(message.conversationId);
        return;
      }
      if (command === "activity") return "Control expired.";
      await this.deps.expireCallbackPrompt(message);
      return;
    }

    if (command === "compact" || command === "archive" || command === "delete") {
      await this.confirmThreadCommand(message, pending, data, command, action);
      return;
    }

    if (command === "attach") {
      await this.attachments.handleCallback(message, pending, data, action);
      return;
    }

    if (command === "terminal") {
      await this.backgroundTerminals.stopFromCallback(message, pending, data, action);
      return;
    }

    if (command === "resume") {
      await this.resumeFromCallback(message, pending, data, action);
      return;
    }
    if (command === "plan") {
      await this.plans.handleCallback(message, pending, data, action);
      return;
    }
    if (command === "activity") {
      return this.handleActivityControlCallback(message, pending, data, action);
    }
    throw new Error("Unknown command callback.");
  }

  private async closeSideConversationState(
    side: ActiveSideConversation,
    message?: CallbackMessage,
    bestEffort = false,
  ): Promise<void> {
    if (side.closing) return;
    side.closing = true;
    try {
      if (side.activeTurnId && this.deps.agent.interruptSideConversation) {
        await this.deps.agent.interruptSideConversation(side.ownerSessionKey, side.threadId);
      }
      if (this.deps.agent.closeSideConversation) {
        await this.deps.agent.closeSideConversation(side.ownerSessionKey, side.threadId);
      }
      if (side.presentation) {
        await side.presentation.complete({
          message: side.answer,
          status: "interrupted",
          threadId: side.threadId,
          ...(side.activeTurnId ? { turnId: side.activeTurnId } : {}),
        });
      }
      await this.clearSideConversationState(side);
      if (message) {
        await this.deps.renderCallbackPage(
          message,
          messageWithTitle("Returned to main chat.", "The BTW child chat was closed and will not be resumed."),
          { inline_keyboard: [] },
        );
      }
      this.deps.logger.info("router.side_conversation_closed", {
        conversation_id: side.conversationId,
        scope_key: side.scopeKey,
        child_thread_id: side.threadId,
      });
    } catch (error) {
      side.closing = false;
      if (!bestEffort) throw error;
      this.deps.logger.warn("router.side_conversation_close_failed", {
        conversation_id: side.conversationId,
        scope_key: side.scopeKey,
        child_thread_id: side.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.clearSideConversationState(side);
    }
  }

  private async clearSideConversationState(side: ActiveSideConversation): Promise<void> {
    if (this.activeSideConversations.get(side.scopeKey) === side) this.activeSideConversations.delete(side.scopeKey);
    this.deps.clearCodexPromptsForSession(side.eventSessionKey);
    this.deps.store.deletePendingPromptsForSession(side.eventSessionKey);
    side.pendingRequestIds.clear();
    side.presentation = undefined;
    side.activeTurnId = undefined;
  }

  private async handleActivityControlCallback(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    actionValue: string | undefined,
  ): Promise<string> {
    if (!isActivityControlAction(actionValue)) return this.expireActivityControl(message, pending);
    const action: ActivityControlAction = actionValue;
    const allowed = Array.isArray(data.actions) && data.actions.some((value) => value === action);
    if (!allowed) return this.expireActivityControl(message, pending);

    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running
      || pending.sessionKey !== key
      || data.sessionKey !== key
      || (typeof data.threadId === "string" && status.threadId !== data.threadId)) {
      return this.expireActivityControl(message, pending);
    }
    if (message.messageId === undefined || !this.deps.isCurrentControlCard(key, message.messageId)) {
      return this.expireActivityControl(message, pending);
    }

    const turnBound = data.phase === "working" || data.phase === "waitingForInput" || data.phase === "waitingForApproval";
    const interruptTurnMismatch = action === "interrupt" && typeof data.turnId === "string" && status.activeTurnId !== data.turnId;
    if ((turnBound || interruptTurnMismatch) && typeof data.turnId === "string" && status.activeTurnId !== data.turnId) {
      return this.expireActivityControl(message, pending);
    }

    const goal = this.deps.agent.getThreadGoal ? await this.deps.agent.getThreadGoal(key) : null;
    if (typeof data.goalCreatedAt === "number") {
      if (!goal || goal.createdAt !== data.goalCreatedAt) return this.expireActivityControl(message, pending);
      if (action !== "interrupt" && typeof data.goalUpdatedAt === "number" && goal.updatedAt !== data.goalUpdatedAt) {
        return this.expireActivityControl(message, pending);
      }
    } else if (action !== "interrupt") {
      return this.expireActivityControl(message, pending);
    }

    if (action === "interrupt") {
      const interruptResult = await this.interruptCurrentTurn(message.conversationId, workspace.name, key, status);
      if (!interruptResult) return this.expireActivityControl(message, pending);
      if (goal?.status === "active" && this.deps.agent.setThreadGoal) {
        await this.deps.agent.setThreadGoal(key, { status: "paused" });
        await this.deps.refreshActivityContext(key);
      }
      if (interruptResult === "recovered") await this.deps.finalizeActivityInterrupt(key);
      return goal?.status === "active" ? "Interrupted. Goal paused." : "Interrupted.";
    }

    return this.goals.handleControl(message, pending, action, data.phase);
  }

  private async interruptCurrentTurn(
    conversationId: ConversationId,
    workspaceName: string,
    key: string,
    status: AgentSessionStatus,
  ): Promise<"interrupted" | "recovered" | undefined> {
    const blockedOnPrompt = Boolean(status.waitingForApproval || status.waitingForUserInput);
    if (!status.activeTurnId && !blockedOnPrompt) return undefined;
    if (!this.deps.agent.interrupt) throw new Error("Agent driver cannot interrupt turns.");

    await this.deps.finalizeSessionOutput(key);
    const result = await this.deps.agent.interrupt(key);
    const handled = result.interrupted || result.stale || blockedOnPrompt;
    if (!handled) return undefined;
    if (result.turnId && this.deps.store.getCollaborationMode(key) === "plan") {
      this.plans.markInterruptedTurn(key, result.turnId);
    }
    this.deps.clearCodexPromptsForSession(key);
    await this.deps.interruptActiveTasks(key);
    this.deps.logger.info(
      result.stale ? "router.stale_turn_interrupt_recovered" : blockedOnPrompt && !result.interrupted ? "router.blocked_turn_interrupt_recovered" : "router.turn_interrupted",
      {
        conversation_id: conversationId,
        workspace: workspaceName,
        session_key: key,
        turn_id: result.turnId,
        source: "activity_control",
      },
    );
    return result.interrupted ? "interrupted" : "recovered";
  }

  private async expireActivityControl(message: CallbackMessage, pending: PendingPrompt): Promise<string> {
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    return "Control expired.";
  }

  private async confirmThreadCommand(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    command: "compact" | "archive" | "delete",
    action: string | undefined,
  ): Promise<void> {
    if (action === "cancel") {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} cancelled.`), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    if (command === "delete" && action === "first") {
      const token = typeof data.token === "string" ? data.token : shortToken();
      await this.deps.renderStrictCallbackPage(
        message,
        messageWithTitle("Final deletion confirmation", "This permanently removes the transcript and descendant sessions. This cannot be undone."),
        commandConfirmKeyboard(token, "delete", "Delete permanently", "confirm"),
      );
      this.deps.store.setPendingPrompt({ ...pending, payloadJson: JSON.stringify({ ...data, stage: "final" }) });
      return;
    }
    if (action !== "confirm") throw new Error("Command confirmation is unavailable.");
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!status?.running || status.threadId !== data.threadId || pending.sessionKey !== key) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} expired.`, "The active chat changed."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    if (this.commandBusy(message.conversationId, workspace.name, status)) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Codex is busy.", "Wait for the current work to finish and run the command again."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(`${capitalize(command)} in progress.`), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    if (command === "compact") {
      if (!this.deps.agent.runBuiltinCommand) throw new Error("Agent driver cannot compact threads.");
      const result = await this.deps.agent.runBuiltinCommand(key, { type: "compact" });
      await this.deps.renderCallbackPage(message, messageWithTitle(result.message), { inline_keyboard: [] });
      return;
    }
    if (command === "archive") {
      if (!this.deps.agent.archiveThread) throw new Error("Agent driver cannot archive threads.");
      await this.deps.agent.archiveThread(key);
    } else {
      if (!this.deps.agent.deleteThread) throw new Error("Agent driver cannot delete threads.");
      await this.deps.agent.deleteThread(key);
    }
    await this.deps.resetSessionPresentation(key, { deletePages: true });
    await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    this.deps.store.clearSessionThreadId(key);
    await this.deps.renderCallbackPage(message, messageWithTitle(command === "archive" ? "Chat archived." : "Chat deleted."), { inline_keyboard: [] });
  }

  private async resumeFromCallback(
    message: CallbackMessage,
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
    const threadName = typeof selected?.name === "string" ? selected.name : threadId;
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const statusBefore = this.deps.agent.getStatus(key);
    const sourceMode = this.deps.store.getCollaborationMode(key);
    const currentThreadId = statusBefore?.threadId ?? this.deps.store.getSession(key)?.thread_id ?? undefined;
    const sourceThreadId = typeof data.sourceThreadId === "string" ? data.sourceThreadId : undefined;
    const sourceWorkspace = typeof data.sourceWorkspace === "string" ? data.sourceWorkspace : undefined;
    if (pending.sessionKey !== key || sourceWorkspace !== workspace.name || sourceThreadId !== currentThreadId) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Resume selection expired.", "The active chat changed. Open a new resume picker."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    if (this.commandBusy(message.conversationId, workspace.name, statusBefore)) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Codex is busy.", "The current chat was not changed."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    if (threadId === currentThreadId) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Already using this chat.", threadName), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Resuming chat.", threadName), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
    await this.deps.resetSessionPresentation(key, { deletePages: false });
    if (this.deps.agent.release) await this.deps.agent.release(key);
    else await this.deps.agent.stop(key);
    this.deps.store.markSessionStopped(key);
    let status: AgentSessionStatus;
    try {
      status = await this.deps.ensureAgentStarted(message.conversationId, workspace, threadId);
    } catch (error) {
      await this.restoreThreadAfterFailedSwitch(message.conversationId, workspace, key, currentThreadId, statusBefore?.threadName, sourceMode, `resume ${threadName}`, error, message);
      return;
    }
    this.deps.store.setSessionThreadId(key, status.threadId ?? threadId);
    await this.deps.bootstrapResumedActivity(status);
    await this.deps.renderCallbackPage(message, messageWithTitle("Resumed chat.", status.threadName ?? status.threadId ?? threadId), { inline_keyboard: [] });
  }

  async sendPlanReadyPrompt(sessionKeyValue: string, completedTurnId?: string): Promise<void> {
    await this.plans.sendReadyPrompt(sessionKeyValue, completedTurnId);
  }

  private async restoreThreadAfterFailedSwitch(
    conversationId: ConversationId,
    workspace: WorkspaceRecord,
    key: string,
    sourceThreadId: string | undefined,
    sourceThreadName: string | undefined,
    sourceMode: "default" | "plan",
    operation: string,
    switchError: unknown,
    callbackMessage?: CallbackMessage,
  ): Promise<void> {
    const switchDetail = errorMessage(switchError);
    let body: string;
    if (!sourceThreadId) {
      this.deps.store.markSessionStopped(key);
      body = `Could not ${operation}: ${switchDetail}\nNo previous chat was available to restore.`;
    } else {
      try {
        const restored = await this.deps.ensureAgentStarted(conversationId, workspace, sourceThreadId);
        this.deps.store.setSessionThreadId(key, restored.threadId ?? sourceThreadId);
        this.deps.store.setCollaborationMode(key, sourceMode);
        body = `Could not ${operation}: ${switchDetail}\nRestored: ${restored.threadName ?? sourceThreadName ?? sourceThreadId}`;
      } catch (rollbackError) {
        this.deps.store.markSessionStopped(key);
        this.deps.store.setSessionThreadId(key, sourceThreadId);
        body = `Could not ${operation}: ${switchDetail}\nCould not restore the previous chat: ${errorMessage(rollbackError)}`;
      }
    }
    const rendered = messageWithTitle("Chat switch failed.", body);
    if (callbackMessage) await this.deps.renderCallbackPage(callbackMessage, rendered, { inline_keyboard: [] });
    else await this.deps.sendRendered(conversationId, rendered);
  }

  private commandBusy(conversationId: ConversationId, workspaceName: string, status: AgentSessionStatus | undefined): boolean {
    return hasBusyWorkspaceWork(this.deps.store, conversationId, workspaceName, status);
  }

  async answerRelayCommandPrompt(conversationId: ConversationId, promptMessageId: MessageId, text: string, userMessageId?: MessageId): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "relay_command" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
      return;
    }
    if (data.command === "rename" && this.hasActiveSideConversation(conversationId)) {
      await this.rejectNavigationDuringSideConversation(conversationId);
      return;
    }
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    if (data.command === "rename") {
      await this.renameCurrentThread(conversationId, text.trim());
      return;
    }
    if (data.command === "attachment_task") {
      const workspace = this.deps.requireCurrentWorkspace(conversationId);
      const key = sessionKey(conversationId, workspace.name);
      const status = this.deps.agent.getStatus(key);
      const attachment = parseAttachmentRecord(data.attachment);
      const activeSideConversation = this.hasActiveSideConversation(conversationId);
      if (!status?.running || pending.sessionKey !== key || status.threadId !== data.threadId || !attachment
        || (!activeSideConversation && this.commandBusy(conversationId, workspace.name, status))) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment task expired.", "The active chat changed or Codex is busy. Run the command again."));
        return;
      }
      if (attachment.type === "mention" && !isWorkspaceMentionPath(workspace.path, attachment.path)) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment rejected.", "The selected path is outside the workspace."));
        return;
      }
      const prompt = text.trim();
      if (!prompt) {
        await this.deps.sendRendered(conversationId, messageWithTitle("Attachment not submitted.", "The task description must not be empty."));
        return;
      }
      if (activeSideConversation) {
        await this.submitActiveSideInput(conversationId, { text: prompt, attachments: [attachment] }, userMessageId ?? promptMessageId);
      } else {
        await this.deps.submitTask(conversationId, prompt, promptMessageId, "immediate", { text: prompt, attachments: [attachment] });
      }
      return;
    }
    if (data.command === "goal_edit") {
      await this.goals.answerEdit(conversationId, pending, data, text, userMessageId);
      return;
    }
    await this.deps.sendRendered(conversationId, textMessage("Command prompt expired."));
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function sideRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}
