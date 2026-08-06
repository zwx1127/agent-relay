import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { noopLogger, type Logger } from "../domain/logger.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../ports/agent.ts";
import type {
  ConversationBinding,
  HomeStatusMode,
  PendingPrompt,
  RelayTask,
  TaskStatus,
  TranscriptEvent,
  TranscriptRole,
  WorkspaceRecord,
} from "../relay/types.ts";
import type { AgentSessionRow, PagedOutput } from "./sqlite-rows.ts";
import { createSQLiteRepositories, type SQLiteRepositories } from "./sqlite-repositories.ts";
import { migrateSQLiteSchema } from "./sqlite-schema.ts";
import type { ControlMessageRecord, RelayStore } from "./store.ts";

export class SQLiteStore implements RelayStore {
  readonly db: Database;
  private readonly repositories: SQLiteRepositories;

  constructor(path: string, private readonly logger: Logger = noopLogger) {
    const absolutePath = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new Database(absolutePath);
    if (path !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.repositories = createSQLiteRepositories(this.db, this.logger);
    this.migrate();
    this.logger.info("store.opened", { path: absolutePath });
  }

  close(): void {
    this.db.close();
    this.logger.info("store.closed");
  }

  migrate(): void {
    migrateSQLiteSchema(this.db, this.logger);
  }

  upsertWorkspace(record: WorkspaceRecord): void {
    this.repositories.workspaces.upsert(record);
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.repositories.workspaces.list();
  }

  getWorkspace(name: string): WorkspaceRecord | undefined {
    return this.repositories.workspaces.get(name);
  }

  deleteWorkspace(name: string): void {
    this.repositories.workspaces.delete(name);
  }

  bindConversation(scopeKey: ConversationId, workspaceName: string, updatedAt = Date.now(), conversationId?: ConversationId): void {
    this.repositories.bindings.bind(scopeKey, workspaceName, updatedAt, conversationId);
  }

  getBinding(scopeKey: ConversationId): ConversationBinding | undefined {
    return this.repositories.bindings.get(scopeKey);
  }

  clearBinding(scopeKey: ConversationId): void {
    this.repositories.bindings.clear(scopeKey);
  }

  clearBindingsForWorkspace(workspaceName: string): void {
    this.repositories.bindings.clearForWorkspace(workspaceName);
  }

  markSessionStarted(sessionKey: string, conversationId: ConversationId, workspaceName: string, startedAt = Date.now(), threadId?: string, scopeKey?: string): void {
    this.repositories.sessions.markStarted(sessionKey, conversationId, workspaceName, startedAt, threadId, scopeKey);
  }

  markSessionStopped(sessionKey: string, stoppedAt = Date.now()): void {
    this.repositories.sessions.markStopped(sessionKey, stoppedAt);
  }

  clearSessionThreadId(sessionKey: string): void {
    this.repositories.sessions.clearThreadId(sessionKey);
  }

  setSessionThreadId(sessionKey: string, threadId: string): void {
    this.repositories.sessions.setThreadId(sessionKey, threadId);
  }

  getCollaborationMode(sessionKey: string): AgentCollaborationMode {
    return this.repositories.sessions.getCollaborationMode(sessionKey);
  }

  setCollaborationMode(sessionKey: string, mode: AgentCollaborationMode): void {
    this.repositories.sessions.setCollaborationMode(sessionKey, mode);
  }

  requestCollaborationMode(sessionKey: string, mode: AgentCollaborationMode): void {
    this.repositories.sessions.requestCollaborationMode(sessionKey, mode);
  }

  getPendingCollaborationMode(sessionKey: string): AgentCollaborationMode | undefined {
    return this.repositories.sessions.getPendingCollaborationMode(sessionKey);
  }

  clearPendingCollaborationMode(sessionKey: string, expectedMode: AgentCollaborationMode): void {
    this.repositories.sessions.clearPendingCollaborationMode(sessionKey, expectedMode);
  }

  getSession(sessionKey: string): AgentSessionRow | undefined {
    return this.repositories.sessions.get(sessionKey);
  }

  listRunningSessions(): AgentSessionRow[] {
    return this.repositories.sessions.listRunning();
  }

  appendTranscript(event: TranscriptEvent): void {
    this.repositories.transcripts.append(event);
  }

  clearTranscript(scopeKey: ConversationId, workspaceName: string): void {
    this.repositories.transcripts.clear(scopeKey, workspaceName);
  }

  latestTranscriptEvent(scopeKey: ConversationId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined {
    return this.repositories.transcripts.latest(scopeKey, workspaceName, role);
  }

  setPendingPrompt(prompt: PendingPrompt): void {
    this.repositories.prompts.set(prompt);
    const scopeKey = prompt.scopeKey ?? String(prompt.conversationId);
    this.repositories.chatUi.setControlMessage(prompt.conversationId, prompt.promptMessageId, scopeKey, prompt.kind);
  }

  getPendingPrompt(scopeKey: ConversationId, promptMessageId: MessageId): PendingPrompt | undefined {
    return this.repositories.prompts.get(scopeKey, promptMessageId);
  }

  latestPendingPrompt(scopeKey: ConversationId, kinds: PendingPrompt["kind"][] = [], now = Date.now()): PendingPrompt | undefined {
    return this.repositories.prompts.latest(scopeKey, kinds, now);
  }

  deletePendingPrompt(scopeKey: ConversationId, promptMessageId: MessageId): void {
    this.repositories.prompts.delete(scopeKey, promptMessageId);
  }

  deletePendingPromptsForSession(sessionKey: string, kinds: PendingPrompt["kind"][] = []): number {
    return this.repositories.prompts.deleteForSession(sessionKey, kinds);
  }

  setPagedOutput(output: PagedOutput): void {
    this.repositories.pagedOutputs.set(output);
  }

  getPagedOutput(token: string): PagedOutput | undefined {
    return this.repositories.pagedOutputs.get(token);
  }

  deletePagedOutput(token: string): void {
    this.repositories.pagedOutputs.delete(token);
  }

  deletePagedOutputsForSession(sessionKey: string): void {
    this.repositories.pagedOutputs.deleteForSession(sessionKey);
  }

  prunePagedOutputs(now = Date.now()): void {
    this.repositories.pagedOutputs.prune(now);
  }

  getConsoleMessageId(scopeKey: ConversationId): MessageId | undefined {
    return this.repositories.chatUi.getConsoleMessageId(scopeKey);
  }

  setConsoleMessageId(scopeKey: ConversationId, messageId: MessageId, conversationId?: ConversationId): void {
    this.repositories.chatUi.setConsoleMessageId(scopeKey, messageId, conversationId);
  }

  getHomeStatusMode(scopeKey: ConversationId): HomeStatusMode {
    return this.repositories.chatUi.getHomeStatusMode(scopeKey);
  }

  setHomeStatusMode(scopeKey: ConversationId, mode: HomeStatusMode, conversationId?: ConversationId): void {
    this.repositories.chatUi.setHomeStatusMode(scopeKey, mode, conversationId);
  }

  setControlMessage(conversationId: ConversationId, messageId: MessageId, scopeKey: string, kind?: string): void {
    this.repositories.chatUi.setControlMessage(conversationId, messageId, scopeKey, kind);
  }

  getControlMessageScopeKey(conversationId: ConversationId, messageId: MessageId): string | undefined {
    return this.repositories.chatUi.getControlMessageScopeKey(conversationId, messageId);
  }

  getControlMessage(conversationId: ConversationId, messageId: MessageId): ControlMessageRecord | undefined {
    return this.repositories.chatUi.getControlMessage(conversationId, messageId);
  }

  createTask(task: {
    conversationId: ConversationId;
    scopeKey?: string;
    workspaceName: string;
    text: string;
    input?: AgentTaskInput;
    status: TaskStatus;
    createdAt?: number;
    userMessageId?: MessageId;
  }): RelayTask {
    return this.repositories.tasks.create(task);
  }

  getTask(id: number): RelayTask | undefined {
    return this.repositories.tasks.get(id);
  }

  listTasks(conversationId: ConversationId, workspaceName: string, statuses?: TaskStatus[], limit = 20): RelayTask[] {
    return this.repositories.tasks.list(conversationId, workspaceName, statuses, limit);
  }

  nextQueuedTask(conversationId: ConversationId, workspaceName: string): RelayTask | undefined {
    return this.repositories.tasks.nextQueued(conversationId, workspaceName);
  }

  activeTask(conversationId: ConversationId, workspaceName: string): RelayTask | undefined {
    return this.repositories.tasks.active(conversationId, workspaceName);
  }

  updateTask(id: number, updates: { status?: TaskStatus; turnId?: string | null; statusMessageId?: MessageId | null }): void {
    this.repositories.tasks.update(id, updates);
  }

  updateTasksByTurn(conversationId: ConversationId, workspaceName: string, turnId: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    return this.repositories.tasks.updateByTurn(conversationId, workspaceName, turnId, fromStatuses, status);
  }

  updateActiveTasks(conversationId: ConversationId, workspaceName: string, status: TaskStatus): RelayTask[] {
    return this.repositories.tasks.updateActive(conversationId, workspaceName, status);
  }

  updateTasksByStatus(conversationId: ConversationId, workspaceName: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    return this.repositories.tasks.updateByStatus(conversationId, workspaceName, fromStatuses, status);
  }

  countTasks(conversationId: ConversationId, workspaceName: string, statuses: TaskStatus[]): number {
    return this.repositories.tasks.count(conversationId, workspaceName, statuses);
  }
}
