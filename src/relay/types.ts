import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../ports/agent.ts";

export interface WorkspaceRecord {
  name: string;
  path: string;
  createdAt: number;
}

export interface ConversationBinding {
  conversationId: ConversationId;
  scopeKey?: string;
  /** One active workspace is bound per IM conversation; agent sessions are keyed from this pair. */
  workspaceName: string;
  updatedAt: number;
}

export type TranscriptRole = "user" | "agent" | "system";

export interface TranscriptEvent {
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  role: TranscriptRole;
  text: string;
  createdAt: number;
}

export type PendingPromptKind = "workspace_name" | "codex_user_input" | "codex_approval" | "codex_mcp_elicitation" | "relay_command" | "side_conversation" | "media_action";

export interface PendingPrompt {
  conversationId: ConversationId;
  scopeKey?: string;
  /** IM message that should be replied to or updated when answering this prompt. */
  promptMessageId: MessageId;
  kind: PendingPromptKind;
  createdAt: number;
  /** Present for prompts tied to a specific Codex session and cleared when that session is reset. */
  sessionKey?: string;
  /** Small provider-independent state payload, such as source callback ids or question metadata. */
  payloadJson?: string;
  expiresAt?: number;
}

export type HomeStatusMode = "compact" | "details";

/**
 * Task states track both queued user prompts and the active Codex turn.
 *
 * `waiting` means a prompt was forwarded while Codex was already busy and is
 * expected to become the active turn once Codex accepts it. `queued` is an
 * explicit local queue entry that has not been sent to the agent yet.
 */
export type TaskStatus = "waiting" | "queued" | "running" | "blocked" | "done" | "failed" | "cancelled" | "interrupted";

export interface RelayTask {
  id: number;
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  text: string;
  inputJson?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** Provider turn id used to reconcile completion/blocking events back to a submitted task. */
  turnId?: string;
  /** Original IM message id, used for reactions and reply threading. */
  userMessageId?: MessageId;
  statusMessageId?: MessageId;
}

export type { AgentCollaborationMode, AgentTaskInput };
