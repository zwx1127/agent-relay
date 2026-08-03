import type { Database } from "bun:sqlite";
import type { ConversationId } from "../../domain/ids.ts";
import type { Logger } from "../../domain/logger.ts";
import type { AgentCollaborationMode } from "../../ports/agent.ts";
import type { TranscriptEvent, TranscriptRole } from "../../relay/types.ts";
import type { AgentSessionRow, TranscriptRow } from "../sqlite-rows.ts";

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

  clear(scopeKey: ConversationId, workspaceName: string): void {
    this.db.query("DELETE FROM transcript_events WHERE scope_key = ? AND workspace_name = ?").run(String(scopeKey), workspaceName);
  }
}
