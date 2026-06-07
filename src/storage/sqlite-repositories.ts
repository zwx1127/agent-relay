import type { Database } from "bun:sqlite";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../ports/agent.ts";
import { conversationIdForScope } from "../domain/scope.ts";
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
import {
  rowToPagedOutput,
  rowToPendingPrompt,
  rowToTask,
  rowToWorkspace,
  type AgentSessionRow,
  type BindingRow,
  type ChatUiStateRow,
  type PagedOutput,
  type PagedOutputRow,
  type PendingPromptRow,
  type TaskRow,
  type TranscriptRow,
  type WorkspaceRow,
} from "./sqlite-rows.ts";

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  upsert(record: WorkspaceRecord): void {
    this.db.query(`
      INSERT INTO workspaces (name, path, created_at)
      VALUES ($name, $path, $createdAt)
      ON CONFLICT(name) DO UPDATE SET path = excluded.path
    `).run({ $name: record.name, $path: record.path, $createdAt: record.createdAt });
  }

  list(): WorkspaceRecord[] {
    return this.db.query<WorkspaceRow, []>("SELECT name, path, created_at FROM workspaces ORDER BY name").all().map(rowToWorkspace);
  }

  get(name: string): WorkspaceRecord | undefined {
    const row = this.db.query<WorkspaceRow, [string]>("SELECT name, path, created_at FROM workspaces WHERE name = ?").get(name);
    return row ? rowToWorkspace(row) : undefined;
  }

  delete(name: string): void {
    this.db.transaction(() => {
      // Keep chat bindings from pointing at a workspace that has been removed
      // from the relay catalog.
      this.db.query("DELETE FROM chat_bindings WHERE workspace_name = ?").run(name);
      this.db.query("DELETE FROM workspaces WHERE name = ?").run(name);
    })();
  }
}

export class BindingRepository {
  constructor(private readonly db: Database) {}

  bind(scopeKey: ConversationId, workspaceName: string, updatedAt = Date.now(), conversationId: ConversationId = conversationIdForScope(String(scopeKey))): void {
    this.db.query(`
      INSERT INTO chat_bindings (scope_key, conversation_id, workspace_name, updated_at)
      VALUES ($scopeKey, $conversationId, $workspaceName, $updatedAt)
      ON CONFLICT(scope_key) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        workspace_name = excluded.workspace_name,
        updated_at = excluded.updated_at
    `).run({ $scopeKey: String(scopeKey), $conversationId: String(conversationId), $workspaceName: workspaceName, $updatedAt: updatedAt });
  }

  get(scopeKey: ConversationId): ConversationBinding | undefined {
    const row = this.db.query<BindingRow, [string]>("SELECT scope_key, conversation_id, workspace_name, updated_at FROM chat_bindings WHERE scope_key = ?").get(String(scopeKey));
    return row ? {
      ...(row.scope_key !== row.conversation_id ? { scopeKey: row.scope_key } : {}),
      conversationId: row.conversation_id,
      workspaceName: row.workspace_name,
      updatedAt: row.updated_at,
    } : undefined;
  }

  clear(scopeKey: ConversationId): void {
    this.db.query("DELETE FROM chat_bindings WHERE scope_key = ?").run(String(scopeKey));
  }

  clearForWorkspace(workspaceName: string): void {
    this.db.query("DELETE FROM chat_bindings WHERE workspace_name = ?").run(workspaceName);
  }
}

export class SessionRepository {
  constructor(private readonly db: Database, private readonly logger: Logger) {}

  markStarted(sessionKey: string, conversationId: ConversationId, workspaceName: string, startedAt = Date.now(), threadId?: string, scopeKey = String(conversationId)): void {
    this.db.query(`
      INSERT INTO agent_sessions (session_key, scope_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id)
      VALUES ($sessionKey, $scopeKey, $conversationId, $workspaceName, 'running', $startedAt, NULL, $threadId)
      ON CONFLICT(session_key) DO UPDATE SET
        scope_key = excluded.scope_key,
        conversation_id = excluded.conversation_id,
        status = 'running',
        started_at = excluded.started_at,
        stopped_at = NULL,
        -- Reusing a session without an explicit thread id should preserve the
        -- last known thread for resume/status flows.
        thread_id = COALESCE(excluded.thread_id, agent_sessions.thread_id),
        collaboration_mode = 'default',
        collaboration_thread_id = NULL
    `).run({ $sessionKey: sessionKey, $scopeKey: scopeKey, $conversationId: String(conversationId), $workspaceName: workspaceName, $startedAt: startedAt, $threadId: threadId ?? null });
    this.logger.info("store.session_marked_started", { session_key: sessionKey, conversation_id: conversationId, workspace: workspaceName });
  }

