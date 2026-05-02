export type ChatId = number;
export type UserId = number;

export type TelegramParseMode = "HTML";

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageOptions {
  parseMode?: TelegramParseMode;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface EditMessageTextOptions extends SendMessageOptions {
  messageId: number;
}

export interface TextInboundMessage {
  kind: "message";
  id: string;
  chatId: ChatId;
  userId: UserId;
  text: string;
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
  sendMessage(chatId: ChatId, text: string, options?: SendMessageOptions): Promise<void>;
  editMessageText(chatId: ChatId, text: string, options: EditMessageTextOptions): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export type AgentOutputHandler = (event: AgentOutputEvent) => void | Promise<void>;
export type AgentExitHandler = (event: AgentExitEvent) => void | Promise<void>;

export interface AgentOutputEvent {
  sessionKey: string;
  chunk: string;
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
}

export interface StartAgentOptions {
  chatId: ChatId;
  workspaceName: string;
  workspacePath: string;
}

export interface AgentDriver {
  start(options: StartAgentOptions): Promise<AgentSessionStatus>;
  send(sessionKey: string, text: string): Promise<void>;
  stop(sessionKey: string): Promise<void>;
  getStatus(sessionKey: string): AgentSessionStatus | undefined;
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
