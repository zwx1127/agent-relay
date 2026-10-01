import type { AgentModelSummary } from "../../ports/agent.ts";
import type { ThreadCommandDeps } from "../thread-command-service.ts";
import type { ConversationId } from "../../domain/ids.ts";
import type { InboundMessage, InlineKeyboardMarkup } from "../../ports/im.ts";
import type { PendingPrompt } from "../types.ts";
import { sessionKey } from "../../domain/session.ts";
import { parseChatScopeKey } from "../../domain/scope.ts";
import { shortToken } from "../ui/callback-data.ts";
import { asPromptRecord } from "../ui/prompt-state.ts";
import { messageWithTitle } from "../ui/text-parts.ts";

type Callback = Extract<InboundMessage, { kind: "callback_query" }>;
const PAGE_SIZE = 8;

/** Remote presentation of a native model picker; values stay opaque to Relay. */
export class NativeModelPicker {
  constructor(private readonly deps: Pick<ThreadCommandDeps, "agent" | "store" | "requireCurrentWorkspace" | "ensureAgentStarted" | "sendRendered" | "renderStrictCallbackPage" | "expireCallbackPrompt">) {}

  async render(conversationId: ConversationId): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(conversationId);
    const status = await this.deps.ensureAgentStarted(conversationId, workspace);
    if (status.activeTurnId || status.waitingForApproval || status.waitingForUserInput) throw new Error("Wait for the current turn before changing the native model.");
    if (!this.deps.agent.listModels || !this.deps.agent.setModel) throw new Error("This backend does not expose a remote model picker.");
    const models = await this.deps.agent.listModels();
    if (!models.length) throw new Error("No models were advertised by the native backend. Check its local provider configuration.");
    const token = shortToken();
    const result = await this.deps.sendRendered(conversationId, messageWithTitle("Select native model", "Choose from the backend's current model catalog."), { replyMarkup: keyboard(token, models, 0) });
    if (result.messageId === undefined) throw new Error("The messaging provider did not return a model picker message id.");
    const scope = parseChatScopeKey(String(conversationId));
    this.deps.store.setPendingPrompt({ conversationId: scope.conversationId, scopeKey: scope.scopeKey, promptMessageId: result.messageId,
      kind: "relay_command", sessionKey: status.sessionKey, createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000,
      payloadJson: JSON.stringify({ command: "model", token, threadId: status.threadId, models }) });
  }

  async handle(message: Callback, pending: PendingPrompt, data: Record<string, unknown>, action?: string): Promise<void> {
    const workspace = this.deps.requireCurrentWorkspace(message.conversationId);
    const key = sessionKey(message.conversationId, workspace.name, this.deps.agent.providerId);
    const status = this.deps.agent.getStatus(key);
    if (data.command !== "model" || pending.sessionKey !== key || !status?.running || status.threadId !== data.threadId) {
      await this.deps.expireCallbackPrompt(message); return;
    }
    const models = Array.isArray(data.models) ? data.models.map(asPromptRecord).filter((model): model is Record<string, unknown> => typeof model?.id === "string") as unknown as AgentModelSummary[] : [];
    if (action === "cancel") {
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Model selection cancelled."), { inline_keyboard: [] }); return;
    }
    if (action?.startsWith("p")) {
      const page = Number(action.slice(1));
      if (!Number.isInteger(page) || page < 0 || page * PAGE_SIZE >= models.length) throw new Error("Invalid model page.");
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Select native model", `Page ${page + 1}/${Math.ceil(models.length / PAGE_SIZE)}`), keyboard(String(data.token), models, page)); return;
    }
    const index = action?.match(/^i(\d+)$/)?.[1];
    const selected = index === undefined ? undefined : models[Number(index)];
    if (!selected || !this.deps.agent.setModel) throw new Error("Model selection expired.");
    if (status.activeTurnId || status.waitingForApproval || status.waitingForUserInput) throw new Error("Wait for the current turn before changing the native model.");
    // The driver revalidates against the native catalog. Never turn this into a prompt.
    await this.deps.agent.setModel(key, selected.id);
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("Native model selected.", selected.displayName ?? selected.model ?? selected.id), { inline_keyboard: [] });
  }
}

function keyboard(token: string, models: AgentModelSummary[], page: number): InlineKeyboardMarkup {
  const rows = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((model, index) => [{
    text: (model.displayName ?? model.model ?? model.id).slice(0, 80), callback_data: `ar:cmd:model:${token}:i${page * PAGE_SIZE + index}`,
  }]);
  if (models.length > PAGE_SIZE) rows.push([
    { text: "Previous", callback_data: `ar:cmd:model:${token}:p${Math.max(0, page - 1)}` },
    { text: "Next", callback_data: `ar:cmd:model:${token}:p${Math.min(Math.ceil(models.length / PAGE_SIZE) - 1, page + 1)}` },
  ]);
  rows.push([{ text: "Cancel", callback_data: `ar:cmd:model:${token}:cancel` }]);
  return { inline_keyboard: rows };
}
