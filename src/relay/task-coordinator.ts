import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../domain/session.ts";
import type { Logger } from "../domain/logger.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentSendOptions, AgentSessionStatus, AgentTaskInput } from "../ports/agent.ts";
import type { ImAdapter, SendMessageOptions } from "../ports/im.ts";
import type { RelayStore } from "../storage/store.ts";
import type { RelayTask, WorkspaceRecord } from "./types.ts";
import { reactionForTaskStatus, taskInputFromTask, transcriptTextForInput } from "./tasks/input.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";

export type TaskSubmitPreference = "auto" | "immediate" | "queue";

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
    const taskInput = input ?? { text };
    const workspace = this.deps.currentWorkspace(conversationId);
    if (!workspace) {
      await this.deps.renderConsole(conversationId);
      return;
    }
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (await this.sendWaitingPromptNotice(conversationId, status)) return;
    const busy = Boolean(status.activeTurnId);
    if (preference === "auto" && busy) {
      await this.sendToAgent(conversationId, workspace, taskInput, userMessageId, this.deps.store.activeTask(conversationId, workspace.name));
      return;
    }
    const shouldQueue = preference === "queue";
    const task = this.deps.store.createTask({
      conversationId,
      workspaceName: workspace.name,
      text,
      input: input && input.images?.length ? input : undefined,
      status: shouldQueue ? "queued" : "running",
      userMessageId,
    });
    if (shouldQueue) {
      await this.syncTaskReaction(task.id);
      return;
    }
    await this.runTask(workspace, task);
  }

  async markActive(sessionKeyValue: string, status: "blocked" | "running"): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const task = this.deps.store.activeTask(parsed.conversationId, parsed.workspaceName);
    if (!task) return;
    this.deps.store.updateTask(task.id, { status });
    await this.syncTaskReaction(task.id);
  }

  async completeAndDispatchNext(sessionKeyValue: string, turnId: string | undefined): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    if (!parsed) return;
    const active = this.deps.store.activeTask(parsed.conversationId, parsed.workspaceName);
    if (active && (!turnId || !active.turnId || active.turnId === turnId)) {
      this.deps.store.updateTask(active.id, { status: "done" });
      await this.syncTaskReaction(active.id);
    }
    const workspace = this.deps.currentWorkspace(parsed.conversationId);
    if (!workspace || workspace.name !== parsed.workspaceName) return;
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (status?.waitingForApproval || status?.waitingForUserInput || status?.activeTurnId) return;
    const next = this.deps.store.nextQueuedTask(parsed.conversationId, parsed.workspaceName);
    if (next) {
      await this.runTask(workspace, next);
    }
  }

  private async runTask(workspace: WorkspaceRecord, task: RelayTask): Promise<void> {
    this.deps.store.updateTask(task.id, { status: "running" });
    await this.syncTaskReaction(task.id);
    await this.sendToAgent(task.conversationId, workspace, taskInputFromTask(task), task.userMessageId, task);
  }

  private async sendToAgent(conversationId: ConversationId, workspace: WorkspaceRecord, input: AgentTaskInput, userMessageId?: MessageId, task?: RelayTask): Promise<void> {
    const key = sessionKey(conversationId, workspace.name);
    await this.deps.finalizeSessionOutput(key);
    if (userMessageId) this.deps.setReplyToMessageId(key, userMessageId);
    await this.deps.adapter.sendChatAction?.(conversationId, "typing").catch((error) => {
      this.deps.logger.debug("router.chat_action_failed", {
        conversation_id: conversationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    this.deps.logger.info("router.user_input_forwarded", {
      conversation_id: conversationId,
      workspace: workspace.name,
      session_key: key,
      text_len: input.text.length,
      image_count: input.images?.length ?? 0,
    });
    this.deps.logger.debug("router.user_input_text", {
      conversation_id: conversationId,
      workspace: workspace.name,
      session_key: key,
      message_text: input.text,
    });
    this.deps.store.appendTranscript({
      conversationId,
      workspaceName: workspace.name,
      role: "user",
      text: transcriptTextForInput(input),
      createdAt: Date.now(),
    });
    let result: Awaited<ReturnType<AgentDriver["send"]>>;
    try {
      const mode = this.deps.store.getCollaborationMode(key);
      const sendOptions: AgentSendOptions = {
        ...(mode === "plan" ? { collaborationMode: "plan" as const } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      };
      result = await this.deps.agent.send(key, input.text, Object.keys(sendOptions).length > 0 ? sendOptions : undefined);
    } catch (error) {
      if (task) {
        this.deps.store.updateTask(task.id, { status: "failed" });
        await this.syncTaskReaction(task.id);
      }
      throw error;
    }
    if (task && result.turnId) this.deps.store.updateTask(task.id, { turnId: result.turnId, status: "running" });
  }

  async sendWaitingPromptNotice(conversationId: ConversationId, status: AgentSessionStatus): Promise<boolean> {
    if (status.waitingForUserInput) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is waiting for your answer.", "Open the latest question card or reply to it. New prompts are paused while the active turn is blocked."));
      return true;
    }
    if (status.waitingForApproval) {
      await this.deps.sendRendered(conversationId, messageWithTitle("Codex is waiting for approval.", "Use the approval buttons before sending another instruction."));
      return true;
    }
    return false;
  }

  private async syncTaskReaction(taskId: number): Promise<void> {
    const task = this.deps.store.getTask(taskId);
    if (!task?.userMessageId) return;
    if (!this.deps.adapter.setMessageReaction) return;
    try {
      await this.deps.adapter.setMessageReaction(task.conversationId, task.userMessageId, reactionForTaskStatus(task.status));
    } catch (error) {
      this.deps.logger.warn("router.task_reaction_failed", {
        conversation_id: task.conversationId,
        task_id: task.id,
        message_id: task.userMessageId,
        status: task.status,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
