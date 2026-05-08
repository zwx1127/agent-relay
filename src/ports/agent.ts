import type { ConversationId, ProviderId } from "../domain/ids.ts";

export type AgentOutputHandler = (event: AgentOutputEvent) => void | Promise<void>;
export type AgentExitHandler = (event: AgentExitEvent) => void | Promise<void>;

export type AgentOutputEvent =
  | AgentMessageOutputEvent
  | AgentImageOutputEvent
  | AgentTurnCompletedEvent
  | AgentUserInputRequestEvent
  | AgentApprovalRequestEvent;

export interface AgentMessageOutputEvent {
  type?: "message";
  sessionKey: string;
  chunk: string;
  turnId?: string;
  itemId?: string;
}

export interface AgentImageOutputEvent {
  type: "image";
  sessionKey: string;
  path?: string;
  data?: string;
  mimeType?: string;
  caption?: string;
  turnId?: string;
  itemId?: string;
}

export interface AgentTurnCompletedEvent {
  type: "turn_completed";
  sessionKey: string;
  turnId?: string;
}

export interface AgentUserInputOption {
  label: string;
  description: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isSecret?: boolean;
  isOther?: boolean;
  options?: AgentUserInputOption[] | null;
}

export interface AgentUserInputRequestEvent {
  type: "user_input_request";
  sessionKey: string;
  requestId: string | number;
  questions: AgentUserInputQuestion[];
  turnId?: string;
  itemId?: string;
}

export type AgentApprovalKind =
  | "command"
  | "file_change"
  | "permissions"
  | "legacy_command"
  | "legacy_patch";

export interface AgentApprovalRequestEvent {
  type: "approval_request";
  sessionKey: string;
  requestId: string | number;
  method: string;
  approvalKind: AgentApprovalKind;
  title: string;
  body: string;
  params: unknown;
  turnId?: string;
  itemId?: string;
}

export interface AgentExitEvent {
  sessionKey: string;
  exitCode: number | null;
  signalCode: string | null;
}

export interface AgentSessionStatus {
  sessionKey: string;
  conversationId: ConversationId;
  workspaceName: string;
  workspacePath: string;
  running: boolean;
  startedAt: number;
  threadId?: string;
  threadName?: string;
  threadStatus?: string;
  activeTurnId?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: string;
  instructionSources?: string[];
  tokenUsage?: AgentTokenUsage;
  contextWindow?: number;
  waitingForUserInput?: boolean;
  waitingForApproval?: boolean;
  recentError?: string;
}

export interface StartAgentOptions {
  conversationId: ConversationId;
  workspaceName: string;
  workspacePath: string;
  threadId?: string;
}

export interface AgentDriver {
  readonly providerId?: ProviderId;
  readonly capabilities?: Partial<AgentDriverCapabilities>;
  start(options: StartAgentOptions): Promise<AgentSessionStatus>;
  send(sessionKey: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  stop(sessionKey: string): Promise<void>;
  getStatus(sessionKey: string): AgentSessionStatus | undefined;
  respond?(sessionKey: string, requestId: string | number, result: unknown): Promise<void>;
  runBuiltinCommand?(sessionKey: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult>;
  getThreadGoal?(sessionKey: string): Promise<AgentThreadGoal | null>;
  setThreadGoal?(sessionKey: string, goal: AgentThreadGoalSetOptions): Promise<AgentThreadGoal>;
  clearThreadGoal?(sessionKey: string): Promise<boolean>;
  forkThread?(sessionKey: string): Promise<AgentThreadSwitchResult>;
  renameThread?(sessionKey: string, name: string): Promise<void>;
  cleanBackgroundTerminals?(sessionKey: string): Promise<void>;
  listBackgroundTerminals?(sessionKey: string): Promise<AgentBackgroundTerminalSummary[]>;
  listThreads?(options: AgentThreadListOptions): Promise<AgentThreadSummary[]>;
  listModels?(): Promise<AgentModelSummary[]>;
}

export interface AgentDriverCapabilities {
  userInputRequests: boolean;
  approvals: boolean;
  builtinCommands: boolean;
  threadFork: boolean;
  threadRename: boolean;
  threadGoals: boolean;
  threadList: boolean;
  modelList: boolean;
  backgroundTerminals: boolean;
  localImages: boolean;
  imageOutput: boolean;
}

export interface AgentSendOptions {
  collaborationMode?: AgentCollaborationMode;
  images?: AgentImageInput[];
}

export type AgentCollaborationMode = "default" | "plan";

export interface AgentImageInput {
  path: string;
  caption?: string;
}

export interface AgentTaskInput {
  text: string;
  images?: AgentImageInput[];
}

export interface AgentSendResult {
  turnId?: string;
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

export type AgentThreadGoalStatus = "active" | "paused" | "budgetLimited" | "complete";

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
  commandDisplay: string;
  recentChunks: string[];
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
