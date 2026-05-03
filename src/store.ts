import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { noopLogger, type Logger } from "./logger.ts";
import type { ChatBinding, ChatId, PendingPrompt, PendingPromptKind, RelayTask, TaskStatus, TranscriptEvent, TranscriptRole, WorkspaceRecord } from "./types.ts";

interface WorkspaceRow {
  name: string;
  path: string;
  created_at: number;
}

interface BindingRow {
  chat_id: number;
  workspace_name: string;
  updated_at: number;
}

interface TranscriptRow {
  text: string;
  created_at?: number;
}

interface PendingPromptRow {
  chat_id: number;
  prompt_message_id: number;
  kind: string;
  created_at: number;
  session_key?: string | null;
  payload_json?: string | null;
  expires_at?: number | null;
}

interface AgentSessionRow {
  session_key: string;
  chat_id: number;
  workspace_name: string;
  status: string;
  started_at: number;
  stopped_at?: number | null;
  thread_id?: string | null;
}

interface PagedOutputRow {
  token: string;
  chat_id: number;
  session_key: string;
  text: string;
  created_at: number;
  expires_at: number;
}

interface ChatUiStateRow {
  chat_id: number;
  console_message_id?: number | null;
}

interface TaskRow {
  id: number;
  chat_id: number;
  workspace_name: string;
  text: string;
  status: string;
  created_at: number;
  updated_at: number;
  turn_id?: string | null;
  user_message_id?: number | null;
}

