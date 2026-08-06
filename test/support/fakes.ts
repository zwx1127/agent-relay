import { sessionKey } from "../../src/domain/session.ts";
import type { ConversationId, MessageId } from "../../src/domain/ids.ts";
import type { AgentBackgroundTerminalSummary, AgentBuiltinCommand, AgentBuiltinResult, AgentDriver, AgentDriverCapabilities, AgentFileSearchOptions, AgentFileSearchResult, AgentInterruptResult, AgentModelSummary, AgentSendOptions, AgentSessionStatus, AgentSkillListOptions, AgentSkillSummary, AgentThreadGoal, AgentThreadGoalSetOptions, AgentThreadListOptions, AgentThreadSummary, AgentTurnSnapshot } from "../../src/ports/agent.ts";
import type { EditMessageTextOptions, MessageReactionOptions, SendMessageOptions } from "../../src/ports/im.ts";

export class FakeImAdapter {
  readonly providerId = "fake";
  readonly capabilities = {
    editMessage: true,
    forceReply: true,
    inlineActions: true,
    reactions: true,
    typing: true,
    mediaDownload: true,
    imageUpload: true,
    fileUpload: true,
  };
  sent: Array<{ conversationId: ConversationId; text: string; options?: SendMessageOptions; messageId?: number }> = [];
  photos: Array<{ conversationId: ConversationId; photo: Blob; options?: unknown; messageId?: number }> = [];
  files: Array<{ conversationId: ConversationId; file: Blob; options?: unknown; messageId?: number }> = [];
  edited: Array<{ conversationId: ConversationId; text: string; options: EditMessageTextOptions }> = [];
  deleted: Array<{ conversationId: ConversationId; messageId: MessageId }> = [];
  answered: Array<{ callbackQueryId: string; text?: string }> = [];
  chatActions: Array<{ conversationId: ConversationId; action?: "typing"; options?: { topic?: SendMessageOptions["topic"] } }> = [];
  reactions: Array<{ conversationId: ConversationId; messageId: MessageId; emoji?: string; options?: MessageReactionOptions }> = [];
  downloads = new Map<string, ArrayBuffer>();
  nextMessageId = 100;
  sendMessageDelayMs = 0;
  editMessageWaits: Promise<void>[] = [];
  editStarted: Array<{ conversationId: ConversationId; text: string; options: EditMessageTextOptions }> = [];
  failSendMessage?: Error;
  failEditMessage?: Error;
  failDeleteMessage?: Error;
  failReaction?: Error;

  async sendMessage(conversationId: ConversationId, text: string, options?: SendMessageOptions): Promise<{ messageId?: number }> {
    if (this.sendMessageDelayMs > 0) await sleep(this.sendMessageDelayMs);
    if (this.failSendMessage) throw this.failSendMessage;
    const messageId = this.nextMessageId++;
    this.sent.push({ conversationId, text, options, messageId });
    return { messageId };
  }

  async sendPhoto(conversationId: ConversationId, photo: Blob, options?: unknown): Promise<{ messageId?: number }> {
    const messageId = this.nextMessageId++;
    this.photos.push({ conversationId, photo, options, messageId });
    return { messageId };
  }

  async sendFile(conversationId: ConversationId, file: Blob, options?: unknown): Promise<{ messageId?: number }> {
    const messageId = this.nextMessageId++;
    this.files.push({ conversationId, file, options, messageId });
    return { messageId };
  }

  async downloadFile(fileId: string, options: { kind?: "image" | "file"; messageId?: MessageId } = {}): Promise<{ bytes: ArrayBuffer; filePath?: string; fileName?: string; fileSize?: number }> {
    const kind = options.kind ?? "image";
    return {
      bytes: this.downloads.get(fileId) ?? new TextEncoder().encode(kind).buffer,
      filePath: kind === "image" ? "photos/image.jpg" : "documents/file.txt",
      ...(kind === "file" ? { fileName: "file.txt" } : {}),
    };
  }

