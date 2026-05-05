import type { ConversationId, MessageId } from "../core/ids.ts";
import type { AgentCollaborationMode, AgentTaskInput } from "../agents/types.ts";

export interface WorkspaceRecord {
  name: string;
  path: string;
  createdAt: number;
}

export interface ConversationBinding {
  conversationId: ConversationId;
  workspaceName: string;
  updatedAt: number;
}

export type TranscriptRole = "user" | "agent" | "system";

export interface TranscriptEvent {
  conversationId: ConversationId;
  workspaceName: string;
  role: TranscriptRole;
  text: string;
  createdAt: number;
}

export type PendingPromptKind = "workspace_name" | "codex_user_input" | "codex_approval" | "relay_command";

export interface PendingPrompt {
  conversationId: ConversationId;
  promptMessageId: MessageId;
  kind: PendingPromptKind;
  createdAt: number;
  sessionKey?: string;
  payloadJson?: string;
  expiresAt?: number;
}

export type HomeStatusMode = "compact" | "details";

export type TaskStatus = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";

export interface RelayTask {
  id: number;
  conversationId: ConversationId;
  workspaceName: string;
  text: string;
  inputJson?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  userMessageId?: MessageId;
  statusMessageId?: MessageId;
}

export type { AgentCollaborationMode, AgentTaskInput };
