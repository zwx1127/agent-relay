import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { Logger } from "../domain/logger.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentSendOptions, AgentSessionStatus, AgentTaskInput } from "../ports/agent.ts";
import type { ImAdapter, MessageReactionOptions, SendMessageOptions } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import type { RelayTask, WorkspaceRecord } from "./types.ts";
import { reactionForTaskStatus, taskInputFromTask, transcriptTextForInput } from "./tasks/input.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";

export type TaskSubmitPreference = "auto" | "immediate" | "queue";

/**
 * Coordinates relay-local task state with provider turn state.
 *
 * New submissions receive a reaction before agent startup. Once the task exists,
 * the store is the source of truth for later reactions, while the agent status
 * determines whether the input starts a turn, steers it, or waits behind a gate.
 */
export interface TaskCoordinatorDeps {
  store: RelayStore;
  agent: AgentDriver;
  adapter: Pick<ImAdapter, "sendChatAction" | "setMessageReaction">;
  logger: Logger;
  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined;
  renderConsole(conversationId: ConversationId): Promise<void>;
  ensureAgentStarted(conversationId: ConversationId, workspace: WorkspaceRecord, threadId?: string): Promise<AgentSessionStatus>;
  finalizeSessionOutput(sessionKey: string): Promise<void>;
  setReplyToMessageId(sessionKey: string, messageId: MessageId): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
}

export class TaskCoordinator {
  constructor(private readonly deps: TaskCoordinatorDeps) {}

  async submit(conversationId: ConversationId, text: string, userMessageId?: MessageId, preference: TaskSubmitPreference = "auto", input?: AgentTaskInput): Promise<void> {
    if (!text) return;
    const scope = parseChatScopeKey(String(conversationId));
    const taskInput = input ?? { text };
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) {
      await this.deps.renderConsole(scope.scopeKey);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);

    const existingStatus = this.deps.agent.getStatus(sessionKey(scope.scopeKey, workspace.name));
    if (existingStatus) {
      if (await this.sendWaitingPromptNotice(scope.scopeKey, existingStatus)) return;
      if (preference === "immediate" && existingStatus.activeTurnId) {
        await this.deps.sendRendered(scope.scopeKey, messageWithTitle("Codex is busy.", "Wait for the current turn before running this command."));
        return;
      }
    }

