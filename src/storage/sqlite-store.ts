import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { noopLogger, type Logger } from "../domain/logger.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../ports/agent.ts";
import type { ConversationBinding, HomeStatusMode, PendingPrompt, RelayTask, TaskStatus, TranscriptEvent, TranscriptRole, WorkspaceRecord } from "../relay/types.ts";
import { rowToPagedOutput, rowToPendingPrompt, rowToTask, rowToWorkspace, type AgentSessionRow, type BindingRow, type ChatUiStateRow, type PagedOutput, type PagedOutputRow, type PendingPromptRow, type TaskRow, type TranscriptRow, type WorkspaceRow } from "./sqlite-rows.ts";
import type { RelayStore } from "./store.ts";

export class SQLiteStore implements RelayStore {
  readonly db: Database;

  constructor(path: string, private readonly logger: Logger = noopLogger) {
    const absolutePath = resolve(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.db = new Database(absolutePath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.migrate();
    this.logger.info("store.opened", { path: absolutePath });
  }

  close(): void {
    this.db.close();
    this.logger.info("store.closed");
  }

  migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_bindings (
        conversation_id TEXT PRIMARY KEY,
        workspace_name TEXT NOT NULL REFERENCES workspaces(name),
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS transcript_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pending_prompts (
        conversation_id TEXT NOT NULL,
        prompt_message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, prompt_message_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS paged_outputs (
        token TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_ui_state (
        conversation_id TEXT PRIMARY KEY,
        console_message_id TEXT,
        home_status_mode TEXT NOT NULL DEFAULT 'compact'
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        text TEXT NOT NULL,
        input_json TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        turn_id TEXT,
        user_message_id TEXT
      )
    `);
    this.addColumnIfMissing("agent_sessions", "thread_id", "TEXT");
    this.addColumnIfMissing("agent_sessions", "collaboration_mode", "TEXT NOT NULL DEFAULT 'default'");
    this.addColumnIfMissing("pending_prompts", "session_key", "TEXT");
    this.addColumnIfMissing("pending_prompts", "payload_json", "TEXT");
    this.addColumnIfMissing("pending_prompts", "expires_at", "INTEGER");
    this.addColumnIfMissing("chat_ui_state", "home_status_mode", "TEXT NOT NULL DEFAULT 'compact'");
    this.addColumnIfMissing("tasks", "status_message_id", "TEXT");
    this.addColumnIfMissing("tasks", "input_json", "TEXT");
    this.recordMigration(1, "baseline");
    this.logger.debug("store.migrated");
  }

  upsertWorkspace(record: WorkspaceRecord): void {
    this.db.query(`
      INSERT INTO workspaces (name, path, created_at)
      VALUES ($name, $path, $createdAt)
      ON CONFLICT(name) DO UPDATE SET path = excluded.path
    `).run({ $name: record.name, $path: record.path, $createdAt: record.createdAt });
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.db.query<WorkspaceRow, []>("SELECT name, path, created_at FROM workspaces ORDER BY name").all().map(rowToWorkspace);
  }

  getWorkspace(name: string): WorkspaceRecord | undefined {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT name, path, created_at FROM workspaces WHERE name = ?").get(name);
    return row ? rowToWorkspace(row) : undefined;
  }

  deleteWorkspace(name: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM chat_bindings WHERE workspace_name = ?").run(name);
      this.db.query("DELETE FROM workspaces WHERE name = ?").run(name);
    })();
  }

  bindConversation(conversationId: ConversationId, workspaceName: string, updatedAt = Date.now()): void {
    this.db.query(`
      INSERT INTO chat_bindings (conversation_id, workspace_name, updated_at)
      VALUES ($conversationId, $workspaceName, $updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET workspace_name = excluded.workspace_name, updated_at = excluded.updated_at
    `).run({ $conversationId: String(conversationId), $workspaceName: workspaceName, $updatedAt: updatedAt });
  }

  getBinding(conversationId: ConversationId): ConversationBinding | undefined {
    const row = this.db.query<BindingRow, [string]>("SELECT conversation_id, workspace_name, updated_at FROM chat_bindings WHERE conversation_id = ?").get(String(conversationId));
    return row ? { conversationId: row.conversation_id, workspaceName: row.workspace_name, updatedAt: row.updated_at } : undefined;
  }

  clearBinding(conversationId: ConversationId): void {
    this.db.query("DELETE FROM chat_bindings WHERE conversation_id = ?").run(String(conversationId));
  }

  clearBindingsForWorkspace(workspaceName: string): void {
    this.db.query("DELETE FROM chat_bindings WHERE workspace_name = ?").run(workspaceName);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private recordMigration(version: number, name: string): void {
    this.db.query(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
      ON CONFLICT(version) DO NOTHING
    `).run(version, name, Date.now());
  }

  markSessionStarted(sessionKey: string, conversationId: ConversationId, workspaceName: string, startedAt = Date.now(), threadId?: string): void {
    this.db.query(`
      INSERT INTO agent_sessions (session_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id)
      VALUES ($sessionKey, $conversationId, $workspaceName, 'running', $startedAt, NULL, $threadId)
      ON CONFLICT(session_key) DO UPDATE SET
        status = 'running',
        started_at = excluded.started_at,
        stopped_at = NULL,
        thread_id = COALESCE(excluded.thread_id, agent_sessions.thread_id)
    `).run({ $sessionKey: sessionKey, $conversationId: String(conversationId), $workspaceName: workspaceName, $startedAt: startedAt, $threadId: threadId ?? null });
    this.logger.info("store.session_marked_started", { session_key: sessionKey, conversation_id: conversationId, workspace: workspaceName });
  }

  markSessionStopped(sessionKey: string, stoppedAt = Date.now()): void {
    this.db.query("UPDATE agent_sessions SET status = 'stopped', stopped_at = ? WHERE session_key = ?").run(stoppedAt, sessionKey);
    this.logger.info("store.session_marked_stopped", { session_key: sessionKey });
  }

  clearSessionThreadId(sessionKey: string): void {
    this.db.query("UPDATE agent_sessions SET thread_id = NULL, collaboration_mode = 'default' WHERE session_key = ?").run(sessionKey);
    this.logger.info("store.session_thread_cleared", { session_key: sessionKey });
  }

  setSessionThreadId(sessionKey: string, threadId: string): void {
    this.db.query("UPDATE agent_sessions SET thread_id = ? WHERE session_key = ?").run(threadId, sessionKey);
    this.logger.info("store.session_thread_set", { session_key: sessionKey, thread_id: threadId });
  }

  getCollaborationMode(sessionKey: string): AgentCollaborationMode {
    const row = this.db.query<{ collaboration_mode?: string | null }, [string]>("SELECT collaboration_mode FROM agent_sessions WHERE session_key = ?").get(sessionKey);
    return row?.collaboration_mode === "plan" ? "plan" : "default";
  }

  setCollaborationMode(sessionKey: string, mode: AgentCollaborationMode): void {
    this.db.query("UPDATE agent_sessions SET collaboration_mode = ? WHERE session_key = ?").run(mode, sessionKey);
    this.logger.info("store.session_collaboration_mode_set", { session_key: sessionKey, collaboration_mode: mode });
  }

  getSession(sessionKey: string): AgentSessionRow | undefined {
    const row = this.db.query<AgentSessionRow, [string]>(`
      SELECT session_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id, collaboration_mode
      FROM agent_sessions
      WHERE session_key = ?
    `).get(sessionKey);
    return row ?? undefined;
  }

  listRunningSessions(): AgentSessionRow[] {
    return this.db.query<AgentSessionRow, []>(`
      SELECT session_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id, collaboration_mode
      FROM agent_sessions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `).all();
  }

  appendTranscript(event: TranscriptEvent): void {
    this.db.query(`
      INSERT INTO transcript_events (conversation_id, workspace_name, role, text, created_at)
      VALUES ($conversationId, $workspaceName, $role, $text, $createdAt)
    `).run({
      $conversationId: String(event.conversationId),
      $workspaceName: event.workspaceName,
      $role: event.role,
      $text: event.text,
      $createdAt: event.createdAt,
    });
  }

  latestTranscriptEvent(conversationId: ConversationId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined {
    const row = this.db.query<TranscriptRow, [string, string, string]>(`
      SELECT conversation_id, text, created_at FROM transcript_events
      WHERE conversation_id = ? AND workspace_name = ? AND role = ?
      ORDER BY id DESC LIMIT 1
    `).get(String(conversationId), workspaceName, role);
    return row
      ? { conversationId: row.conversation_id, workspaceName, role, text: row.text, createdAt: row.created_at ?? 0 }
      : undefined;
  }

  setPendingPrompt(prompt: PendingPrompt): void {
    this.db.query(`
      INSERT INTO pending_prompts (conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at)
      VALUES ($conversationId, $promptMessageId, $kind, $createdAt, $sessionKey, $payloadJson, $expiresAt)
      ON CONFLICT(conversation_id, prompt_message_id) DO UPDATE SET
        kind = excluded.kind,
        created_at = excluded.created_at,
        session_key = excluded.session_key,
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `).run({
      $conversationId: String(prompt.conversationId),
      $promptMessageId: String(prompt.promptMessageId),
      $kind: prompt.kind,
      $createdAt: prompt.createdAt,
      $sessionKey: prompt.sessionKey ?? null,
      $payloadJson: prompt.payloadJson ?? null,
      $expiresAt: prompt.expiresAt ?? null,
    });
  }

  getPendingPrompt(conversationId: ConversationId, promptMessageId: MessageId): PendingPrompt | undefined {
    const row = this.db.query<PendingPromptRow, [string, string]>(`
      SELECT conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at
      FROM pending_prompts
      WHERE conversation_id = ? AND prompt_message_id = ?
    `).get(String(conversationId), String(promptMessageId));
    return row ? rowToPendingPrompt(row) : undefined;
  }

  deletePendingPrompt(conversationId: ConversationId, promptMessageId: MessageId): void {
    this.db.query("DELETE FROM pending_prompts WHERE conversation_id = ? AND prompt_message_id = ?").run(String(conversationId), String(promptMessageId));
  }

  setPagedOutput(output: PagedOutput): void {
    this.prunePagedOutputs(Date.now());
    this.db.query(`
      INSERT INTO paged_outputs (token, conversation_id, session_key, text, created_at, expires_at)
      VALUES ($token, $conversationId, $sessionKey, $text, $createdAt, $expiresAt)
      ON CONFLICT(token) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        session_key = excluded.session_key,
        text = excluded.text,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run({
      $token: output.token,
      $conversationId: String(output.conversationId),
      $sessionKey: output.sessionKey,
      $text: output.text,
      $createdAt: output.createdAt,
      $expiresAt: output.expiresAt,
    });
  }

  getPagedOutput(token: string): PagedOutput | undefined {
    const row = this.db.query<PagedOutputRow, [string]>(`
      SELECT token, conversation_id, session_key, text, created_at, expires_at
      FROM paged_outputs
      WHERE token = ?
    `).get(token);
    return row ? rowToPagedOutput(row) : undefined;
  }

  deletePagedOutput(token: string): void {
    this.db.query("DELETE FROM paged_outputs WHERE token = ?").run(token);
  }

  prunePagedOutputs(now = Date.now()): void {
    this.db.query("DELETE FROM paged_outputs WHERE expires_at < ?").run(now);
  }

  getConsoleMessageId(conversationId: ConversationId): MessageId | undefined {
    const row = this.db.query<ChatUiStateRow, [string]>("SELECT conversation_id, console_message_id FROM chat_ui_state WHERE conversation_id = ?").get(String(conversationId));
    return row?.console_message_id ?? undefined;
  }

  setConsoleMessageId(conversationId: ConversationId, messageId: MessageId): void {
    this.db.query(`
      INSERT INTO chat_ui_state (conversation_id, console_message_id)
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET console_message_id = excluded.console_message_id
    `).run(String(conversationId), String(messageId));
  }

  getHomeStatusMode(conversationId: ConversationId): HomeStatusMode {
    const row = this.db.query<ChatUiStateRow, [string]>("SELECT conversation_id, home_status_mode FROM chat_ui_state WHERE conversation_id = ?").get(String(conversationId));
    return row?.home_status_mode === "details" ? "details" : "compact";
  }

  setHomeStatusMode(conversationId: ConversationId, mode: HomeStatusMode): void {
    this.db.query(`
      INSERT INTO chat_ui_state (conversation_id, home_status_mode)
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET home_status_mode = excluded.home_status_mode
    `).run(conversationId, mode);
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
    const now = task.createdAt ?? Date.now();
    const inputJson = task.input ? JSON.stringify(task.input) : null;
    const result = this.db.query(`
      INSERT INTO tasks (conversation_id, workspace_name, text, input_json, status, created_at, updated_at, user_message_id)
      VALUES ($conversationId, $workspaceName, $text, $inputJson, $status, $createdAt, $updatedAt, $userMessageId)
    `).run({
      $conversationId: String(task.conversationId),
      $workspaceName: task.workspaceName,
      $text: task.text,
      $inputJson: inputJson,
      $status: task.status,
      $createdAt: now,
      $updatedAt: now,
      $userMessageId: task.userMessageId !== undefined ? String(task.userMessageId) : null,
    });
    const id = Number(result.lastInsertRowid);
    return this.getTask(id)!;
  }

  getTask(id: number): RelayTask | undefined {
    const row = this.db.query<TaskRow, [number]>(`
      SELECT id, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks WHERE id = ?
    `).get(id);
    return row ? rowToTask(row) : undefined;
  }

  listTasks(conversationId: ConversationId, workspaceName: string, statuses?: TaskStatus[], limit = 20): RelayTask[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      return this.db.query<TaskRow, any>(`
        SELECT id, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
        FROM tasks
        WHERE conversation_id = ? AND workspace_name = ? AND status IN (${placeholders})
        ORDER BY id ASC LIMIT ?
    `).all(String(conversationId), workspaceName, ...statuses, safeLimit).map(rowToTask);
    }
    return this.db.query<TaskRow, [string, string, number]>(`
      SELECT id, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE conversation_id = ? AND workspace_name = ?
      ORDER BY id DESC LIMIT ?
    `).all(String(conversationId), workspaceName, safeLimit).map(rowToTask);
  }

  nextQueuedTask(conversationId: ConversationId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [string, string]>(`
      SELECT id, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE conversation_id = ? AND workspace_name = ? AND status = 'queued'
      ORDER BY id ASC LIMIT 1
    `).get(String(conversationId), workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  activeTask(conversationId: ConversationId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [string, string]>(`
      SELECT id, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE conversation_id = ? AND workspace_name = ? AND status IN ('waiting', 'running', 'blocked')
      ORDER BY id DESC LIMIT 1
    `).get(String(conversationId), workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  updateTask(id: number, updates: { status?: TaskStatus; turnId?: string | null; statusMessageId?: MessageId | null }): void {
    const current = this.getTask(id);
    if (!current) return;
    this.db.query(`
      UPDATE tasks
      SET status = ?, turn_id = ?, status_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.status ?? current.status,
      updates.turnId === undefined ? current.turnId ?? null : updates.turnId,
      updates.statusMessageId === undefined ? current.statusMessageId ?? null : updates.statusMessageId === null ? null : String(updates.statusMessageId),
      Date.now(),
      id,
    );
  }

  updateTasksByTurn(conversationId: ConversationId, workspaceName: string, turnId: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    if (fromStatuses.length === 0) return [];
    const tasks = this.listTasks(conversationId, workspaceName, fromStatuses, 100).filter((task) => task.turnId === turnId);
    for (const task of tasks) {
      this.updateTask(task.id, { status });
    }
    return tasks.map((task) => this.getTask(task.id)).filter((task): task is RelayTask => Boolean(task));
  }

  updateActiveTasks(conversationId: ConversationId, workspaceName: string, status: TaskStatus): RelayTask[] {
    const tasks = this.listTasks(conversationId, workspaceName, ["waiting", "running", "blocked"], 100);
    for (const task of tasks) {
      this.updateTask(task.id, { status });
    }
    return tasks.map((task) => this.getTask(task.id)).filter((task): task is RelayTask => Boolean(task));
  }

  countTasks(conversationId: ConversationId, workspaceName: string, statuses: TaskStatus[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db.query<{ count: number }, any>(`
      SELECT COUNT(*) as count FROM tasks
      WHERE conversation_id = ? AND workspace_name = ? AND status IN (${placeholders})
    `).get(String(conversationId), workspaceName, ...statuses);
    return row?.count ?? 0;
  }
}
