import type { AgentDriver, AgentMcpElicitationRequestEvent } from "../../ports/agent.ts";
import type { EditMessageTextOptions, ImAdapter, InboundMessage, InlineKeyboardMarkup, SendMessageOptions } from "../../ports/im.ts";
import type { ConversationId, MessageId } from "../../domain/ids.ts";
import type { Logger } from "../../domain/logger.ts";
import { parseSessionKey } from "../../domain/session.ts";
import { parseChatScopeKey } from "../../domain/scope.ts";
import type { RelayStore } from "../../storage/store.ts";
import type { PendingPrompt } from "../types.ts";
import { CODEX_PROMPT_TTL_MS } from "../ui/constants.ts";
import { codexRequestKey, shortToken } from "../ui/callback-data.ts";
import { mcpElicitationKeyboard } from "../ui/keyboards.ts";
import { asPromptRecord, isExpired, parsePromptPayload } from "../ui/prompt-state.ts";
import { messageWithTitle } from "../ui/text-parts.ts";
import type { RenderedTelegramText } from "../../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "../controller-types.ts";
import { mcpEnumValues, mcpInputHint, parseMcpFieldValue } from "./mcp-schema.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface McpElicitationDeps {
  store: RelayStore;
  agent: Pick<AgentDriver, "respond">;
  adapter: Pick<ImAdapter, "capabilities">;
  logger: Logger;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  markActiveTask(sessionKey: string, status: "blocked" | "running", turnId?: string): Promise<void>;
}

