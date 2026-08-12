import type { ConversationId } from "../../domain/ids.ts";
import { parseSessionKey, sessionKey } from "../../domain/session.ts";
import type { Logger } from "../../domain/logger.ts";
import type { AgentDriver, AgentSessionStatus } from "../../ports/agent.ts";
import type { EditMessageTextOptions, InlineKeyboardMarkup, SendMessageOptions } from "../../ports/im.ts";
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
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
}

export class BackgroundTerminalService {
  private readonly cards = new Map<string, { scopeKey: string; messageId: string | number }>();

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
    const previous = this.cards.get(key);
    if (previous) {
      this.cards.delete(key);
      this.deps.store.deletePendingPrompt(previous.scopeKey, previous.messageId);
      await this.deps.editRendered(
        previous.scopeKey,
        messageWithTitle("Background terminals list expired.", "Open the latest /ps card."),
        { messageId: previous.messageId, replyMarkup: { inline_keyboard: [] } },
      ).catch((error) => {
        this.deps.logger.warn("router.background_terminals_retire_failed", {
          session_key: key,
          message_id: previous.messageId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, formatBackgroundTerminalsMessage(terminals), {
      replyMarkup: backgroundTerminalsKeyboard(token, terminals),
    });
    if (result.messageId !== undefined) this.cards.set(key, { scopeKey: String(conversationId), messageId: result.messageId });
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

  async refreshSession(sessionKeyValue: string): Promise<void> {
    const parsed = parseSessionKey(sessionKeyValue);
    const card = this.cards.get(sessionKeyValue);
    if (!parsed || !card || !this.deps.agent.listBackgroundTerminals) return;
    const status = this.deps.agent.getStatus(sessionKeyValue);
    if (!status?.running) return;
    const terminals = await this.deps.agent.listBackgroundTerminals(sessionKeyValue);
    const token = shortToken();
    this.deps.store.deletePendingPrompt(card.scopeKey, card.messageId);
    try {
      await this.deps.editRendered(card.scopeKey, formatBackgroundTerminalsMessage(terminals), {
        messageId: card.messageId,
        replyMarkup: backgroundTerminalsKeyboard(token, terminals),
      });
    } catch (error) {
      this.cards.delete(sessionKeyValue);
      this.deps.logger.warn("router.background_terminals_refresh_failed", {
        session_key: sessionKeyValue,
        message_id: card.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      await this.render(parsed.scopeKey).catch((replacementError) => {
        this.deps.logger.warn("router.background_terminals_replacement_failed", {
          session_key: sessionKeyValue,
          error: replacementError instanceof Error ? replacementError : new Error(String(replacementError)),
        });
      });
      return;
    }
    if (terminals.length === 0) return;
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      scopeKey: card.scopeKey,
      promptMessageId: card.messageId,
      kind: "relay_command",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify({ command: "terminal", token, threadId: status.threadId, terminals }),
      expiresAt: Date.now() + CODEX_PROMPT_TTL_MS,
    });
  }

  async retireControls(sessionKeyValue: string): Promise<void> {
    const card = this.cards.get(sessionKeyValue);
    if (!card) return;
    this.deps.store.deletePendingPrompt(card.scopeKey, card.messageId);
    await this.deps.editRendered(
      card.scopeKey,
      messageWithTitle("Background terminal operation in progress.", "Controls will refresh when the shared operation finishes."),
      { messageId: card.messageId, replyMarkup: { inline_keyboard: [] } },
    ).catch((error) => {
      this.deps.logger.warn("router.background_terminals_retire_failed", {
        session_key: sessionKeyValue,
        message_id: card.messageId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
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
    const card = this.cards.get(key);
    if (card && String(card.messageId) === String(message.messageId)) this.cards.delete(key);
    await this.render(message.conversationId);
  }
}
