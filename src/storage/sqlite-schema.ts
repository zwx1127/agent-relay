import type { Database } from "bun:sqlite";
import type { Logger } from "../domain/logger.ts";

export function migrateSQLiteSchema(db: Database, logger: Logger): void {
  // Tables are created at their earliest baseline shape first; additive columns
  // below keep existing local databases compatible across relay upgrades.
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_bindings (
      conversation_id TEXT PRIMARY KEY,
      workspace_name TEXT NOT NULL REFERENCES workspaces(name),
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS transcript_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_prompts (
      conversation_id TEXT NOT NULL,
      prompt_message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, prompt_message_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS paged_outputs (
      token TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_ui_state (
      conversation_id TEXT PRIMARY KEY,
      console_message_id TEXT,
      home_status_mode TEXT NOT NULL DEFAULT 'compact'
    )
  `);
  db.run(`
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
  addColumnIfMissing(db, "agent_sessions", "thread_id", "TEXT");
  addColumnIfMissing(db, "agent_sessions", "collaboration_mode", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "pending_prompts", "session_key", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "payload_json", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "expires_at", "INTEGER");
  addColumnIfMissing(db, "chat_ui_state", "home_status_mode", "TEXT NOT NULL DEFAULT 'compact'");
  addColumnIfMissing(db, "tasks", "status_message_id", "TEXT");
  addColumnIfMissing(db, "tasks", "input_json", "TEXT");
  recordMigration(db, 1, "baseline");
  logger.debug("store.migrated");
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  // SQLite lacks `ADD COLUMN IF NOT EXISTS` on some bundled versions, so inspect
  // table metadata before applying additive migrations.
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function recordMigration(db: Database, version: number, name: string): void {
  // The current migrations are idempotent DDL; this marker records that the
  // baseline schema has been observed without replaying destructive changes.
  db.query(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(version, name, Date.now());
}
