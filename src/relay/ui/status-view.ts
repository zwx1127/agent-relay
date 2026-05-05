import type { AgentTokenUsage } from "../../ports/agent.ts";

export interface StatusView {
  workspaceName?: string;
  workspacePath?: string;
  running?: boolean;
  recentOutputAt?: number;
  recentError?: string;
  threadId?: string;
  threadName?: string;
  threadStatus?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: string;
  tokenUsage?: AgentTokenUsage;
  contextWindow?: number;
  waitingForUserInput?: boolean;
  waitingForApproval?: boolean;
  queuedTaskCount?: number;
  blockedTaskCount?: number;
  activeTaskId?: number;
  activeTaskStatus?: string;
}
