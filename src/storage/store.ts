import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../ports/agent.ts";
import type { ConversationBinding, HomeStatusMode, PendingPrompt, RelayTask, TaskStatus, TranscriptEvent, TranscriptRole, WorkspaceRecord } from "../relay/types.ts";
import type { AgentSessionRow, PagedOutput } from "./sqlite-rows.ts";

export interface ControlMessageRecord {
  scopeKey: string;
  kind?: string;
}

export interface RelayStore {
  close(): void;
  migrate(): void;
  upsertWorkspace(record: WorkspaceRecord): void;
  listWorkspaces(): WorkspaceRecord[];
  getWorkspace(name: string): WorkspaceRecord | undefined;
  deleteWorkspace(name: string): void;
  bindConversation(scopeKey: ConversationId, workspaceName: string, updatedAt?: number, conversationId?: ConversationId): void;
  getBinding(scopeKey: ConversationId): ConversationBinding | undefined;
  clearBinding(scopeKey: ConversationId): void;
  clearBindingsForWorkspace(workspaceName: string): void;
  markSessionStarted(sessionKey: string, conversationId: ConversationId, workspaceName: string, startedAt?: number, threadId?: string, scopeKey?: string): void;
  markSessionStopped(sessionKey: string, stoppedAt?: number): void;
  clearSessionThreadId(sessionKey: string): void;
  setSessionThreadId(sessionKey: string, threadId: string): void;
  getCollaborationMode(sessionKey: string): AgentCollaborationMode;
  setCollaborationMode(sessionKey: string, mode: AgentCollaborationMode): void;
  getSession(sessionKey: string): AgentSessionRow | undefined;
  findSessionByThreadId(threadId: string, excludingSessionKey: string): AgentSessionRow | undefined;
  listRunningSessions(): AgentSessionRow[];
  appendTranscript(event: TranscriptEvent): void;
  clearTranscript(scopeKey: ConversationId, workspaceName: string): void;
  latestTranscriptEvent(scopeKey: ConversationId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined;
  setPendingPrompt(prompt: PendingPrompt): void;
  getPendingPrompt(scopeKey: ConversationId, promptMessageId: MessageId): PendingPrompt | undefined;
  latestPendingPrompt(scopeKey: ConversationId, kinds?: PendingPrompt["kind"][], now?: number): PendingPrompt | undefined;
  deletePendingPrompt(scopeKey: ConversationId, promptMessageId: MessageId): void;
  deletePendingPromptsForSession(sessionKey: string, kinds?: PendingPrompt["kind"][]): number;
  setPagedOutput(output: PagedOutput): void;
  getPagedOutput(token: string): PagedOutput | undefined;
  deletePagedOutput(token: string): void;
  deletePagedOutputsForSession(sessionKey: string): void;
  prunePagedOutputs(now?: number): void;
  getConsoleMessageId(scopeKey: ConversationId): MessageId | undefined;
  setConsoleMessageId(scopeKey: ConversationId, messageId: MessageId, conversationId?: ConversationId): void;
  getHomeStatusMode(scopeKey: ConversationId): HomeStatusMode;
  setHomeStatusMode(scopeKey: ConversationId, mode: HomeStatusMode, conversationId?: ConversationId): void;
  setControlMessage(conversationId: ConversationId, messageId: MessageId, scopeKey: string, kind?: string): void;
  getControlMessage(conversationId: ConversationId, messageId: MessageId): ControlMessageRecord | undefined;
  getControlMessageScopeKey(conversationId: ConversationId, messageId: MessageId): string | undefined;
  createTask(task: {
    conversationId: ConversationId;
    scopeKey?: string;
    workspaceName: string;
    text: string;
    input?: AgentTaskInput;
    status: TaskStatus;
    createdAt?: number;
    userMessageId?: MessageId;
  }): RelayTask;
  getTask(id: number): RelayTask | undefined;
  listTasks(scopeKey: ConversationId, workspaceName: string, statuses?: TaskStatus[], limit?: number): RelayTask[];
  nextQueuedTask(scopeKey: ConversationId, workspaceName: string): RelayTask | undefined;
  activeTask(scopeKey: ConversationId, workspaceName: string): RelayTask | undefined;
  updateTask(id: number, updates: { status?: TaskStatus; turnId?: string | null; statusMessageId?: MessageId | null }): void;
  updateTasksByTurn(scopeKey: ConversationId, workspaceName: string, turnId: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[];
  updateActiveTasks(scopeKey: ConversationId, workspaceName: string, status: TaskStatus): RelayTask[];
  updateTasksByStatus(scopeKey: ConversationId, workspaceName: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[];
  countTasks(scopeKey: ConversationId, workspaceName: string, statuses: TaskStatus[]): number;
}