export interface PagedOutput {
  token: string;
  chatId: ChatId;
  sessionKey: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

export class Store {
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
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_bindings (
        chat_id INTEGER PRIMARY KEY,
        workspace_name TEXT NOT NULL REFERENCES workspaces(name),
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_key TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        workspace_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS transcript_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        workspace_name TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pending_prompts (
        chat_id INTEGER NOT NULL,
        prompt_message_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, prompt_message_id)
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS paged_outputs (
        token TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_ui_state (
        chat_id INTEGER PRIMARY KEY,
        console_message_id INTEGER
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        workspace_name TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        turn_id TEXT,
        user_message_id INTEGER
      )
    `);
    this.addColumnIfMissing("agent_sessions", "thread_id", "TEXT");
    this.addColumnIfMissing("pending_prompts", "session_key", "TEXT");
    this.addColumnIfMissing("pending_prompts", "payload_json", "TEXT");
    this.addColumnIfMissing("pending_prompts", "expires_at", "INTEGER");
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

  bindChat(chatId: ChatId, workspaceName: string, updatedAt = Date.now()): void {
    this.db.query(`
      INSERT INTO chat_bindings (chat_id, workspace_name, updated_at)
      VALUES ($chatId, $workspaceName, $updatedAt)
      ON CONFLICT(chat_id) DO UPDATE SET workspace_name = excluded.workspace_name, updated_at = excluded.updated_at
    `).run({ $chatId: chatId, $workspaceName: workspaceName, $updatedAt: updatedAt });
  }

  getBinding(chatId: ChatId): ChatBinding | undefined {
    const row = this.db.query<BindingRow, [number]>("SELECT chat_id, workspace_name, updated_at FROM chat_bindings WHERE chat_id = ?").get(chatId);
    return row ? { chatId: row.chat_id, workspaceName: row.workspace_name, updatedAt: row.updated_at } : undefined;
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  markSessionStarted(sessionKey: string, chatId: ChatId, workspaceName: string, startedAt = Date.now(), threadId?: string): void {
    this.db.query(`
      INSERT INTO agent_sessions (session_key, chat_id, workspace_name, status, started_at, stopped_at, thread_id)
      VALUES ($sessionKey, $chatId, $workspaceName, 'running', $startedAt, NULL, $threadId)
      ON CONFLICT(session_key) DO UPDATE SET
        status = 'running',
        started_at = excluded.started_at,
        stopped_at = NULL,
        thread_id = COALESCE(excluded.thread_id, agent_sessions.thread_id)
    `).run({ $sessionKey: sessionKey, $chatId: chatId, $workspaceName: workspaceName, $startedAt: startedAt, $threadId: threadId ?? null });
    this.logger.info("store.session_marked_started", { session_key: sessionKey, chat_id: chatId, workspace: workspaceName });
  }

  markSessionStopped(sessionKey: string, stoppedAt = Date.now()): void {
    this.db.query("UPDATE agent_sessions SET status = 'stopped', stopped_at = ? WHERE session_key = ?").run(stoppedAt, sessionKey);
    this.logger.info("store.session_marked_stopped", { session_key: sessionKey });
  }

  clearSessionThreadId(sessionKey: string): void {
    this.db.query("UPDATE agent_sessions SET thread_id = NULL WHERE session_key = ?").run(sessionKey);
    this.logger.info("store.session_thread_cleared", { session_key: sessionKey });
  }

  getSession(sessionKey: string): AgentSessionRow | undefined {
    const row = this.db.query<AgentSessionRow, [string]>(`
      SELECT session_key, chat_id, workspace_name, status, started_at, stopped_at, thread_id
      FROM agent_sessions
      WHERE session_key = ?
    `).get(sessionKey);
    return row ?? undefined;
  }

  appendTranscript(event: TranscriptEvent): void {
    this.db.query(`
      INSERT INTO transcript_events (chat_id, workspace_name, role, text, created_at)
      VALUES ($chatId, $workspaceName, $role, $text, $createdAt)
    `).run({
      $chatId: event.chatId,
      $workspaceName: event.workspaceName,
      $role: event.role,
      $text: event.text,
      $createdAt: event.createdAt,
    });
  }

  recentTranscript(chatId: ChatId, workspaceName: string, role: TranscriptRole | undefined, limit: number): string {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = role
      ? this.db.query<TranscriptRow, [number, string, string, number]>(`
          SELECT text FROM transcript_events
          WHERE chat_id = ? AND workspace_name = ? AND role = ?
          ORDER BY id DESC LIMIT ?
        `).all(chatId, workspaceName, role, safeLimit)
      : this.db.query<TranscriptRow, [number, string, number]>(`
          SELECT text FROM transcript_events
          WHERE chat_id = ? AND workspace_name = ?
          ORDER BY id DESC LIMIT ?
        `).all(chatId, workspaceName, safeLimit);
    return rows.reverse().map((row) => row.text).join("");
  }

  latestTranscriptEvent(chatId: ChatId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined {
    const row = this.db.query<TranscriptRow, [number, string, string]>(`
      SELECT text, created_at FROM transcript_events
      WHERE chat_id = ? AND workspace_name = ? AND role = ?
      ORDER BY id DESC LIMIT 1
    `).get(chatId, workspaceName, role);
    return row
      ? { chatId, workspaceName, role, text: row.text, createdAt: row.created_at ?? 0 }
      : undefined;
  }

  setPendingPrompt(prompt: PendingPrompt): void {
    this.db.query(`
      INSERT INTO pending_prompts (chat_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at)
      VALUES ($chatId, $promptMessageId, $kind, $createdAt, $sessionKey, $payloadJson, $expiresAt)
      ON CONFLICT(chat_id, prompt_message_id) DO UPDATE SET
        kind = excluded.kind,
        created_at = excluded.created_at,
        session_key = excluded.session_key,
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `).run({
      $chatId: prompt.chatId,
      $promptMessageId: prompt.promptMessageId,
      $kind: prompt.kind,
      $createdAt: prompt.createdAt,
      $sessionKey: prompt.sessionKey ?? null,
      $payloadJson: prompt.payloadJson ?? null,
      $expiresAt: prompt.expiresAt ?? null,
    });
  }

  getPendingPrompt(chatId: ChatId, promptMessageId: number): PendingPrompt | undefined {
    const row = this.db.query<PendingPromptRow, [number, number]>(`
      SELECT chat_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at
      FROM pending_prompts
      WHERE chat_id = ? AND prompt_message_id = ?
    `).get(chatId, promptMessageId);
    return row ? rowToPendingPrompt(row) : undefined;
  }

  deletePendingPrompt(chatId: ChatId, promptMessageId: number): void {
    this.db.query("DELETE FROM pending_prompts WHERE chat_id = ? AND prompt_message_id = ?").run(chatId, promptMessageId);
  }

  prunePendingPrompts(olderThan: number): void {
    this.db.query("DELETE FROM pending_prompts WHERE created_at < ? OR (expires_at IS NOT NULL AND expires_at < ?)").run(olderThan, Date.now());
  }

  setPagedOutput(output: PagedOutput): void {
    this.prunePagedOutputs(Date.now());
    this.db.query(`
      INSERT INTO paged_outputs (token, chat_id, session_key, text, created_at, expires_at)
      VALUES ($token, $chatId, $sessionKey, $text, $createdAt, $expiresAt)
      ON CONFLICT(token) DO UPDATE SET
        chat_id = excluded.chat_id,
        session_key = excluded.session_key,
        text = excluded.text,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run({
      $token: output.token,
      $chatId: output.chatId,
      $sessionKey: output.sessionKey,
      $text: output.text,
      $createdAt: output.createdAt,
      $expiresAt: output.expiresAt,
    });
  }

  getPagedOutput(token: string): PagedOutput | undefined {
    const row = this.db.query<PagedOutputRow, [string]>(`
      SELECT token, chat_id, session_key, text, created_at, expires_at
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

  getConsoleMessageId(chatId: ChatId): number | undefined {
    const row = this.db.query<ChatUiStateRow, [number]>("SELECT chat_id, console_message_id FROM chat_ui_state WHERE chat_id = ?").get(chatId);
    return row?.console_message_id ?? undefined;
  }

  setConsoleMessageId(chatId: ChatId, messageId: number): void {
    this.db.query(`
      INSERT INTO chat_ui_state (chat_id, console_message_id)
      VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET console_message_id = excluded.console_message_id
    `).run(chatId, messageId);
  }

  createTask(task: {
    chatId: ChatId;
    workspaceName: string;
    text: string;
    status: TaskStatus;
    createdAt?: number;
    userMessageId?: number;
  }): RelayTask {
    const now = task.createdAt ?? Date.now();
    const result = this.db.query(`
      INSERT INTO tasks (chat_id, workspace_name, text, status, created_at, updated_at, user_message_id)
      VALUES ($chatId, $workspaceName, $text, $status, $createdAt, $updatedAt, $userMessageId)
    `).run({
      $chatId: task.chatId,
      $workspaceName: task.workspaceName,
      $text: task.text,
      $status: task.status,
      $createdAt: now,
      $updatedAt: now,
      $userMessageId: task.userMessageId ?? null,
    });
    const id = Number(result.lastInsertRowid);
    return this.getTask(id)!;
  }

  getTask(id: number): RelayTask | undefined {
    const row = this.db.query<TaskRow, [number]>(`
      SELECT id, chat_id, workspace_name, text, status, created_at, updated_at, turn_id, user_message_id
      FROM tasks WHERE id = ?
    `).get(id);
    return row ? rowToTask(row) : undefined;
  }

  listTasks(chatId: ChatId, workspaceName: string, statuses?: TaskStatus[], limit = 20): RelayTask[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      return this.db.query<TaskRow, any>(`
        SELECT id, chat_id, workspace_name, text, status, created_at, updated_at, turn_id, user_message_id
        FROM tasks
        WHERE chat_id = ? AND workspace_name = ? AND status IN (${placeholders})
        ORDER BY id ASC LIMIT ?
      `).all(chatId, workspaceName, ...statuses, safeLimit).map(rowToTask);
    }
    return this.db.query<TaskRow, [number, string, number]>(`
      SELECT id, chat_id, workspace_name, text, status, created_at, updated_at, turn_id, user_message_id
      FROM tasks
      WHERE chat_id = ? AND workspace_name = ?
      ORDER BY id DESC LIMIT ?
    `).all(chatId, workspaceName, safeLimit).map(rowToTask);
  }

  nextQueuedTask(chatId: ChatId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [number, string]>(`
      SELECT id, chat_id, workspace_name, text, status, created_at, updated_at, turn_id, user_message_id
      FROM tasks
      WHERE chat_id = ? AND workspace_name = ? AND status = 'queued'
      ORDER BY id ASC LIMIT 1
    `).get(chatId, workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  activeTask(chatId: ChatId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [number, string]>(`
      SELECT id, chat_id, workspace_name, text, status, created_at, updated_at, turn_id, user_message_id
      FROM tasks
      WHERE chat_id = ? AND workspace_name = ? AND status IN ('running', 'blocked')
      ORDER BY id DESC LIMIT 1
    `).get(chatId, workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  updateTask(id: number, updates: { status?: TaskStatus; turnId?: string | null }): void {
    const current = this.getTask(id);
    if (!current) return;
    this.db.query(`
      UPDATE tasks
      SET status = ?, turn_id = ?, updated_at = ?
      WHERE id = ?
    `).run(updates.status ?? current.status, updates.turnId === undefined ? current.turnId ?? null : updates.turnId, Date.now(), id);
  }

  countTasks(chatId: ChatId, workspaceName: string, statuses: TaskStatus[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db.query<{ count: number }, any>(`
      SELECT COUNT(*) as count FROM tasks
      WHERE chat_id = ? AND workspace_name = ? AND status IN (${placeholders})
    `).get(chatId, workspaceName, ...statuses);
    return row?.count ?? 0;
  }
}

function rowToWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return { name: row.name, path: row.path, createdAt: row.created_at };
}

function rowToPendingPrompt(row: PendingPromptRow): PendingPrompt {
  return {
    chatId: row.chat_id,
    promptMessageId: row.prompt_message_id,
    kind: row.kind as PendingPromptKind,
    createdAt: row.created_at,
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.payload_json ? { payloadJson: row.payload_json } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

function rowToPagedOutput(row: PagedOutputRow): PagedOutput {
  return {
    token: row.token,
    chatId: row.chat_id,
    sessionKey: row.session_key,
    text: row.text,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function rowToTask(row: TaskRow): RelayTask {
  return {
    id: row.id,
    chatId: row.chat_id,
    workspaceName: row.workspace_name,
    text: row.text,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
  };
}
