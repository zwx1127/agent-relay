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
  addColumnIfMissing(db, "chat_bindings", "scope_key", "TEXT");
  addColumnIfMissing(db, "agent_sessions", "scope_key", "TEXT");
  addColumnIfMissing(db, "agent_sessions", "collaboration_mode", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(db, "agent_sessions", "collaboration_thread_id", "TEXT");
  addColumnIfMissing(db, "agent_sessions", "collaboration_mode_pending", "TEXT");
  addColumnIfMissing(db, "transcript_events", "scope_key", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "scope_key", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "session_key", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "payload_json", "TEXT");
  addColumnIfMissing(db, "pending_prompts", "expires_at", "INTEGER");
  addColumnIfMissing(db, "paged_outputs", "scope_key", "TEXT");
  addColumnIfMissing(db, "chat_ui_state", "scope_key", "TEXT");
  addColumnIfMissing(db, "chat_ui_state", "home_status_mode", "TEXT NOT NULL DEFAULT 'compact'");
  addColumnIfMissing(db, "tasks", "scope_key", "TEXT");
  addColumnIfMissing(db, "tasks", "status_message_id", "TEXT");
  addColumnIfMissing(db, "tasks", "input_json", "TEXT");
  backfillScopeKeys(db);
  migrateScopedPrimaryTables(db);
  createControlMessagesTable(db);
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

function backfillScopeKeys(db: Database): void {
  for (const table of ["agent_sessions", "transcript_events", "pending_prompts", "paged_outputs", "chat_ui_state", "tasks"]) {
    if (tableExists(db, table) && columnExists(db, table, "scope_key")) {
      db.run(`UPDATE ${table} SET scope_key = conversation_id WHERE scope_key IS NULL OR scope_key = ''`);
    }
  }
}

function migrateScopedPrimaryTables(db: Database): void {
  if (tableExists(db, "chat_bindings")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_bindings_scoped (
        scope_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL REFERENCES workspaces(name),
        updated_at INTEGER NOT NULL
      )
    `);
    db.run(`
      INSERT OR REPLACE INTO chat_bindings_scoped (scope_key, conversation_id, workspace_name, updated_at)
      SELECT COALESCE(NULLIF(scope_key, ''), conversation_id), conversation_id, workspace_name, updated_at
      FROM chat_bindings
    `);
    db.run("DROP TABLE chat_bindings");
    db.run("ALTER TABLE chat_bindings_scoped RENAME TO chat_bindings");
  }

  if (tableExists(db, "pending_prompts")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS pending_prompts_scoped (
        scope_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        prompt_message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_key TEXT,
        payload_json TEXT,
        expires_at INTEGER,
        PRIMARY KEY (scope_key, prompt_message_id)
      )
    `);
    db.run(`
      INSERT OR REPLACE INTO pending_prompts_scoped (scope_key, conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at)
      SELECT COALESCE(NULLIF(scope_key, ''), conversation_id), conversation_id, prompt_message_id, kind, created_at, session_key, payload_json, expires_at
      FROM pending_prompts
    `);
    db.run("DROP TABLE pending_prompts");
    db.run("ALTER TABLE pending_prompts_scoped RENAME TO pending_prompts");
  }

  if (tableExists(db, "chat_ui_state")) {
    db.run(`
      CREATE TABLE IF NOT EXISTS chat_ui_state_scoped (
        scope_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        console_message_id TEXT,
        home_status_mode TEXT NOT NULL DEFAULT 'compact'
      )
    `);
    db.run(`
      INSERT OR REPLACE INTO chat_ui_state_scoped (scope_key, conversation_id, console_message_id, home_status_mode)
      SELECT COALESCE(NULLIF(scope_key, ''), conversation_id), conversation_id, console_message_id, COALESCE(home_status_mode, 'compact')
      FROM chat_ui_state
    `);
    db.run("DROP TABLE chat_ui_state");
    db.run("ALTER TABLE chat_ui_state_scoped RENAME TO chat_ui_state");
  }
}

function createControlMessagesTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS control_messages (
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      kind TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, message_id)
    )
  `);
}

function tableExists(db: Database, table: string): boolean {
  const row = db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function columnExists(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}
