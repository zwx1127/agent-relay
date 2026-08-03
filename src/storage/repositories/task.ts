import type { Database } from "bun:sqlite";
import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { AgentTaskInput } from "../../ports/agent.ts";
import type { RelayTask, TaskStatus } from "../../relay/types.ts";
import { rowToTask, type TaskRow } from "../sqlite-rows.ts";

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
    for (const task of tasks) this.update(task.id, { status });
    return tasks.map((task) => this.get(task.id)).filter((task): task is RelayTask => Boolean(task));
  }

  updateActive(scopeKey: ConversationId, workspaceName: string, status: TaskStatus): RelayTask[] {
    return this.updateByStatus(scopeKey, workspaceName, ["waiting", "running", "blocked"], status);
  }

  updateByStatus(scopeKey: ConversationId, workspaceName: string, fromStatuses: TaskStatus[], status: TaskStatus): RelayTask[] {
    const tasks = this.list(scopeKey, workspaceName, fromStatuses, 100);
    for (const task of tasks) this.update(task.id, { status });
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
