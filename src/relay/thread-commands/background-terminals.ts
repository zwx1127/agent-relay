import type { ConversationId } from "../../domain/ids.ts";
import { sessionKey } from "../../domain/session.ts";
import type { Logger } from "../../domain/logger.ts";
import type { AgentDriver, AgentSessionStatus } from "../../ports/agent.ts";
import type { InlineKeyboardMarkup, SendMessageOptions } from "../../ports/im.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { RenderCallbackPageResult } from "../controller-types.ts";
import type { PendingPrompt, WorkspaceRecord } from "../types.ts";
import { CODEX_PROMPT_TTL_MS } from "../ui/constants.ts";
import { shortToken } from "../ui/callback-data.ts";
import { backgroundTerminalsKeyboard } from "../ui/keyboards.ts";
import { formatBackgroundTerminalsMessage } from "../ui/messages.ts";
import { asPromptRecord } from "../ui/prompt-state.ts";
import { messageWithTitle } from "../ui/text-parts.ts";
import type { CallbackMessage } from "./types.ts";

export interface BackgroundTerminalDeps {
  store: RelayStore;
  agent: AgentDriver;
  logger: Logger;
  commandSession(conversationId: ConversationId): Promise<{ workspace: WorkspaceRecord; status: AgentSessionStatus; key: string }>;
  requireCurrentWorkspace(conversationId: ConversationId): WorkspaceRecord;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: string | number }>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

export class BackgroundTerminalService {
  constructor(private readonly deps: BackgroundTerminalDeps) {}

  async clean(conversationId: ConversationId): Promise<void> {
    const { key } = await this.deps.commandSession(conversationId);
    if (!this.deps.agent.cleanBackgroundTerminals) throw new Error("Agent driver cannot clean background terminals.");
    await this.deps.agent.cleanBackgroundTerminals(key);
    this.deps.logger.info("router.background_terminals_cleaned", { conversation_id: conversationId, session_key: key });
    await this.deps.sendRendered(conversationId, messageWithTitle("Background terminals stopped."));
  }

  async render(conversationId: ConversationId): Promise<void> {
    const { key } = await this.deps.commandSession(conversationId);
    if (!this.deps.agent.listBackgroundTerminals) throw new Error("Agent driver cannot list background terminals.");
    const terminals = await this.deps.agent.listBackgroundTerminals(key);
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatBackgroundTerminalsMessage(terminals), {
      replyMarkup: backgroundTerminalsKeyboard(token, terminals),
    });
    if (result.messageId && terminals.length > 0) {
      this.deps.store.setPendingPrompt({
        conversationId,
        promptMessageId: result.messageId,
        kind: "relay_command",
        createdAt: Date.now(),
        sessionKey: key,
        payloadJson: JSON.stringify({ command: "terminal", token, threadId: this.deps.agent.getStatus(key)?.threadId, terminals }),
        expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
      });
    }
  }

  async stopFromCallback(message: CallbackMessage, pending: PendingPrompt, data: Record<string, unknown>, action: string | undefined): Promise<void> {
    const index = Number(action);
    const terminals = Array.isArray(data.terminals) ? data.terminals : [];
    const selected = asPromptRecord(terminals[index]);
    const processId = typeof selected?.processId === "string" ? selected.processId : undefined;
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name);
    const status = this.deps.agent.getStatus(key);
    if (!processId || !status?.running || status.threadId !== data.threadId || pending.sessionKey !== key || !this.deps.agent.terminateBackgroundTerminal) {
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.render(message.conversationId);
      return;
    }
    const terminated = await this.deps.agent.terminateBackgroundTerminal(key, processId);
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    if (!terminated) {
      await this.render(message.conversationId);
      return;
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Background terminal stopped."), { inline_keyboard: [] });
    await this.render(message.conversationId);
  }
}
