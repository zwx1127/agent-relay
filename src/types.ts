export type ChatId = number;
export type UserId = number;

export type TelegramParseMode = "HTML";

export type TelegramMessageEntityType =
  | "bold"
  | "italic"
  | "code"
  | "pre"
  | "text_link"
  | "blockquote";

export interface TelegramMessageEntity {
  type: TelegramMessageEntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  parseMode?: TelegramParseMode;
  entities?: TelegramMessageEntity[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
}

export interface EditMessageTextOptions extends SendMessageOptions {
  messageId: number;
}

export interface SendMessageResult {
  messageId?: number;
}

export interface TextInboundMessage {
  kind: "message";
  id: string;
  messageId: number;
  chatId: ChatId;
  userId: UserId;
  text: string;
  replyToMessageId?: number;
  date?: number;
}

export interface CallbackInboundMessage {
  kind: "callback_query";
  id: string;
  chatId: ChatId;
  userId: UserId;
  callbackQueryId: string;
  messageId?: number;
  data: string;
  date?: number;
}

export type InboundMessage = TextInboundMessage | CallbackInboundMessage;

export interface IMAdapter {
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  sendMessage(chatId: ChatId, text: string, options?: SendMessageOptions): Promise<SendMessageResult>;
  editMessageText(chatId: ChatId, text: string, options: EditMessageTextOptions): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction(chatId: ChatId, action?: "typing"): Promise<void>;
}

export type AgentOutputHandler = (event: AgentOutputEvent) => void | Promise<void>;
export type AgentExitHandler = (event: AgentExitEvent) => void | Promise<void>;

export type AgentOutputEvent =
  | AgentMessageOutputEvent
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
  chatId: ChatId;
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
  chatId: ChatId;
  workspaceName: string;
  workspacePath: string;
  threadId?: string;
}

export interface AgentDriver {
  start(options: StartAgentOptions): Promise<AgentSessionStatus>;
  send(sessionKey: string, text: string): Promise<AgentSendResult>;
  stop(sessionKey: string): Promise<void>;
  getStatus(sessionKey: string): AgentSessionStatus | undefined;
  respond?(sessionKey: string, requestId: string | number, result: unknown): Promise<void>;
  runBuiltinCommand?(sessionKey: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult>;
  listThreads?(options: AgentThreadListOptions): Promise<AgentThreadSummary[]>;
  listModels?(): Promise<AgentModelSummary[]>;
}

export interface AgentSendResult {
  turnId?: string;
}

export type AgentBuiltinCommand = "review" | "compact";

export interface AgentBuiltinResult {
  message: string;
  turnId?: string;
  threadId?: string;
}

export interface AgentThreadListOptions {
  workspacePath: string;
  limit?: number;
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

export interface WorkspaceRecord {
  name: string;
  path: string;
  createdAt: number;
}

export interface ChatBinding {
  chatId: ChatId;
  workspaceName: string;
  updatedAt: number;
}

export type TranscriptRole = "user" | "agent" | "system";

export interface TranscriptEvent {
  chatId: ChatId;
  workspaceName: string;
  role: TranscriptRole;
  text: string;
  createdAt: number;
}

export type PendingPromptKind = "workspace_name" | "codex_user_input" | "codex_approval";

export interface PendingPrompt {
  chatId: ChatId;
  promptMessageId: number;
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
  chatId: ChatId;
  workspaceName: string;
  text: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  userMessageId?: number;
  statusMessageId?: number;
}
