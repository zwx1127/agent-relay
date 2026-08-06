export interface AgentSendOptions {
  collaborationMode?: AgentCollaborationMode;
  /** True only when the user explicitly requested this mode transition. */
  collaborationModeExplicit?: boolean;
  attachments?: AgentInputAttachment[];
  /** Compatibility with tasks persisted before structured attachments were added. */
  images?: AgentImageInput[];
}

export type AgentCollaborationMode = "default" | "plan";

export interface AgentImageInput {
  path: string;
  caption?: string;
}

export type AgentInputAttachment =
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "localImage"; path: string; caption?: string; detail?: "auto" | "low" | "high" | "original" }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string; caption?: string; mimeType?: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface AgentTaskInput {
  text: string;
  attachments?: AgentInputAttachment[];
  /** Compatibility with tasks persisted before structured attachments were added. */
  images?: AgentImageInput[];
}

export interface AgentSendResult {
  turnId?: string;
  /** The requested collaboration mode was attached to a newly started turn. */
  collaborationModeApplied?: boolean;
}

export interface AgentInterruptResult {
  interrupted: boolean;
  turnId?: string;
  stale?: boolean;
}

export type AgentReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string | null }
  | { type: "custom"; instructions: string };

export type AgentBuiltinCommand =
  | { type: "review"; target?: AgentReviewTarget }
  | { type: "compact" };

export interface AgentBuiltinResult {
  message: string;
  turnId?: string;
  threadId?: string;
}
