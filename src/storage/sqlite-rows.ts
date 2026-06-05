import type { ConversationId } from "../domain/ids.ts";
import type { PendingPrompt, PendingPromptKind, RelayTask, TaskStatus, WorkspaceRecord } from "../relay/types.ts";

export interface WorkspaceRow {
  name: string;
  path: string;
  created_at: number;
}

export interface BindingRow {
  conversation_id: string;
  workspace_name: string;
  updated_at: number;
}

export interface TranscriptRow {
  conversation_id: string;
  text: string;
  created_at?: number;
}

export interface PendingPromptRow {
  conversation_id: string;
  prompt_message_id: string;
  kind: string;
  created_at: number;
  session_key?: string | null;
  payload_json?: string | null;
  expires_at?: number | null;
}

export interface AgentSessionRow {
  session_key: string;
  conversation_id: string;
  workspace_name: string;
  status: string;
  started_at: number;
  stopped_at?: number | null;
  thread_id?: string | null;
  collaboration_mode?: string | null;
  collaboration_thread_id?: string | null;
}

export interface PagedOutputRow {
  token: string;
  conversation_id: string;
  session_key: string;
  text: string;
  created_at: number;
  expires_at: number;
}

export interface ChatUiStateRow {
  conversation_id: string;
  console_message_id?: string | null;
  home_status_mode?: string | null;
}

export interface TaskRow {
  id: number;
  conversation_id: string;
  workspace_name: string;
  text: string;
  input_json?: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  turn_id?: string | null;
  user_message_id?: string | null;
  status_message_id?: string | null;
}

export interface PagedOutput {
  token: string;
  conversationId: ConversationId;
  sessionKey: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

export function rowToWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return { name: row.name, path: row.path, createdAt: row.created_at };
}

export function rowToPendingPrompt(row: PendingPromptRow): PendingPrompt {
  return {
    conversationId: row.conversation_id,
    promptMessageId: row.prompt_message_id,
    kind: row.kind as PendingPromptKind,
    createdAt: row.created_at,
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.payload_json ? { payloadJson: row.payload_json } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

export function rowToPagedOutput(row: PagedOutputRow): PagedOutput {
  return {
    token: row.token,
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    text: row.text,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function rowToTask(row: TaskRow): RelayTask {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceName: row.workspace_name,
    text: row.text,
    ...(row.input_json ? { inputJson: row.input_json } : {}),
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.user_message_id ? { userMessageId: row.user_message_id } : {}),
    ...(row.status_message_id ? { statusMessageId: row.status_message_id } : {}),
  };
}