  markStopped(sessionKey: string, stoppedAt = Date.now()): void {
    this.db.query("UPDATE agent_sessions SET status = 'stopped', stopped_at = ?, collaboration_mode = 'default', collaboration_thread_id = NULL WHERE session_key = ?").run(stoppedAt, sessionKey);
    this.logger.info("store.session_marked_stopped", { session_key: sessionKey });
  }

  clearThreadId(sessionKey: string): void {
    this.db.query("UPDATE agent_sessions SET thread_id = NULL, collaboration_mode = 'default', collaboration_thread_id = NULL WHERE session_key = ?").run(sessionKey);
    this.logger.info("store.session_thread_cleared", { session_key: sessionKey });
  }

  setThreadId(sessionKey: string, threadId: string): void {
    this.db.query("UPDATE agent_sessions SET thread_id = ?, collaboration_mode = 'default', collaboration_thread_id = NULL WHERE session_key = ?").run(threadId, sessionKey);
    this.logger.info("store.session_thread_set", { session_key: sessionKey, thread_id: threadId });
  }

  getCollaborationMode(sessionKey: string): AgentCollaborationMode {
    const row = this.db.query<{ status?: string | null; collaboration_mode?: string | null; thread_id?: string | null; collaboration_thread_id?: string | null }, [string]>(`
      SELECT status, collaboration_mode, thread_id, collaboration_thread_id
      FROM agent_sessions
      WHERE session_key = ?
    `).get(sessionKey);
    if (row?.status !== "running") return "default";
    if (row?.collaboration_mode !== "plan") return "default";
    if (!row.thread_id || row.collaboration_thread_id !== row.thread_id) return "default";
    return "plan";
  }

  setCollaborationMode(sessionKey: string, mode: AgentCollaborationMode): void {
    this.db.query(`
      UPDATE agent_sessions
      SET collaboration_mode = ?,
          collaboration_thread_id = CASE WHEN ? = 'plan' THEN thread_id ELSE NULL END
      WHERE session_key = ?
    `).run(mode, mode, sessionKey);
    this.logger.info("store.session_collaboration_mode_set", { session_key: sessionKey, collaboration_mode: mode });
  }

  get(sessionKey: string): AgentSessionRow | undefined {
    const row = this.db.query<AgentSessionRow, [string]>(`
      SELECT session_key, scope_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id, collaboration_mode, collaboration_thread_id
      FROM agent_sessions
      WHERE session_key = ?
    `).get(sessionKey);
    return row ?? undefined;
  }

  listRunning(): AgentSessionRow[] {
    return this.db.query<AgentSessionRow, []>(`
      SELECT session_key, scope_key, conversation_id, workspace_name, status, started_at, stopped_at, thread_id, collaboration_mode, collaboration_thread_id
      FROM agent_sessions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `).all();
  }
}

export class TranscriptRepository {
  constructor(private readonly db: Database) {}

  append(event: TranscriptEvent): void {
    const scopeKey = event.scopeKey ?? String(event.conversationId);
    this.db.query(`
      INSERT INTO transcript_events (scope_key, conversation_id, workspace_name, role, text, created_at)
      VALUES ($scopeKey, $conversationId, $workspaceName, $role, $text, $createdAt)
    `).run({
      $scopeKey: scopeKey,
      $conversationId: String(event.conversationId),
      $workspaceName: event.workspaceName,
      $role: event.role,
      $text: event.text,
      $createdAt: event.createdAt,
    });
  }

  latest(scopeKey: ConversationId, workspaceName: string, role: TranscriptRole): TranscriptEvent | undefined {
    const row = this.db.query<TranscriptRow, [string, string, string]>(`
      SELECT scope_key, conversation_id, text, created_at FROM transcript_events
      WHERE scope_key = ? AND workspace_name = ? AND role = ?
      ORDER BY id DESC LIMIT 1
    `).get(String(scopeKey), workspaceName, role);
    return row
      ? {
        conversationId: row.conversation_id,
        ...(row.scope_key && row.scope_key !== row.conversation_id ? { scopeKey: row.scope_key } : {}),
        workspaceName,
        role,
        text: row.text,
        createdAt: row.created_at ?? 0,
      }
      : undefined;
  }
}

