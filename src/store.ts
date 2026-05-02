import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { noopLogger, type Logger } from "./logger.ts";
import type { ChatBinding, ChatId, PendingPrompt, PendingPromptKind, TranscriptEvent, TranscriptRole, WorkspaceRecord } from "./types.ts";

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

  markSessionStarted(sessionKey: string, chatId: ChatId, workspaceName: string, startedAt = Date.now()): void {
    this.db.query(`
      INSERT INTO agent_sessions (session_key, chat_id, workspace_name, status, started_at, stopped_at)
      VALUES ($sessionKey, $chatId, $workspaceName, 'running', $startedAt, NULL)
      ON CONFLICT(session_key) DO UPDATE SET status = 'running', started_at = excluded.started_at, stopped_at = NULL
    `).run({ $sessionKey: sessionKey, $chatId: chatId, $workspaceName: workspaceName, $startedAt: startedAt });
    this.logger.info("store.session_marked_started", { session_key: sessionKey, chat_id: chatId, workspace: workspaceName });
  }

  markSessionStopped(sessionKey: string, stoppedAt = Date.now()): void {
    this.db.query("UPDATE agent_sessions SET status = 'stopped', stopped_at = ? WHERE session_key = ?").run(stoppedAt, sessionKey);
    this.logger.info("store.session_marked_stopped", { session_key: sessionKey });
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
      INSERT INTO pending_prompts (chat_id, prompt_message_id, kind, created_at)
      VALUES ($chatId, $promptMessageId, $kind, $createdAt)
      ON CONFLICT(chat_id, prompt_message_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at
    `).run({
      $chatId: prompt.chatId,
      $promptMessageId: prompt.promptMessageId,
      $kind: prompt.kind,
      $createdAt: prompt.createdAt,
    });
  }

  getPendingPrompt(chatId: ChatId, promptMessageId: number): PendingPrompt | undefined {
    const row = this.db.query<PendingPromptRow, [number, number]>(`
      SELECT chat_id, prompt_message_id, kind, created_at
      FROM pending_prompts
      WHERE chat_id = ? AND prompt_message_id = ?
    `).get(chatId, promptMessageId);
    return row ? rowToPendingPrompt(row) : undefined;
  }

  deletePendingPrompt(chatId: ChatId, promptMessageId: number): void {
    this.db.query("DELETE FROM pending_prompts WHERE chat_id = ? AND prompt_message_id = ?").run(chatId, promptMessageId);
  }

  prunePendingPrompts(olderThan: number): void {
    this.db.query("DELETE FROM pending_prompts WHERE created_at < ?").run(olderThan);
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
  };
}
