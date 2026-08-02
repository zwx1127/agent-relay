import type { ConversationId, ProviderId } from "../domain/ids.ts";

export type AgentOutputHandler = (event: AgentOutputEvent) => void | Promise<void>;
export type AgentExitHandler = (event: AgentExitEvent) => void | Promise<void>;

export type AgentOutputEvent =
  | AgentMessageOutputEvent
  | AgentImageOutputEvent
  | AgentActivityEvent
  | AgentTurnCompletedEvent
  | AgentUserInputRequestEvent
  | AgentApprovalRequestEvent
  | AgentMcpElicitationRequestEvent
  | AgentThreadLifecycleEvent;

/**
 * Streaming text output from an agent turn.
 *
 * `type` is optional for compatibility with older Codex app-server message
 * notifications that only carried a chunk payload.
 */
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
  /** Optional only for compatibility with older provider test doubles. */
  status?: AgentTurnStatus;
  error?: AgentTurnError;
  durationMs?: number;
}

export interface AgentActivityEvent {
  type: "activity";
  sessionKey: string;
  activity: AgentActivity;
  turnId?: string;
  itemId?: string;
}

export type AgentActivity =
  | { kind: "reasoning"; summary: string; sectionIndex?: number }
  | { kind: "plan"; explanation?: string; steps: AgentPlanStep[] }
  | { kind: "diff"; diff: string }
  | {
      kind: "item";
      category: AgentActivityCategory;
      label: string;
      status: AgentActivityStatus;
      detail?: string;
      durationMs?: number;
      files?: AgentActivityFile[];
    }
  | { kind: "notice"; level: "info" | "warning" | "error"; title: string; detail?: string }
  | { kind: "goal"; goal: AgentThreadGoal | null }
  | { kind: "settings"; changes: Record<string, string> };

export type AgentActivityCategory =
  | "command"
  | "fileChange"
  | "mcp"
  | "webSearch"
  | "collaboration"
  | "image"
  | "compaction"
  | "review"
  | "hook"
  | "guardian"
  | "model"
  | "other";

export type AgentActivityStatus = "started" | "inProgress" | "completed" | "failed" | "declined" | "interrupted" | "warning";

export interface AgentActivityFile {
  path: string;
  kind?: string;
}

export interface AgentPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export type AgentTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface AgentTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string;
}

export interface AgentUserInputOption {
  label: string;
  description: string;
}

export interface AgentUserInputQuestion {
  id: string;
  header: string;
  question: string;
  /** Secret answers should be collected through provider flows that do not echo the value. */
  isSecret?: boolean;
  /** Allows the user to provide free text instead of choosing one of `options`. */
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
  /** Raw provider method name, retained so adapters can support new approval methods before a type is added. */
  method: string;
  approvalKind: AgentApprovalKind;
  title: string;
  body: string;
  params: unknown;
  turnId?: string;
  itemId?: string;
}

export interface AgentMcpElicitationRequestEvent {
  type: "mcp_elicitation_request";
  sessionKey: string;
  requestId: string | number;
  serverName: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: AgentMcpElicitationSchema;
  url?: string;
  elicitationId?: string;
  meta?: unknown;
  turnId?: string;
}

export interface AgentMcpElicitationSchema {
  type: "object";
  properties: Record<string, AgentMcpElicitationFieldSchema>;
  required?: string[];
}

export type AgentMcpElicitationFieldSchema = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: "email" | "uri" | "date" | "date-time";
  enum?: unknown[];
  enumNames?: string[];
  items?: { type?: string; enum?: unknown[] };
  minItems?: number;
  maxItems?: number;
};

export interface AgentThreadLifecycleEvent {
  type: "thread_lifecycle";
  sessionKey: string;
  threadId: string;
  action: "archived" | "deleted" | "closed";
  initiatedByClient?: boolean;
}

export interface AgentExitEvent {
  sessionKey: string;
  exitCode: number | null;
  signalCode: string | null;
}

export interface AgentSessionStatus {
  sessionKey: string;
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  workspacePath: string;
  running: boolean;
  startedAt: number;
  /** Agent-native thread id used for resume, fork, and side-conversation flows. */
  threadId?: string;
  threadName?: string;
  threadStatus?: string;
  /** Present while the provider believes subsequent input should steer an in-flight turn. */
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
  /** These flags block normal prompt submission until the user answers or interrupts. */
  waitingForUserInput?: boolean;
  waitingForApproval?: boolean;
  recentWarning?: string;
  recentError?: string;
  appServerVersion?: string;
  reviewInProgress?: boolean;
  threadGoal?: AgentThreadGoal | null;
}

export interface StartAgentOptions {
  conversationId: ConversationId;
  scopeKey?: string;
  workspaceName: string;
  workspacePath: string;
  threadId?: string;
}

export interface AgentDriver {
  readonly providerId?: ProviderId;
  /** Feature flags are advisory; callers still guard each optional method before invoking it. */
  readonly capabilities?: Partial<AgentDriverCapabilities>;
  start(options: StartAgentOptions): Promise<AgentSessionStatus>;
  send(sessionKey: string, text: string, options?: AgentSendOptions): Promise<AgentSendResult>;
  stop(sessionKey: string): Promise<void>;
  getStatus(sessionKey: string): AgentSessionStatus | undefined;
  interrupt?(sessionKey: string): Promise<AgentInterruptResult>;
  respond?(sessionKey: string, requestId: string | number, result: unknown): Promise<void>;
  runBuiltinCommand?(sessionKey: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult>;
  getThreadGoal?(sessionKey: string): Promise<AgentThreadGoal | null>;
  setThreadGoal?(sessionKey: string, goal: AgentThreadGoalSetOptions): Promise<AgentThreadGoal>;
  clearThreadGoal?(sessionKey: string): Promise<boolean>;
  forkThread?(sessionKey: string): Promise<AgentThreadSwitchResult>;
  sideConversation?(sessionKey: string, text: string): Promise<AgentSideConversationResult>;
  renameThread?(sessionKey: string, name: string): Promise<void>;
  archiveThread?(sessionKey: string): Promise<void>;
  deleteThread?(sessionKey: string): Promise<void>;
  cleanBackgroundTerminals?(sessionKey: string): Promise<void>;
  terminateBackgroundTerminal?(sessionKey: string, processId: string): Promise<boolean>;
  listBackgroundTerminals?(sessionKey: string): Promise<AgentBackgroundTerminalSummary[]>;
  listThreads?(options: AgentThreadListOptions): Promise<AgentThreadSummary[]>;
  listModels?(): Promise<AgentModelSummary[]>;
  listSkills?(workspacePath: string, options?: AgentSkillListOptions): Promise<AgentSkillSummary[]>;
  searchFiles?(workspacePath: string, query: string, options?: AgentFileSearchOptions): Promise<AgentFileSearchResult[]>;
}

export interface AgentDriverCapabilities {
  userInputRequests: boolean;
  approvals: boolean;
  builtinCommands: boolean;
  threadFork: boolean;
  sideConversation: boolean;
  threadRename: boolean;
  threadArchive: boolean;
  threadDelete: boolean;
  threadGoals: boolean;
  threadList: boolean;
  modelList: boolean;
  backgroundTerminals: boolean;
  localImages: boolean;
  structuredInputs: boolean;
  localAudio: boolean;
  skillList: boolean;
  fileSearch: boolean;
  imageOutput: boolean;
  interrupt: boolean;
}

export interface AgentSendOptions {
  collaborationMode?: AgentCollaborationMode;
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

export interface AgentSideConversationResult {
  message: string;
  threadId?: string;
  turnId?: string;
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
