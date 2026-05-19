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
import type { RelayStore } from "./store.ts";

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

  bindConversation(conversationId: ConversationId, workspaceName: string, updatedAt = Date.now()): void {
    this.repositories.bindings.bind(conversationId, workspaceName, updatedAt);
  }

  getBinding(conversationId: ConversationId): ConversationBinding | undefined {
    return this.repositories.bindings.get(conversationId);
  }

  clearBinding(conversationId: ConversationId): void {
    this.repositories.bindings.clear(conversationId);
  }

  clearBindingsForWorkspace(workspaceName: string): void {
    this.repositories.bindings.clearForWorkspace(workspaceName);
  }

  markSessionStarted(sessionKey: string, conversationId: ConversationId, workspaceName: string, startedAt = Date.now(), threadId?: string): void {
    this.repositories.sessions.markStarted(sessionKey, conversationId, workspaceName, startedAt, threadId);
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

  getSession(sessionKey: string): AgentSessionRow | undefined {
    return this.repositories.sessions.get(sessionKey);
  }

  listRunningSessions(): AgentSessionRow[] {
    return this.repositories.sessions.listRunning();
  }

  appendTranscript(event: TranscriptEvent): void {
    this.repositories.transcripts.append(event);
  }

  latestTranscriptEvent(conversationId: ConversationId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined {
    return this.repositories.transcripts.latest(conversationId, workspaceName, role);
  }

  setPendingPrompt(prompt: PendingPrompt): void {
    this.repositories.prompts.set(prompt);
  }

  getPendingPrompt(conversationId: ConversationId, promptMessageId: MessageId): PendingPrompt | undefined {
    return this.repositories.prompts.get(conversationId, promptMessageId);
  }

  latestPendingPrompt(conversationId: ConversationId, kinds: PendingPrompt["kind"][] = [], now = Date.now()): PendingPrompt | undefined {
    return this.repositories.prompts.latest(conversationId, kinds, now);
  }

  deletePendingPrompt(conversationId: ConversationId, promptMessageId: MessageId): void {
    this.repositories.prompts.delete(conversationId, promptMessageId);
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

  prunePagedOutputs(now = Date.now()): void {
    this.repositories.pagedOutputs.prune(now);
  }

  getConsoleMessageId(conversationId: ConversationId): MessageId | undefined {
    return this.repositories.chatUi.getConsoleMessageId(conversationId);
  }

  setConsoleMessageId(conversationId: ConversationId, messageId: MessageId): void {
    this.repositories.chatUi.setConsoleMessageId(conversationId, messageId);
  }

  getHomeStatusMode(conversationId: ConversationId): HomeStatusMode {
    return this.repositories.chatUi.getHomeStatusMode(conversationId);
  }

  setHomeStatusMode(conversationId: ConversationId, mode: HomeStatusMode): void {
    this.repositories.chatUi.setHomeStatusMode(conversationId, mode);
  }

  createTask(task: {
    conversationId: ConversationId;
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
