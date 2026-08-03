import type { Database } from "bun:sqlite";
import type { ConversationId, MessageId } from "../../domain/ids.ts";
import { conversationIdForScope } from "../../domain/scope.ts";
import type { HomeStatusMode } from "../../relay/types.ts";
import {
  rowToPagedOutput,
  type ChatUiStateRow,
  type PagedOutput,
  type PagedOutputRow,
} from "../sqlite-rows.ts";

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

  deleteForSession(sessionKey: string): void {
    this.db.query("DELETE FROM paged_outputs WHERE session_key = ?").run(sessionKey);
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
