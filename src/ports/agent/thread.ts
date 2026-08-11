export type AgentThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface AgentThreadGoal {
  threadId: string;
  objective: string;
  status: AgentThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentThreadGoalSetOptions {
  objective?: string | null;
  status?: AgentThreadGoalStatus | null;
  tokenBudget?: number | null;
}

export interface AgentThreadSwitchResult {
  threadId: string;
  threadName?: string;
}

export interface AgentBackgroundTerminalSummary {
  itemId?: string;
  processId?: string;
  commandDisplay: string;
  cwd?: string;
  osPid?: number | null;
  cpuPercent?: number | null;
  rssKb?: number | null;
  recentChunks?: string[];
}

export interface AgentThreadListOptions {
  workspacePath: string;
  limit?: number;
  searchTerm?: string;
}

export interface AgentThreadSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  status?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface AgentModelSummary {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}

export interface AgentSkillListOptions {
  forceReload?: boolean;
}

export interface AgentSkillSummary {
  name: string;
  path: string;
  description?: string;
  shortDescription?: string;
  scope?: string;
  enabled: boolean;
}

export interface AgentFileSearchOptions {
  limit?: number;
}

export interface AgentFileSearchResult {
  root: string;
  path: string;
  fileName: string;
  score?: number;
  matchType?: string;
}

export interface AgentTokenBreakdown {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface AgentTokenUsage {
  last?: AgentTokenBreakdown;
  total?: AgentTokenBreakdown;
}
