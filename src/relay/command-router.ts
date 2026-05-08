import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { InboundMessage } from "../ports/im.ts";
import { commandArgs, commandName } from "./ui/commands.ts";

type TextMessage = Extract<InboundMessage, { kind: "message" }>;

export interface SlashCommandHandlers {
  review(conversationId: ConversationId, text: string): Promise<void>;
  compact(conversationId: ConversationId): Promise<void>;
  init(conversationId: ConversationId, userMessageId?: MessageId): Promise<void>;
  newThread(conversationId: ConversationId): Promise<void>;
  resume(conversationId: ConversationId, searchTerm: string): Promise<void>;
  fork(conversationId: ConversationId): Promise<void>;
  rename(conversationId: ConversationId, name: string): Promise<void>;
  plan(conversationId: ConversationId, prompt: string, userMessageId?: MessageId): Promise<void>;
  goal(conversationId: ConversationId, args: string): Promise<void>;
  interrupt(conversationId: ConversationId, args: string): Promise<void>;
  ps(conversationId: ConversationId): Promise<void>;
  stop(conversationId: ConversationId): Promise<void>;
}

export class SlashCommandRouter {
  constructor(private readonly handlers: SlashCommandHandlers) {}

  command(text: string): string | undefined {
    return text.startsWith("/") ? commandName(text) : undefined;
  }

  async handle(message: TextMessage, command: string, text: string): Promise<boolean> {
    switch (command) {
      case "/review":
        await this.handlers.review(message.conversationId, text);
        return true;
      case "/compact":
        await this.handlers.compact(message.conversationId);
        return true;
      case "/init":
        await this.handlers.init(message.conversationId, message.messageId);
        return true;
      case "/new":
      case "/clear":
        await this.handlers.newThread(message.conversationId);
        return true;
      case "/resume":
        await this.handlers.resume(message.conversationId, commandArgs(text));
        return true;
      case "/fork":
        await this.handlers.fork(message.conversationId);
        return true;
      case "/rename":
        await this.handlers.rename(message.conversationId, commandArgs(text));
        return true;
      case "/plan":
        await this.handlers.plan(message.conversationId, commandArgs(text), message.messageId);
        return true;
      case "/goal":
        await this.handlers.goal(message.conversationId, commandArgs(text));
        return true;
      case "/interrupt":
        await this.handlers.interrupt(message.conversationId, commandArgs(text));
        return true;
      case "/ps":
        await this.handlers.ps(message.conversationId);
        return true;
      case "/stop":
        await this.handlers.stop(message.conversationId);
        return true;
      default:
        return false;
    }
  }
}