    const receiptReactionApplied = await this.trySetMessageReaction({
      conversationId: scope.conversationId,
      messageId: userMessageId,
      emoji: "🫡",
      phase: "received",
      options: { isBig: true },
    });
    let status: AgentSessionStatus;
    try {
      status = await this.deps.ensureAgentStarted(scope.scopeKey, workspace);
    } catch (error) {
      await this.trySetMessageReaction({
        conversationId: scope.conversationId,
        messageId: userMessageId,
        emoji: "😱",
        phase: "status",
        status: "failed",
      });
      throw error;
    }
    if (await this.sendWaitingPromptNotice(scope.scopeKey, status)) {
      await this.trySetMessageReaction({
        conversationId: scope.conversationId,
        messageId: userMessageId,
        emoji: "🤔",
        phase: "status",
        status: "blocked",
      });
      return;
    }
    const busy = Boolean(status.activeTurnId);
    if (preference === "immediate" && busy) {
      await this.trySetMessageReaction({
        conversationId: scope.conversationId,
        messageId: userMessageId,
        phase: "status",
      });
      await this.deps.sendRendered(scope.scopeKey, messageWithTitle("Codex is busy.", "Wait for the current turn before running this command."));
      return;
    }
    if (preference === "auto" && busy) {
      // Auto-submitted chat messages are forwarded as steering input while also
      // being tracked as waiting until Codex returns the turn id for reconciliation.
      const task = this.deps.store.createTask({
        conversationId: scope.conversationId,
        scopeKey: scope.scopeKey,
        workspaceName: workspace.name,
        text,
        input: hasStructuredInput(input) ? input : undefined,
        status: "waiting",
        userMessageId,
      });
      if (!receiptReactionApplied) await this.syncTaskReaction(task.id);
      await this.sendToAgent(scope.scopeKey, workspace, taskInput, userMessageId, task);
      return;
    }
    // Explicit queue requests stay local until the active turn completes.
    const shouldQueue = preference === "queue";
    const task = this.deps.store.createTask({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      workspaceName: workspace.name,
      text,
      input: hasStructuredInput(input) ? input : undefined,
      status: shouldQueue ? "queued" : "running",
      userMessageId,
    });
    if (shouldQueue) {
      if (!receiptReactionApplied) await this.syncTaskReaction(task.id);
      return;
    }
    await this.runTask(workspace, task);
  }

  async markActive(sessionKeyValue: string, status: "blocked" | "running", turnId?: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    if (turnId) {
      // Prefer matching by provider turn id because callbacks can arrive after a
      // newer local task has already become active.
      const fromStatuses: RelayTask["status"][] = status === "blocked" ? ["running"] : ["blocked"];
      const tasks = this.deps.store.updateTasksByTurn(parsed.scopeKey, parsed.workspaceName, turnId, fromStatuses, status);
      for (const task of tasks) {
        this.logTaskStatus(task.id, task.status, task.turnId);
        await this.syncTaskReaction(task.id);
      }
      if (tasks.length > 0) return;
    }
    if (status === "running") {
      const tasks = this.deps.store.listTasks(parsed.scopeKey, parsed.workspaceName, ["blocked"], 100);
      for (const task of tasks) {
        this.updateTaskStatus(task.id, status, task.turnId);
        await this.syncTaskReaction(task.id);
      }
      if (tasks.length > 0) return;
    }
    const task = this.deps.store.activeTask(parsed.scopeKey, parsed.workspaceName);
    if (!task || task.status === "waiting") return;
    this.updateTaskStatus(task.id, status);
    await this.syncTaskReaction(task.id);
  }

  async completeAndDispatchNext(sessionKeyValue: string, turnId: string | undefined, terminalStatus: "done" | "interrupted" | "failed" = "done"): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    // Turn completion may race with local task updates, so completion first tries
    // the exact turn id and then falls back to the current active task.
    const completed = turnId
      ? this.deps.store.updateTasksByTurn(parsed.scopeKey, parsed.workspaceName, turnId, ["running", "blocked"], terminalStatus)
      : [];
    if (completed.length > 0) {
      for (const task of completed) {
        this.logTaskStatus(task.id, task.status, task.turnId);
        await this.syncTaskReaction(task.id);
      }
    } else {
      const active = this.deps.store.activeTask(parsed.scopeKey, parsed.workspaceName);
      if (active && active.status !== "waiting" && (!turnId || !active.turnId || active.turnId === turnId)) {
        this.updateTaskStatus(active.id, terminalStatus);
        await this.syncTaskReaction(active.id);
      }
    }
    const workspace = this.deps.currentWorkspace(parsed.scopeKey);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (!status?.running || status.waitingForApproval || status.waitingForUserInput || status.activeTurnId) return;
    // Waiting tasks have already been sent to Codex as steering input. Do not
    // start queued work until Codex has acknowledged or completed them.
    if (this.deps.store.countTasks(parsed.scopeKey, parsed.workspaceName, ["waiting"]) > 0) return;
    const next = this.deps.store.nextQueuedTask(parsed.scopeKey, parsed.workspaceName);
    if (next) {
      await this.runTask(workspace, next);
    }
  }

  async cancelActive(sessionKeyValue: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const tasks = this.deps.store.updateActiveTasks(parsed.scopeKey, parsed.workspaceName, "cancelled");
    for (const task of tasks) {
      this.logTaskStatus(task.id, task.status, task.turnId);
      await this.syncTaskReaction(task.id);
    }
  }

  async cancelByStatus(sessionKeyValue: string, statuses: RelayTask["status"][]): Promise<void> {
    await this.updateByStatus(sessionKeyValue, statuses, "cancelled");
  }

  async interruptActive(sessionKeyValue: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const tasks = this.deps.store.updateActiveTasks(parsed.scopeKey, parsed.workspaceName, "interrupted");
    for (const task of tasks) {
      this.logTaskStatus(task.id, task.status, task.turnId);
      await this.syncTaskReaction(task.id);
    }
  }

  async interruptByStatus(sessionKeyValue: string, statuses: RelayTask["status"][]): Promise<void> {
    await this.updateByStatus(sessionKeyValue, statuses, "interrupted");
  }

  private async updateByStatus(sessionKeyValue: string, statuses: RelayTask["status"][], status: RelayTask["status"]): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed || statuses.length === 0) return;
    const tasks = this.deps.store.updateTasksByStatus(parsed.scopeKey, parsed.workspaceName, statuses, status);
    for (const task of tasks) {
      this.logTaskStatus(task.id, task.status, task.turnId);
      await this.syncTaskReaction(task.id);
    }
  }

  async failActive(sessionKeyValue: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const tasks = this.deps.store.updateActiveTasks(parsed.scopeKey, parsed.workspaceName, "failed");
    for (const task of tasks) {
      this.logTaskStatus(task.id, task.status, task.turnId);
      await this.syncTaskReaction(task.id);
    }
  }

  private async runTask(workspace: WorkspaceRecord, task: RelayTask): Promise<void> {
    this.updateTaskStatus(task.id, "running");
    await this.syncTaskReaction(task.id);
    await this.sendToAgent(task.scopeKey ?? task.conversationId, workspace, taskInputFromTask(task), task.userMessageId, task);
  }

  private async sendToAgent(conversationId: ConversationId, workspace: WorkspaceRecord, input: AgentTaskInput, userMessageId?: MessageId, task?: RelayTask): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    const key = sessionKey(scope.scopeKey, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    if (userMessageId) this.deps.setReplyToMessageId(key, userMessageId);
    await this.deps.adapter.sendChatAction?.(scope.conversationId, "typing", { topic: scope.topic }).catch((error) => {
      this.deps.logger.debug("router.chat_action_failed", {
        conversation_id: scope.conversationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    this.deps.logger.info("router.user_input_forwarded", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      workspace: workspace.name,
      session_key: key,
      text_len: input.text.length,
      image_count: input.images?.length ?? 0,
      attachment_count: input.attachments?.length ?? 0,
    });
    this.deps.logger.debug("router.user_input_text", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      workspace: workspace.name,
      session_key: key,
      message_text: input.text,
    });
    this.deps.store.appendTranscript({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      workspaceName: workspace.name,
      role: "user",
      text: transcriptTextForInput(input),
      createdAt: Date.now(),
    });
    let result: Awaited<ReturnType<AgentDriver["send"]>>;
    try {
      // Collaboration mode is stored per relay session so Plan mode survives
      // callbacks and prompt submissions without changing the agent interface.
      const mode = this.deps.store.getCollaborationMode(key);
      const sendOptions: AgentSendOptions = {
        collaborationMode: mode,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      };
      result = await this.deps.agent.send(key, input.text, Object.keys(sendOptions).length > 0 ? sendOptions : undefined);
    } catch (error) {
      if (task) {
        this.updateTaskStatus(task.id, "failed", task.turnId);
        await this.syncTaskReaction(task.id);
      }
      throw error;
    }
    if (task && result.turnId) {
      const previousStatus = this.deps.store.getTask(task.id)?.status;
      this.deps.store.updateTask(task.id, { turnId: result.turnId, status: "running" });
      this.logTaskStatus(task.id, "running", result.turnId);
      if (previousStatus !== "running") await this.syncTaskReaction(task.id);
    }
  }

  async sendWaitingPromptNotice(conversationId: ConversationId, status: AgentSessionStatus): Promise<boolean> {
    if (status.waitingForUserInput) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is waiting for your answer.", "Open the latest question card or reply to it. Direct messages are not submitted as answers; send /interrupt if the question expired."));
      return true;
    }
    if (status.waitingForApproval) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is waiting for approval.", "Use the approval buttons before sending another instruction. Direct messages are not submitted while approval is pending; send /interrupt to stop the blocked turn."));
      return true;
    }
    return false;
  }

  private async syncTaskReaction(taskId: number): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task?.userMessageId) return;
    await this.trySetMessageReaction({
      conversationId: task.conversationId,
      messageId: task.userMessageId,
      emoji: reactionForTaskStatus(task.status),
      phase: "status",
      taskId: task.id,
      status: task.status,
    });
  }

  private async trySetMessageReaction(input: {
    conversationId: ConversationId;
    messageId?: MessageId;
    emoji?: string;
    phase: "received" | "status";
    taskId?: number;
    status?: RelayTask["status"];
    options?: MessageReactionOptions;
  }): Promise<boolean> {
    if (!input.messageId || !this.deps.adapter.setMessageReaction) return false;
    try {
      await this.deps.adapter.setMessageReaction(input.conversationId, input.messageId, input.emoji, input.options);
      this.deps.logger.info("router.task_reaction_applied", {
        conversation_id: input.conversationId,
        message_id: input.messageId,
        emoji: input.emoji,
        phase: input.phase,
        task_id: input.taskId,
        status: input.status,
      });
      return true;
    } catch (error) {
      this.deps.logger.warn("router.task_reaction_failed", {
        conversation_id: input.conversationId,
        message_id: input.messageId,
        emoji: input.emoji,
        phase: input.phase,
        task_id: input.taskId,
        status: input.status,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  }

  private updateTaskStatus(taskId: number, status: RelayTask["status"], turnId?: string): void {
    this.deps.store.updateTask(taskId, { status, ...(turnId ? { turnId } : {}) });
    this.logTaskStatus(taskId, status, turnId);
  }

  private logTaskStatus(taskId: number, status: RelayTask["status"], turnId?: string): void {
    this.deps.logger.info("router.task_status_changed", {
      task_id: taskId,
      status,
      turn_id: turnId,
    });
  }
}

function hasStructuredInput(input: AgentTaskInput | undefined): input is AgentTaskInput {
  return Boolean(input && ((input.attachments?.length ?? 0) > 0 || (input.images?.length ?? 0) > 0));
}
