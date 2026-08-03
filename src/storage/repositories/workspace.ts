import type { Database } from "bun:sqlite";
import type { ConversationId } from "../../domain/ids.ts";
import { conversationIdForScope } from "../../domain/scope.ts";
import type { ConversationBinding, WorkspaceRecord } from "../../relay/types.ts";
import { rowToWorkspace, type BindingRow, type WorkspaceRow } from "../sqlite-rows.ts";

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