export class PromptRepository {
  constructor(private readonly db: Database) {}

  set(prompt: PendingPrompt): void {
    const scopeKey = prompt.scopeKey ?? String(prompt.conversationId);
    this.db.query(`
      INSERT INTO pending_prompts (scope_key, conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at)
      VALUES ($scopeKey, $conversationId, $promptMessageId, $kind, $createdAt, $sessionKey, $payloadJson, $expiresAt)
      ON CONFLICT(scope_key, prompt_message_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        kind = excluded.kind,
        created_at = excluded.created_at,
        session_key = excluded.session_key,
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at
    `).run({
      $scopeKey: scopeKey,
      $conversationId: String(prompt.conversationId),
      $promptMessageId: String(prompt.promptMessageId),
      $kind: prompt.kind,
      $createdAt: prompt.createdAt,
      $sessionKey: prompt.sessionKey ?? null,
      $payloadJson: prompt.payloadJson ?? null,
      $expiresAt: prompt.expiresAt ?? null,
    });
  }

  get(scopeKey: ConversationId, promptMessageId: MessageId): PendingPrompt | undefined {
    const row = this.db.query<PendingPromptRow, [string, string]>(`
      SELECT scope_key, conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at
      FROM pending_prompts
      WHERE scope_key = ? AND prompt_message_id = ?
    `).get(String(scopeKey), String(promptMessageId));
    return row ? rowToPendingPrompt(row) : undefined;
  }

  latest(scopeKey: ConversationId, kinds: PendingPrompt["kind"][] = [], now = Date.now()): PendingPrompt | undefined {
    // Expired prompts are ignored here rather than eagerly deleted so callback
    // handlers can still produce a clear stale/expired response when needed.
    const kindFilter = kinds.length > 0 ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const row = this.db.query<PendingPromptRow, any>(`
      SELECT scope_key, conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at
      FROM pending_prompts
      WHERE scope_key = ?
        ${kindFilter}
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, prompt_message_id DESC
      LIMIT 1
    `).get(String(scopeKey), ...kinds, now);
    return row ? rowToPendingPrompt(row) : undefined;
  }

  delete(scopeKey: ConversationId, promptMessageId: MessageId): void {
    this.db.query("DELETE FROM pending_prompts WHERE scope_key = ? AND prompt_message_id = ?").run(String(scopeKey), String(promptMessageId));
  }

  deleteForSession(sessionKey: string, kinds: PendingPrompt["kind"][] = []): number {
    if (kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(", ");
      const result = this.db.query<any, any>(`
        DELETE FROM pending_prompts
        WHERE session_key = ? AND kind IN (${placeholders})
      `).run(sessionKey, ...kinds);
      return result.changes;
    }
    const result = this.db.query("DELETE FROM pending_prompts WHERE session_key = ?").run(sessionKey);
    return result.changes;
  }
}

export class PagedOutputRepository {
  constructor(private readonly db: Database) {}