  async editMessageText(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void> {
    if (this.failEditMessage) throw this.failEditMessage;
    this.editStarted.push({ conversationId, text, options });
    const wait = this.editMessageWaits.shift();
    if (wait) await wait;
    this.edited.push({ conversationId, text, options });
  }

  async deleteMessage(conversationId: ConversationId, messageId: MessageId): Promise<void> {
    if (this.failDeleteMessage) throw this.failDeleteMessage;
    this.deleted.push({ conversationId, messageId });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answered.push({ callbackQueryId, text });
  }

  async sendChatAction(conversationId: ConversationId, action?: "typing", options?: { topic?: SendMessageOptions["topic"] }): Promise<void> {
    this.chatActions.push({ conversationId, action, ...(options ? { options } : {}) });
  }

  async setMessageReaction(conversationId: ConversationId, messageId: MessageId, emoji?: string, options?: MessageReactionOptions): Promise<void> {
    if (this.failReaction) throw this.failReaction;
    this.reactions.push({ conversationId, messageId, emoji, ...(options ? { options } : {}) });
  }
}

export class FakeAgent implements AgentDriver {
  capabilities?: Partial<AgentDriverCapabilities>;
  statuses = new Map<string, AgentSessionStatus>();
  sent: Array<{ key: string; text: string; options?: AgentSendOptions }> = [];
  stopped: string[] = [];
  released: string[] = [];
  interrupted: Array<{ key: string; turnId?: string }> = [];
  responses: Array<{ key: string; requestId: string | number; result: unknown }> = [];
  builtins: Array<{ key: string; command: AgentBuiltinCommand }> = [];
  forks: string[] = [];
  sideConversations: Array<{ key: string; text: string }> = [];
  renames: Array<{ key: string; name: string }> = [];
  archived: string[] = [];
  deleted: string[] = [];
  goalGets: string[] = [];
  goalSets: Array<{ key: string; goal: AgentThreadGoalSetOptions }> = [];
  goalClears: string[] = [];
  goal: AgentThreadGoal | null = null;
  cleaned: string[] = [];
  terminated: Array<{ key: string; processId: string }> = [];
  backgroundTerminals: AgentBackgroundTerminalSummary[] = [];
  threadLists: AgentThreadListOptions[] = [];
  threads: AgentThreadSummary[] = [];
  models: AgentModelSummary[] = [];
  skills: AgentSkillSummary[] = [];
  skillLists: Array<{ workspacePath: string; options?: AgentSkillListOptions }> = [];
  fileSearchResults: AgentFileSearchResult[] = [];
  fileSearches: Array<{ workspacePath: string; query: string; options?: AgentFileSearchOptions }> = [];
  failSend?: Error;
  staleInterrupt = false;
  failStartForThreadIds = new Map<string, Error>();
  resumeSnapshots = new Map<string, AgentTurnSnapshot>();

  async start(options: { conversationId: ConversationId; scopeKey?: string; workspaceName: string; workspacePath: string; threadId?: string }): Promise<AgentSessionStatus> {
    if (options.threadId && this.failStartForThreadIds.has(options.threadId)) {
      throw this.failStartForThreadIds.get(options.threadId)!;
    }
    const scopeKey = options.scopeKey ?? String(options.conversationId);
    const key = sessionKey(scopeKey, options.workspaceName);
    const latestTurn = options.threadId ? this.resumeSnapshots.get(options.threadId) : undefined;
    const status: AgentSessionStatus = {
      sessionKey: key,
      conversationId: options.conversationId,
      scopeKey,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: 1,
      threadId: options.threadId ?? `thread-${this.statuses.size + 1}`,
      ...(latestTurn ? { latestTurn } : {}),
      ...(latestTurn?.status === "inProgress" ? { activeTurnId: latestTurn.id } : {}),
    };
    this.statuses.set(key, status);
    return status;
  }

  async send(key: string, text: string, options?: AgentSendOptions): Promise<{ turnId?: string }> {
    if (this.failSend) throw this.failSend;
    this.sent.push({ key, text, ...(options ? { options } : {}) });
    const status = this.statuses.get(key);
    if (status?.activeTurnId) return { turnId: status.activeTurnId };
    const turnId = `turn-${this.sent.length}`;
    if (status) status.activeTurnId = turnId;
    return { turnId };
  }

  async stop(key: string): Promise<void> {
    this.stopped.push(key);
    this.statuses.delete(key);
  }

  async interrupt(key: string): Promise<AgentInterruptResult> {
    const status = this.statuses.get(key);
    const turnId = status?.activeTurnId;
    this.interrupted.push({ key, ...(turnId ? { turnId } : {}) });
    if (this.staleInterrupt && status && turnId) {
      status.activeTurnId = undefined;
      status.waitingForApproval = false;
      status.waitingForUserInput = false;
      return { interrupted: false, turnId, stale: true };
    }
    if (!status || !turnId) {
      if (status) {
        status.waitingForApproval = false;
        status.waitingForUserInput = false;
      }
      return { interrupted: false };
    }
    status.activeTurnId = undefined;
    status.waitingForApproval = false;
    status.waitingForUserInput = false;
    return { interrupted: true, turnId };
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.statuses.get(key);
  }

