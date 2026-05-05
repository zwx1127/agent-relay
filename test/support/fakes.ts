import { sessionKey } from "../../src/domain/session.ts";
import type { ConversationId, MessageId } from "../../src/domain/ids.ts";
import type { AgentBuiltinCommand, AgentBuiltinResult, AgentDriver, AgentModelSummary, AgentSendOptions, AgentSessionStatus, AgentThreadListOptions, AgentThreadSummary } from "../../src/ports/agent.ts";
import type { EditMessageTextOptions, SendMessageOptions } from "../../src/ports/im.ts";

export class FakeImAdapter {
  readonly providerId = "fake";
  readonly capabilities = {
    editMessage: true,
    forceReply: true,
    inlineActions: true,
    reactions: true,
    typing: true,
    mediaDownload: true,
    imageUpload: true,
  };
  sent: Array<{ conversationId: ConversationId; text: string; options?: SendMessageOptions; messageId?: number }> = [];
  photos: Array<{ conversationId: ConversationId; photo: Blob; options?: unknown; messageId?: number }> = [];
  edited: Array<{ conversationId: ConversationId; text: string; options: EditMessageTextOptions }> = [];
  answered: Array<{ callbackQueryId: string; text?: string }> = [];
  chatActions: Array<{ conversationId: ConversationId; action?: "typing" }> = [];
  reactions: Array<{ conversationId: ConversationId; messageId: MessageId; emoji?: string }> = [];
  downloads = new Map<string, ArrayBuffer>();
  nextMessageId = 100;
  sendMessageDelayMs = 0;
  failSendMessage?: Error;
  failEditMessage?: Error;
  failReaction?: Error;

  async sendMessage(conversationId: ConversationId, text: string, options?: SendMessageOptions): Promise<{ messageId?: number }> {
    if (this.sendMessageDelayMs > 0) await sleep(this.sendMessageDelayMs);
    if (this.failSendMessage) throw this.failSendMessage;
    const messageId = this.nextMessageId++;
    this.sent.push({ conversationId, text, options, messageId });
    return { messageId };
  }

  async sendPhoto(conversationId: ConversationId, photo: Blob, options?: unknown): Promise<{ messageId?: number }> {
    const messageId = this.nextMessageId++;
    this.photos.push({ conversationId, photo, options, messageId });
    return { messageId };
  }

  async downloadFile(fileId: string): Promise<{ bytes: ArrayBuffer; filePath?: string; fileSize?: number }> {
    return {
      bytes: this.downloads.get(fileId) ?? new TextEncoder().encode("image").buffer,
      filePath: "photos/image.jpg",
    };
  }

  async editMessageText(conversationId: ConversationId, text: string, options: EditMessageTextOptions): Promise<void> {
    if (this.failEditMessage) throw this.failEditMessage;
    this.edited.push({ conversationId, text, options });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    this.answered.push({ callbackQueryId, text });
  }

  async sendChatAction(conversationId: ConversationId, action?: "typing"): Promise<void> {
    this.chatActions.push({ conversationId, action });
  }

  async setMessageReaction(conversationId: ConversationId, messageId: MessageId, emoji?: string): Promise<void> {
    if (this.failReaction) throw this.failReaction;
    this.reactions.push({ conversationId, messageId, emoji });
  }
}

export class FakeAgent implements AgentDriver {
  statuses = new Map<string, AgentSessionStatus>();
  sent: Array<{ key: string; text: string; options?: AgentSendOptions }> = [];
  stopped: string[] = [];
  responses: Array<{ key: string; requestId: string | number; result: unknown }> = [];
  builtins: Array<{ key: string; command: AgentBuiltinCommand }> = [];
  forks: string[] = [];
  renames: Array<{ key: string; name: string }> = [];
  cleaned: string[] = [];
  threadLists: AgentThreadListOptions[] = [];
  threads: AgentThreadSummary[] = [];
  models: AgentModelSummary[] = [];
  failSend?: Error;

  async start(options: { conversationId: ConversationId; workspaceName: string; workspacePath: string; threadId?: string }): Promise<AgentSessionStatus> {
    const key = sessionKey(options.conversationId, options.workspaceName);
    const status = {
      sessionKey: key,
      conversationId: options.conversationId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: 1,
      threadId: options.threadId ?? `thread-${this.statuses.size + 1}`,
    };
    this.statuses.set(key, status);
    return status;
  }

  async send(key: string, text: string, options?: AgentSendOptions): Promise<{ turnId?: string }> {
    if (this.failSend) throw this.failSend;
    this.sent.push({ key, text, ...(options ? { options } : {}) });
    const status = this.statuses.get(key);
    if (status?.activeTurnId) return { turnId: status.activeTurnId };
    const turnId = `turn-${this.sent.length}`;
    if (status) status.activeTurnId = turnId;
    return { turnId };
  }

  async stop(key: string): Promise<void> {
    this.stopped.push(key);
    this.statuses.delete(key);
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.statuses.get(key);
  }

  async respond(key: string, requestId: string | number, result: unknown): Promise<void> {
    this.responses.push({ key, requestId, result });
  }

  async runBuiltinCommand(key: string, command: AgentBuiltinCommand): Promise<AgentBuiltinResult> {
    this.builtins.push({ key, command });
    return { message: command.type === "review" ? "Review started." : "Compaction started." };
  }

  async forkThread(key: string): Promise<{ threadId: string; threadName?: string }> {
    this.forks.push(key);
    const status = this.statuses.get(key);
    if (status) {
      status.threadId = "fork-thread";
      status.threadName = "Forked";
    }
    return { threadId: "fork-thread", threadName: "Forked" };
  }

  async renameThread(key: string, name: string): Promise<void> {
    this.renames.push({ key, name });
    const status = this.statuses.get(key);
    if (status) status.threadName = name;
  }

  async cleanBackgroundTerminals(key: string): Promise<void> {
    this.cleaned.push(key);
  }

  async listThreads(options: AgentThreadListOptions): Promise<AgentThreadSummary[]> {
    this.threadLists.push(options);
    return this.threads;
  }

  async listModels(): Promise<AgentModelSummary[]> {
    return this.models;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
