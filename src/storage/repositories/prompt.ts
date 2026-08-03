import type { Database } from "bun:sqlite";
import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { PendingPrompt } from "../../relay/types.ts";
import { rowToPendingPrompt, type PendingPromptRow } from "../sqlite-rows.ts";

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