  async respond(key: string, requestId: string | number, result: unknown): Promise<void> {
    this.responses.push({ key, requestId, result });
    const status = this.statuses.get(key);
    if (status) {
      status.waitingForApproval = false;
      status.waitingForUserInput = false;
    }
  }

  async runBuiltinCommand(key: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult> {
    this.builtins.push({ key, command });
    return { message: command.type === "review" ? "Review started." : "Compaction started." };
  }

  async getThreadGoal(key: string): Promise<AgentThreadGoal | null> {
    this.goalGets.push(key);
    const status = this.statuses.get(key);
    if (status) status.threadGoal = this.goal;
    return this.goal;
  }

  async release(key: string): Promise<void> {
    this.released.push(key);
    this.statuses.delete(key);
  }

  async setThreadGoal(key: string, goal: AgentThreadGoalSetOptions): Promise<AgentThreadGoal> {
    this.goalSets.push({ key, goal });
    this.goal = {
      threadId: this.statuses.get(key)?.threadId ?? "thread-1",
      objective: goal.objective ?? this.goal?.objective ?? "Existing goal",
      status: goal.status ?? this.goal?.status ?? "active",
      tokenBudget: goal.tokenBudget === undefined ? this.goal?.tokenBudget ?? null : goal.tokenBudget,
      tokensUsed: this.goal?.tokensUsed ?? 0,
      timeUsedSeconds: this.goal?.timeUsedSeconds ?? 0,
      createdAt: this.goal?.createdAt ?? 1,
      updatedAt: 2,
    };
    const status = this.statuses.get(key);
    if (status) status.threadGoal = this.goal;
    return this.goal;
  }

  async clearThreadGoal(key: string): Promise<boolean> {
    this.goalClears.push(key);
    const cleared = Boolean(this.goal);
    this.goal = null;
    const status = this.statuses.get(key);
    if (status) status.threadGoal = null;
    return cleared;
  }

  async forkThread(key: string): Promise<{ threadId: string; threadName?: string }> {
    this.forks.push(key);
    const status = this.statuses.get(key);
    if (status) {
      status.threadId = "fork-thread";
      status.threadName = "Forked";
    }
    return { threadId: "fork-thread", threadName: "Forked" };
  }

  async sideConversation(key: string, text: string): Promise<{ message: string; threadId?: string; turnId?: string }> {
    this.sideConversations.push({ key, text });
    return { message: `side: ${text}`, threadId: "side-thread", turnId: "side-turn" };
  }

  async renameThread(key: string, name: string): Promise<void> {
    this.renames.push({ key, name });
    const status = this.statuses.get(key);
    if (status) status.threadName = name;
  }

  async archiveThread(key: string): Promise<void> {
    this.archived.push(key);
  }

  async deleteThread(key: string): Promise<void> {
    this.deleted.push(key);
  }

  async cleanBackgroundTerminals(key: string): Promise<void> {
    this.cleaned.push(key);
    this.backgroundTerminals = [];
  }

  async listBackgroundTerminals(_key: string): Promise<AgentBackgroundTerminalSummary[]> {
    return this.backgroundTerminals;
  }

  async terminateBackgroundTerminal(key: string, processId: string): Promise<boolean> {
    this.terminated.push({ key, processId });
    const found = this.backgroundTerminals.some((terminal) => terminal.processId === processId);
    this.backgroundTerminals = this.backgroundTerminals.filter((terminal) => terminal.processId !== processId);
    return found;
  }

  async listThreads(options: AgentThreadListOptions): Promise<AgentThreadSummary[]> {
    this.threadLists.push(options);
    return this.threads;
  }

  async listModels(): Promise<AgentModelSummary[]> {
    return this.models;
  }

  async listSkills(workspacePath: string, options?: AgentSkillListOptions): Promise<AgentSkillSummary[]> {
    this.skillLists.push({ workspacePath, ...(options ? { options } : {}) });
    return this.skills;
  }

  async searchFiles(workspacePath: string, query: string, options?: AgentFileSearchOptions): Promise<AgentFileSearchResult[]> {
    this.fileSearches.push({ workspacePath, query, ...(options ? { options } : {}) });
    return this.fileSearchResults;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