  set(output: PagedOutput): void {
    // Paged output can be large; prune expired pages opportunistically before
    // storing a new one to keep the local SQLite file bounded.
    this.prune(Date.now());
    const scopeKey = output.scopeKey ?? String(output.conversationId);
    this.db.query(`
      INSERT INTO paged_outputs (token, scope_key, conversation_id, session_key, text, created_at, expires_at)
      VALUES ($token, $scopeKey, $conversationId, $sessionKey, $text, $createdAt, $expiresAt)
      ON CONFLICT(token) DO UPDATE SET
        scope_key = excluded.scope_key,
        conversation_id = excluded.conversation_id,
        session_key = excluded.session_key,
        text = excluded.text,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run({
      $token: output.token,
      $scopeKey: scopeKey,
      $conversationId: String(output.conversationId),
      $sessionKey: output.sessionKey,
      $text: output.text,
      $createdAt: output.createdAt,
      $expiresAt: output.expiresAt,
    });
  }

  get(token: string): PagedOutput | undefined {
    const row = this.db.query<PagedOutputRow, [string]>(`
      SELECT token, scope_key, conversation_id, session_key, text, created_at, expires_at
      FROM paged_outputs
      WHERE token = ?
    `).get(token);
    return row ? rowToPagedOutput(row) : undefined;
  }

  delete(token: string): void {
    this.db.query("DELETE FROM paged_outputs WHERE token = ?").run(token);
  }

  prune(now = Date.now()): void {
    this.db.query("DELETE FROM paged_outputs WHERE expires_at < ?").run(now);
  }
}

export class ChatUiRepository {
  constructor(private readonly db: Database) {}

  getConsoleMessageId(scopeKey: ConversationId): MessageId | undefined {
    const row = this.db.query<ChatUiStateRow, [string]>("SELECT scope_key, conversation_id, console_message_id FROM chat_ui_state WHERE scope_key = ?").get(String(scopeKey));
    return row?.console_message_id ?? undefined;
  }

  setConsoleMessageId(scopeKey: ConversationId, messageId: MessageId, conversationId: ConversationId = conversationIdForScope(String(scopeKey))): void {
    this.db.query(`
      INSERT INTO chat_ui_state (scope_key, conversation_id, console_message_id)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        console_message_id = excluded.console_message_id
    `).run(String(scopeKey), String(conversationId), String(messageId));
  }

  getHomeStatusMode(scopeKey: ConversationId): HomeStatusMode {
    const row = this.db.query<ChatUiStateRow, [string]>("SELECT scope_key, conversation_id, home_status_mode FROM chat_ui_state WHERE scope_key = ?").get(String(scopeKey));
    return row?.home_status_mode === "details" ? "details" : "compact";
  }

  setHomeStatusMode(scopeKey: ConversationId, mode: HomeStatusMode, conversationId: ConversationId = conversationIdForScope(String(scopeKey))): void {
    this.db.query(`
      INSERT INTO chat_ui_state (scope_key, conversation_id, home_status_mode)
      VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        home_status_mode = excluded.home_status_mode
    `).run(String(scopeKey), String(conversationId), mode);
  }

  setControlMessage(conversationId: ConversationId, messageId: MessageId, scopeKey: string, kind = "control"): void {
    this.db.query(`
      INSERT INTO control_messages (conversation_id, message_id, scope_key, kind, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, message_id) DO UPDATE SET
        scope_key = excluded.scope_key,
        kind = excluded.kind,
        updated_at = excluded.updated_at
    `).run(String(conversationId), String(messageId), scopeKey, kind, Date.now());
  }

  getControlMessage(conversationId: ConversationId, messageId: MessageId): { scopeKey: string; kind?: string } | undefined {
    const row = this.db.query<{ scope_key: string; kind: string | null }, [string, string]>(`
      SELECT scope_key, kind FROM control_messages
      WHERE conversation_id = ? AND message_id = ?
    `).get(String(conversationId), String(messageId));
    return row ? { scopeKey: row.scope_key, ...(row.kind ? { kind: row.kind } : {}) } : undefined;
  }

  getControlMessageScopeKey(conversationId: ConversationId, messageId: MessageId): string | undefined {
    return this.getControlMessage(conversationId, messageId)?.scopeKey;
  }
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  create(task: {
    conversationId: ConversationId;
    scopeKey?: string;
    workspaceName: string;
    text: string;
    input?: AgentTaskInput;
    status: TaskStatus;
    createdAt?: number;
    userMessageId?: MessageId;
  }): RelayTask {
    const now = task.createdAt ?? Date.now();
    const inputJson = task.input ? JSON.stringify(task.input) : null;
    const scopeKey = task.scopeKey ?? String(task.conversationId);
    const result = this.db.query(`
      INSERT INTO tasks (scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, user_message_id)
      VALUES ($scopeKey, $conversationId, $workspaceName, $text, $inputJson, $status, $createdAt, $updatedAt, $userMessageId)
    `).run({
      $scopeKey: scopeKey,
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
    return this.get(id)!;
  }

  get(id: number): RelayTask | undefined {
    const row = this.db.query<TaskRow, [number]>(`
      SELECT id, scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks WHERE id = ?
    `).get(id);
    return row ? rowToTask(row) : undefined;
  }

  list(scopeKey: ConversationId, workspaceName: string, statuses?: TaskStatus[], limit = 20): RelayTask[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    if (statuses && statuses.length > 0) {
      // Status-filtered task reads are used for dispatch order, so return oldest
      // first. Unfiltered history below is newest first for status displays.
      const placeholders = statuses.map(() => "?").join(", ");
      return this.db.query<TaskRow, any>(`
        SELECT id, scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
        FROM tasks
        WHERE scope_key = ? AND workspace_name = ? AND status IN (${placeholders})
        ORDER BY id ASC LIMIT ?
    `).all(String(scopeKey), workspaceName, ...statuses, safeLimit).map(rowToTask);
    }
    return this.db.query<TaskRow, [string, string, number]>(`
      SELECT id, scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE scope_key = ? AND workspace_name = ?
      ORDER BY id DESC LIMIT ?
    `).all(String(scopeKey), workspaceName, safeLimit).map(rowToTask);
  }

  nextQueued(scopeKey: ConversationId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [string, string]>(`
      SELECT id, scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE scope_key = ? AND workspace_name = ? AND status = 'queued'
      ORDER BY id ASC LIMIT 1
    `).get(String(scopeKey), workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  active(scopeKey: ConversationId, workspaceName: string): RelayTask | undefined {
    const row = this.db.query<TaskRow, [string, string]>(`
      SELECT id, scope_key, conversation_id, workspace_name, text, input_json, status, created_at, updated_at, turn_id, user_message_id, status_message_id
      FROM tasks
      WHERE scope_key = ? AND workspace_name = ? AND status IN ('waiting', 'running', 'blocked')
      ORDER BY id DESC LIMIT 1
    `).get(String(scopeKey), workspaceName);
    return row ? rowToTask(row) : undefined;
  }

  update(id: number, updates: { status?: TaskStatus; turnId?: string | null; statusMessageId?: MessageId | null }): void {
    const current = this.get(id);
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

  updateByTurn(scopeKey: ConversationId, workspaceName: string, turnId: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    if (fromStatuses.length === 0) return [];
    // SQLite cannot bind a dynamic status list and turn id into a reusable typed
    // query cleanly here, so narrow by status in SQL and by turn id in memory.
    const tasks = this.list(scopeKey, workspaceName, fromStatuses, 100).filter((task) => task.turnId === turnId);
    for (const task of tasks) {
      this.update(task.id, { status });
    }
    return tasks.map((task) => this.get(task.id)).filter((task): task is RelayTask => Boolean(task));
  }

  updateActive(scopeKey: ConversationId, workspaceName: string, status: TaskStatus): RelayTask[] {
    return this.updateByStatus(scopeKey, workspaceName, ["waiting", "running", "blocked"], status);
  }

  updateByStatus(scopeKey: ConversationId, workspaceName: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    const tasks = this.list(scopeKey, workspaceName, fromStatuses, 100);
    for (const task of tasks) {
      this.update(task.id, { status });
    }
    return tasks.map((task) => this.get(task.id)).filter((task): task is RelayTask => Boolean(task));
  }

  count(scopeKey: ConversationId, workspaceName: string, statuses: TaskStatus[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db.query<{ count: number }, any>(`
      SELECT COUNT(*) as count FROM tasks
      WHERE scope_key = ? AND workspace_name = ? AND status IN (${placeholders})
    `).get(String(scopeKey), workspaceName, ...statuses);
    return row?.count ?? 0;
  }
}

export interface SQLiteRepositories {
  workspaces: WorkspaceRepository;
  bindings: BindingRepository;
  sessions: SessionRepository;
  transcripts: TranscriptRepository;
  prompts: PromptRepository;
  pagedOutputs: PagedOutputRepository;
  chatUi: ChatUiRepository;
  tasks: TaskRepository;
}

export function createSQLiteRepositories(db: Database, logger: Logger): SQLiteRepositories {
  return {
    workspaces: new WorkspaceRepository(db),
    bindings: new BindingRepository(db),
    sessions: new SessionRepository(db, logger),
    transcripts: new TranscriptRepository(db),
    prompts: new PromptRepository(db),
    pagedOutputs: new PagedOutputRepository(db),
    chatUi: new ChatUiRepository(db),
    tasks: new TaskRepository(db),
  };
}
