export type ProviderId = string;
export type ConversationId = string | number;
export type UserId = string | number;
export type MessageId = string | number;

export type TextParseMode = "HTML";

export type TextEntityType =
  | "bold"
  | "italic"
  | "code"
  | "pre"
  | "text_link"
  | "blockquote";

export interface TextEntity {
  type: TextEntityType;
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
  parseMode?: TextParseMode;
  entities?: TextEntity[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  disableWebPagePreview?: boolean;
  replyToMessageId?: MessageId;
}

export interface EditMessageTextOptions extends SendMessageOptions {
  messageId: MessageId;
}

export interface SendMessageResult {
  messageId?: MessageId;
}

export interface SendPhotoOptions {
  caption?: string;
  replyToMessageId?: MessageId;
}

export interface InboundMediaFile {
  fileId: string;
  fileUniqueId?: string;
  width: number;
  height: number;
  fileSize?: number;
}

export interface DownloadedFile {
  bytes: ArrayBuffer;
  filePath?: string;
  fileSize?: number;
}

export interface TextInboundMessage {
  kind: "message";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  text: string;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface MediaInboundMessage {
  kind: "media";
  id: string;
  messageId: MessageId;
  conversationId: ConversationId;
  userId: UserId;
  caption?: string;
  photos: InboundMediaFile[];
  mediaGroupId?: string;
  replyToMessageId?: MessageId;
  date?: number;
}

export interface CallbackInboundMessage {
  kind: "callback_query";
  id: string;
  conversationId: ConversationId;
  userId: UserId;
  callbackQueryId: string;
  messageId?: MessageId;
  data: string;
  date?: number;
}

export type InboundMessage = TextInboundMessage | MediaInboundMessage | CallbackInboundMessage;

export interface MessagingAdapterCapabilities {
  editMessage: boolean;
  forceReply: boolean;
  inlineActions: boolean;
  reactions: boolean;
  typing: boolean;
  mediaDownload: boolean;
  imageUpload: boolean;
}

export interface MessagingAdapter {
  readonly providerId: ProviderId;
  readonly capabilities: MessagingAdapterCapabilities;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop?(): void;
  sendMessage(conversationId: ConversationId, text: string, options?: SendMessageOptions): Promise<SendMessageResult>;
  sendPhoto?(conversationId: ConversationId, photo: Blob, options?: SendPhotoOptions): Promise<SendMessageResult>;
  editMessageText?(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
  sendChatAction?(conversationId: ConversationId, action?: "typing"): Promise<void>;
  setMessageReaction?(conversationId: ConversationId, messageId: MessageId, emoji?: string): Promise<void>;
  downloadFile?(fileId: string): Promise<DownloadedFile>;
}

export type IMAdapter = MessagingAdapter;
export type TelegramParseMode = TextParseMode;
export type TelegramMessageEntityType = TextEntityType;
export type TelegramMessageEntity = TextEntity;
export type TelegramInboundPhoto = InboundMediaFile;
export type TelegramDownloadedFile = DownloadedFile;

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
  forkThread?(sessionKey: string): Promise<AgentThreadSwitchResult>;
  renameThread?(sessionKey: string, name: string): Promise<void>;
  cleanBackgroundTerminals?(sessionKey: string): Promise<void>;
  listThreads?(options: AgentThreadListOptions): Promise<AgentThreadSummary[]>;
  listModels?(): Promise<AgentModelSummary[]>;
}

export interface AgentDriverCapabilities {
  userInputRequests: boolean;
  approvals: boolean;
  builtinCommands: boolean;
  threadFork: boolean;
  threadRename: boolean;
  threadList: boolean;
  modelList: boolean;
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

export interface AgentThreadSwitchResult {
  threadId: string;
  threadName?: string;
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