export class McpElicitationFlow {
  private readonly requests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    scopeKey: string;
    timer: ReturnType<typeof setTimeout>;
    promptMessageId?: MessageId;
  }>();

  constructor(private readonly deps: McpElicitationDeps) {}

  async handle(event: AgentMcpElicitationRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const requestKey = codexRequestKey(event.sessionKey, event.requestId);
    if (this.requests.has(requestKey)) return;
    const timer = setTimeout(() => { void this.timeout(requestKey); }, CODEX_PROMPT_TTL_MS);
    const request: {
      sessionKey: string;
      requestId: string | number;
      scopeKey: string;
      timer: ReturnType<typeof setTimeout>;
      promptMessageId?: MessageId;
    } = { sessionKey: event.sessionKey, requestId: event.requestId, scopeKey: parsed.scopeKey, timer };
    this.requests.set(requestKey, request);
    try {
      if (event.mode === "url") {
        const result = await this.deps.sendRendered(parsed.scopeKey, messageWithTitle(
          `MCP request from ${event.serverName}`,
          `${event.message}\n\n${event.url ?? "URL unavailable"}`,
        ), {
          replyMarkup: mcpElicitationKeyboard(token, [
            { action: "complete", label: "Complete" },
            { action: "decline", label: "Decline" },
            { action: "cancel", label: "Cancel" },
          ]),
          disableWebPagePreview: true,
        });
        if (!result.messageId) throw new Error("IM adapter did not return an MCP elicitation message id.");
        this.deps.store.setPendingPrompt({
          conversationId: parsed.conversationId,
          scopeKey: parsed.scopeKey,
          promptMessageId: result.messageId,
          kind: "codex_mcp_elicitation",
          createdAt: Date.now(),
          sessionKey: event.sessionKey,
          payloadJson: JSON.stringify({ token, requestId: event.requestId, mode: "url", serverName: event.serverName }),
          expiresAt,
        });
        request.promptMessageId = result.messageId;
        return;
      }

      const fields = Object.entries(event.requestedSchema?.properties ?? {}).map(([name, schema]) => ({
        name,
        schema,
        required: event.requestedSchema?.required?.includes(name) ?? false,
      }));
      await this.sendFormStep(parsed.scopeKey, event.sessionKey, {
        token,
        requestId: event.requestId,
        mode: "form",
        serverName: event.serverName,
        message: event.message,
        fields,
        index: 0,
        answers: {},
      }, expiresAt);
    } catch (error) {
      clearTimeout(timer);
      if (this.requests.get(requestKey) === request) this.requests.delete(requestKey);
      throw error;
    }
  }

  async answerCallback(message: CallbackMessage, payload: string): Promise<void> {
    const [, token, action] = payload.split(":");
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const state = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_mcp_elicitation" || !state || state.token !== token || isExpired(pending)) {
      await this.expirePrompt(message, pending, state);
      return;
    }
    if (!pending.sessionKey) throw new Error("MCP elicitation session is missing.");
    if (action === "decline" || action === "cancel" || (state.mode === "url" && action === "complete")) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(action === "complete" ? "MCP action completed." : action === "decline" ? "MCP request declined." : "MCP request cancelled."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.respond(pending.sessionKey, state.requestId as string | number, action === "complete" ? "accept" : action, null);
      return;
    }
    if (action === "submit") {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("MCP form submitted."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.respond(pending.sessionKey, state.requestId as string | number, "accept", asPromptRecord(state.answers) ?? {});
      return;
    }
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const index = typeof state.index === "number" ? state.index : 0;
    const field = asPromptRecord(fields[index]);
    const schema = asPromptRecord(field?.schema);
    if (!field || !schema) throw new Error("MCP form field expired.");
    if (action === "input") {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("Enter MCP field value."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.sendFormStep(message.conversationId, pending.sessionKey, state, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS, true);
      return;
    }
    let value: unknown;
    if (action === "skip" && field.required !== true) value = undefined;
    else if (action === "true" || action === "false") value = action === "true";
    else if (action?.startsWith("v")) value = mcpEnumValues(schema)?.[Number(action.slice(1))];
    else throw new Error("MCP form action is unavailable.");
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(value === undefined ? "MCP field skipped." : "MCP field recorded."), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.advance(message.conversationId, pending, state, typeof field.name === "string" ? field.name : "field", value);
  }

  async answerFreeText(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const state = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_mcp_elicitation" || !state || isExpired(pending) || !pending.sessionKey) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.deps.sendRendered(conversationId, messageWithTitle("MCP form expired."));
      return;
    }
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const index = typeof state.index === "number" ? state.index : 0;
    const field = asPromptRecord(fields[index]);
    const schema = asPromptRecord(field?.schema);
    if (!field || !schema || typeof field.name !== "string") throw new Error("MCP form field expired.");
    const parsed = parseMcpFieldValue(text, schema, field.required === true);
    if (typeof parsed === "string") {
      await this.deps.sendRendered(conversationId, messageWithTitle("Invalid MCP field value.", parsed));
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.sendFormStep(conversationId, pending.sessionKey, state, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS, true);
      return;
    }
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    await this.deps.sendRendered(conversationId, messageWithTitle(parsed.value === undefined ? "MCP field skipped." : "MCP field recorded."));
    await this.advance(conversationId, pending, state, field.name, parsed.value);
  }

  clearForSession(sessionKey: string): void {
    for (const [key, request] of this.requests.entries()) {
      if (request.sessionKey !== sessionKey) continue;
      clearTimeout(request.timer);
      this.requests.delete(key);
    }
  }

  async resolve(sessionKey: string, requestId: string | number): Promise<void> {
    const key = codexRequestKey(sessionKey, requestId);
    const request = this.requests.get(key);
    if (!request) return;
    clearTimeout(request.timer);
    if (request.promptMessageId === undefined) {
      this.requests.delete(key);
      return;
    }
    this.deps.store.deletePendingPrompt(request.scopeKey, request.promptMessageId);
    const finalState = messageWithTitle("Codex request resolved.", "The request was answered from a connected client.");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.deps.editRendered(
          request.scopeKey,
          finalState,
          { messageId: request.promptMessageId, replyMarkup: { inline_keyboard: [] } },
        );
        this.requests.delete(key);
        return;
      } catch (error) {
        lastError = error;
        this.deps.logger.warn("router.mcp_resolved_prompt_edit_failed", {
          session_key: sessionKey,
          request_id: String(requestId),
          attempt,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    const replacement = await this.deps.sendRendered(request.scopeKey, finalState, { replyMarkup: { inline_keyboard: [] } });
    if (replacement.messageId === undefined) throw lastError;
    this.requests.delete(key);
  }

  private async sendFormStep(conversationId: ConversationId, sessionKey: string, state: Record<string, unknown>, expiresAt: number, forceInput = false): Promise<void> {
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const index = typeof state.index === "number" ? state.index : 0;
    const field = asPromptRecord(fields[index]);
    const token = typeof state.token === "string" ? state.token : shortToken();
    if (!field) {
      const answers = asPromptRecord(state.answers) ?? {};
      const result = await this.deps.sendRendered(conversationId, messageWithTitle("Submit MCP form?", Object.keys(answers).length > 0 ? JSON.stringify(answers, null, 2) : "No values were entered."), {
        replyMarkup: mcpElicitationKeyboard(token, [
          { action: "submit", label: "Submit" },
          { action: "decline", label: "Decline" },
          { action: "cancel", label: "Cancel" },
        ]),
      });
      await this.storePrompt(result.messageId, conversationId, sessionKey, state, expiresAt);
      return;
    }
    const schema = asPromptRecord(field.schema);
    const fieldName = typeof field.name === "string" ? field.name : `field-${index + 1}`;
    const required = field.required === true;
    const title = typeof schema?.title === "string" ? schema.title : fieldName;
    const description = [typeof schema?.description === "string" ? schema.description : undefined, required ? "Required." : "Optional.", mcpInputHint(schema)].filter(Boolean).join("\n");
    const enumValues = mcpEnumValues(schema);
    const type = typeof schema?.type === "string" ? schema.type : "string";
    const actions: Array<{ action: string; label: string }> = [];
    if (type === "boolean") actions.push({ action: "true", label: "True" }, { action: "false", label: "False" });
    else if (enumValues && type !== "array") enumValues.forEach((value, valueIndex) => actions.push({ action: `v${valueIndex}`, label: String(value) }));
    else if (!forceInput) actions.push({ action: "input", label: "Enter value" });
    if (!required && !forceInput) actions.push({ action: "skip", label: "Skip" });
    if (!forceInput) actions.push({ action: "cancel", label: "Cancel" });
    const result = await this.deps.sendRendered(conversationId, messageWithTitle(`MCP field ${index + 1}/${fields.length}: ${title}`, description), {
      ...(forceInput
        ? { forceReply: true, forceReplyInstruction: "Reply with the field value.", inputFieldPlaceholder: title }
        : { replyMarkup: mcpElicitationKeyboard(token, actions) }),
      disableWebPagePreview: true,
    });
    await this.storePrompt(result.messageId, conversationId, sessionKey, state, expiresAt);
  }

  private async storePrompt(messageId: MessageId | undefined, conversationId: ConversationId, sessionKey: string, state: Record<string, unknown>, expiresAt: number): Promise<void> {
    if (!messageId) throw new Error("IM adapter did not return an MCP form message id.");
    const scope = parseChatScopeKey(String(conversationId));
    this.deps.store.setPendingPrompt({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      promptMessageId: messageId,
      kind: "codex_mcp_elicitation",
      createdAt: Date.now(),
      sessionKey,
      payloadJson: JSON.stringify(state),
      expiresAt,
    });
    const requestId = state.requestId as string | number | undefined;
    if (requestId !== undefined) {
      const request = this.requests.get(codexRequestKey(sessionKey, requestId));
      if (request) request.promptMessageId = messageId;
    }
  }

  private async advance(conversationId: ConversationId, pending: PendingPrompt, state: Record<string, unknown>, fieldName: string, value: unknown): Promise<void> {
    if (!pending.sessionKey) return;
    const answers = { ...(asPromptRecord(state.answers) ?? {}) };
    if (value !== undefined) answers[fieldName] = value;
    const next = { ...state, answers, index: (typeof state.index === "number" ? state.index : 0) + 1 };
    await this.sendFormStep(conversationId, pending.sessionKey, next, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS);
  }

  private async respond(sessionKey: string, requestId: string | number, action: string, content: unknown): Promise<void> {
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer MCP elicitations.");
    const key = codexRequestKey(sessionKey, requestId);
    const request = this.requests.get(key);
    if (request) clearTimeout(request.timer);
    await this.deps.agent.respond(sessionKey, requestId, { action, content, _meta: null });
    this.requests.delete(key);
    await this.deps.markActiveTask(sessionKey, "running");
  }

  private async timeout(key: string): Promise<void> {
    const request = this.requests.get(key);
    if (!request) return;
    this.requests.delete(key);
    if (request.promptMessageId !== undefined) this.deps.store.deletePendingPrompt(request.scopeKey, request.promptMessageId);
    await this.deps.agent.respond?.(request.sessionKey, request.requestId, { action: "cancel", content: null, _meta: null }).catch(() => undefined);
    await this.deps.markActiveTask(request.sessionKey, "running");
  }

  private async expirePrompt(message: CallbackMessage, pending: PendingPrompt | undefined, state: Record<string, unknown> | undefined): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    if (pending?.sessionKey && state?.requestId !== undefined) await this.respond(pending.sessionKey, state.requestId as string | number, "cancel", null);
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("MCP request expired."), { inline_keyboard: [] });
  }
}
