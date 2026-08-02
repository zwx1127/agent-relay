import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentDriver,
  AgentMcpElicitationRequestEvent,
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
} from "../ports/agent.ts";
import type { ImAdapter, InboundMessage, InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { RelayStore } from "../storage/store.ts";
import { CODEX_PROMPT_TTL_MS } from "./ui/constants.ts";
import { codexRequestKey, shortToken } from "./ui/callback-data.ts";
import { approvalKeyboard, codexQuestionConfirmKeyboard, codexQuestionKeyboard, mcpElicitationKeyboard } from "./ui/keyboards.ts";
import { approvalChoices, approvalResponse, asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import {
  answeredMessage,
  formatApprovalDecisionMessage,
  formatApprovalMessage,
  formatCodexAnswerNotePrompt,
  formatCodexQuestion,
  formatCodexSelectedAnswer,
  formatCodexSelectedAnswerSummary,
} from "./ui/messages.ts";
import { messageWithTitle } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { RenderCallbackPageResult } from "./controller-types.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

interface PendingPrompt {
  conversationId: ConversationId;
  scopeKey?: string;
  promptMessageId: MessageId;
  kind: "workspace_name" | "codex_user_input" | "codex_approval" | "codex_mcp_elicitation" | "relay_command" | "media_action";
  createdAt: number;
  sessionKey?: string;
  payloadJson?: string;
  expiresAt?: number;
}

export interface CodexPromptFlowDeps {
  store: RelayStore;
  agent: Pick<AgentDriver, "respond">;
  adapter: Pick<ImAdapter, "capabilities">;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  renderStrictCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<RenderCallbackPageResult>;
  markActiveTask(sessionKey: string, status: "blocked" | "running", turnId?: string): Promise<void>;
}

export class CodexPromptFlow {
  private readonly codexRequests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    questions: AgentUserInputQuestion[];
    answers: Record<string, { answers: string[] }>;
  }>();
  private readonly mcpRequests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    scopeKey: string;
    timer: ReturnType<typeof setTimeout>;
    promptMessageId?: MessageId;
  }>();

  constructor(private readonly deps: CodexPromptFlowDeps) {}

  async handleUserInputRequest(event: AgentUserInputRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const key = codexRequestKey(event.sessionKey, event.requestId);
    this.codexRequests.set(key, { sessionKey: event.sessionKey, requestId: event.requestId, questions: event.questions, answers: {} });

    const first = event.questions[0];
    if (!first) throw new Error("Codex requested user input without questions.");
    await this.sendCodexQuestion(parsed.scopeKey, event.sessionKey, event.requestId, first, 0, token, expiresAt);
  }

  async handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const result = await this.deps.sendRendered(parsed.scopeKey, formatApprovalMessage(event.title, event.body), {
      replyMarkup: approvalKeyboard(token, approvalChoices(event.approvalKind, event.params)),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return an approval prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
      scopeKey: parsed.scopeKey,
      promptMessageId: result.messageId,
      kind: "codex_approval",
      createdAt: Date.now(),
      sessionKey: event.sessionKey,
      payloadJson: JSON.stringify({
        token,
        requestId: event.requestId,
        method: event.method,
        approvalKind: event.approvalKind,
        title: event.title,
        body: event.body,
        params: event.params,
      }),
      expiresAt,
    });
  }

  private async sendCodexQuestion(
    conversationId: ConversationId,
    sessionKeyValue: string,
    requestId: string | number,
    question: AgentUserInputQuestion,
    questionIndex: number,
    token: string,
    expiresAt: number,
  ): Promise<void> {
    const scope = parseChatScopeKey(String(conversationId));
    const options = question.options ?? [];
    const request = this.codexRequests.get(codexRequestKey(sessionKeyValue, requestId));
    const totalQuestions = request?.questions.length ?? 1;
    const payload = JSON.stringify({
      token,
      requestId,
      questionIndex,
      questionId: question.id,
      header: question.header,
      question: question.question,
      isSecret: Boolean(question.isSecret),
      isOther: Boolean(question.isOther),
      options,
      totalQuestions,
    });
    const useInlineOptions = !question.isSecret && options.length > 0 && this.deps.adapter.capabilities.inlineActions;
    const result = await this.deps.sendRendered(scope.scopeKey, formatCodexQuestion(question, questionIndex, totalQuestions), {
      ...(useInlineOptions ? { replyMarkup: codexQuestionKeyboard(token, options, Boolean(question.isOther)) } : { forceReply: true }),
      ...(!useInlineOptions ? { forceReplyInstruction: "Reply to this prompt with your answer.", inputFieldPlaceholder: "Answer" } : {}),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: payload,
      expiresAt,
    });
  }

  async answerOptionCallback(message: CallbackMessage, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, rawAction] = parts;
    if (!token) throw new Error("Question selection is missing.");
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || data.token !== token || isExpired(pending)) {
      await this.expireQuestionPrompt(message);
      return;
    }

    if (rawAction === "submit") {
      const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
      if (!selectedAnswer) throw new Error("Question selection expired.");
      await this.deps.renderStrictCallbackPage(message, answeredMessage(selectedAnswer), { inline_keyboard: [] });
      const response = await this.recordCodexAnswer(pending, data, [selectedAnswer]);
      if (response === "expired") return;
      if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
      if (response) await this.respondToCodexPrompt(response);
      return;
    }

    if (rawAction === "note") {
      const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
      if (!selectedAnswer) throw new Error("Question selection expired.");
      await this.promptForCodexAnswerNote(message, pending, data, selectedAnswer);
      return;
    }

    if (rawAction === "change") {
      const options = Array.isArray(data.options)
        ? data.options.map((option) => {
          const record = asPromptRecord(option);
          return record && typeof record.label === "string"
            ? { label: record.label, description: typeof record.description === "string" ? record.description : "" }
            : undefined;
        }).filter(Boolean) as AgentUserInputOption[]
        : [];
      const question = {
        id: typeof data.questionId === "string" ? data.questionId : "question",
        header: typeof data.header === "string" ? data.header : "Question",
        question: typeof data.question === "string" ? data.question : "Pick one.",
        isOther: Boolean(data.isOther),
        options,
      };
      const questionIndex = typeof data.questionIndex === "number" ? data.questionIndex : 0;
      const totalQuestions = typeof data.totalQuestions === "number" ? data.totalQuestions : 1;
      await this.deps.renderStrictCallbackPage(message, formatCodexQuestion(question, questionIndex, totalQuestions), codexQuestionKeyboard(token, options, Boolean(data.isOther)));
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: undefined, answerMode: undefined }),
      });
      return;
    }

    if (rawAction === "other") {
      await this.promptForCodexOtherAnswer(message, pending, data);
      return;
    }

    const optionIndex = Number(rawAction);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) throw new Error("Question selection is missing.");
    const option = Array.isArray(data.options) ? asPromptRecord(data.options[optionIndex]) : undefined;
    const answer = typeof option?.label === "string" ? option.label : undefined;
    if (!answer) throw new Error("Question selection expired.");

    if (this.deps.store.getCollaborationMode(pending.sessionKey ?? "") === "plan") {
      await this.deps.renderStrictCallbackPage(message, formatCodexSelectedAnswer(answer), codexQuestionConfirmKeyboard(token));
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: answer }),
      });
      return;
    }

    await this.deps.renderStrictCallbackPage(message, answeredMessage(answer), { inline_keyboard: [] });
    const response = await this.recordCodexAnswer(pending, data, [answer]);
    if (response === "expired") return;
    if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
    if (response) await this.respondToCodexPrompt(response);
  }

  private async promptForCodexAnswerNote(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    selectedAnswer: string,
  ): Promise<void> {
    await this.deps.renderStrictCallbackPage(message, formatCodexSelectedAnswerSummary(selectedAnswer), { inline_keyboard: [] });
    const result = await this.deps.sendRendered(message.conversationId, formatCodexAnswerNotePrompt(), {
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt with any note to include.",
      disableWebPagePreview: true,
      inputFieldPlaceholder: "Note to include",
    });
    if (!result.messageId) throw new Error("IM adapter did not return a note prompt message id.");
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    this.deps.store.setPendingPrompt({
      conversationId: parseChatScopeKey(String(message.conversationId)).conversationId,
      scopeKey: String(message.conversationId),
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: pending.sessionKey,
      payloadJson: JSON.stringify({ ...data, selectedAnswer, answerMode: "note" }),
      expiresAt: pending.expiresAt,
    });
  }

  private async promptForCodexOtherAnswer(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.renderStrictCallbackPage(message, formatCodexSelectedAnswerSummary("Other"), { inline_keyboard: [] });
    const result = await this.deps.sendRendered(message.conversationId, messageWithTitle("Other answer"), {
      forceReply: true,
      forceReplyInstruction: "Reply to this prompt with the answer to use.",
      disableWebPagePreview: true,
      inputFieldPlaceholder: "Answer to use",
    });
    if (!result.messageId) throw new Error("IM adapter did not return an other-answer prompt message id.");
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    this.deps.store.setPendingPrompt({
      conversationId: parseChatScopeKey(String(message.conversationId)).conversationId,
      scopeKey: String(message.conversationId),
      promptMessageId: result.messageId,
      kind: "codex_user_input",
      createdAt: Date.now(),
      sessionKey: pending.sessionKey,
      payloadJson: JSON.stringify({ ...data, answerMode: "other" }),
      expiresAt: pending.expiresAt,
    });
  }

  private async sendNextCodexQuestion(
    conversationId: ConversationId,
    pending: PendingPrompt,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    if (!pending.sessionKey) return false;
    const requestId = data.requestId as string | number | undefined;
    if (requestId === undefined) return false;
    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) return false;
    const currentIndex = typeof data.questionIndex === "number" ? data.questionIndex : -1;
    const nextIndex = request.questions.findIndex((question, index) => index > currentIndex && !request.answers[question.id]);
    const next = nextIndex >= 0 ? request.questions[nextIndex] : undefined;
    if (!next) return false;
    const token = typeof data.token === "string" ? data.token : shortToken();
    await this.sendCodexQuestion(conversationId, pending.sessionKey, requestId, next, nextIndex, token, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS);
    return true;
  }

  async answerFreeText(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    const pending = this.deps.store.getPendingPrompt(conversationId, promptMessageId);
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_user_input" || !data || isExpired(pending)) {
      this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
      await this.deps.sendRendered(conversationId, expiredQuestionMessage());
      return;
    }
    const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
    const answerMode = typeof data.answerMode === "string" ? data.answerMode : undefined;
    const answers = answerMode === "note" && selectedAnswer ? [selectedAnswer, text] : [text];
    const response = await this.recordCodexAnswer(pending, data, answers);
    if (response === "expired") return;
    const hasNext = !response && await this.sendNextCodexQuestion(conversationId, pending, data);
    if (!hasNext) await this.deps.sendRendered(conversationId, data.isSecret ? messageWithTitle("Answered.") : answeredMessage(answers.join("\n")));
    if (response) await this.respondToCodexPrompt(response);
  }

  async handleMcpElicitationRequest(event: AgentMcpElicitationRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const requestKey = codexRequestKey(event.sessionKey, event.requestId);
    const timer = setTimeout(() => { void this.timeoutMcpRequest(requestKey); }, CODEX_PROMPT_TTL_MS);
    this.mcpRequests.set(requestKey, { sessionKey: event.sessionKey, requestId: event.requestId, scopeKey: parsed.scopeKey, timer });
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
      const request = this.mcpRequests.get(requestKey);
      if (request) request.promptMessageId = result.messageId;
      return;
    }

    const fields = Object.entries(event.requestedSchema?.properties ?? {}).map(([name, schema]) => ({
      name,
      schema,
      required: event.requestedSchema?.required?.includes(name) ?? false,
    }));
    const state = { token, requestId: event.requestId, mode: "form", serverName: event.serverName, message: event.message, fields, index: 0, answers: {} };
    await this.sendMcpFormStep(parsed.scopeKey, event.sessionKey, state, expiresAt);
  }

  private async sendMcpFormStep(
    conversationId: ConversationId,
    sessionKeyValue: string,
    state: Record<string, unknown>,
    expiresAt: number,
    forceInput = false,
  ): Promise<void> {
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const index = typeof state.index === "number" ? state.index : 0;
    const field = asPromptRecord(fields[index]);
    const token = typeof state.token === "string" ? state.token : shortToken();
    if (!field) {
      const answers = asPromptRecord(state.answers) ?? {};
      const result = await this.deps.sendRendered(conversationId, messageWithTitle(
        "Submit MCP form?",
        Object.keys(answers).length > 0 ? JSON.stringify(answers, null, 2) : "No values were entered.",
      ), {
        replyMarkup: mcpElicitationKeyboard(token, [
          { action: "submit", label: "Submit" },
          { action: "decline", label: "Decline" },
          { action: "cancel", label: "Cancel" },
        ]),
      });
      await this.storeMcpPrompt(result.messageId, conversationId, sessionKeyValue, state, expiresAt);
      return;
    }
    const schema = asPromptRecord(field.schema);
    const fieldName = typeof field.name === "string" ? field.name : `field-${index + 1}`;
    const required = field.required === true;
    const title = typeof schema?.title === "string" ? schema.title : fieldName;
    const description = [
      typeof schema?.description === "string" ? schema.description : undefined,
      required ? "Required." : "Optional.",
      mcpInputHint(schema),
    ].filter(Boolean).join("\n");
    const enumValues = mcpEnumValues(schema);
    const type = typeof schema?.type === "string" ? schema.type : "string";
    const actions: Array<{ action: string; label: string }> = [];
    if (type === "boolean") {
      actions.push({ action: "true", label: "True" }, { action: "false", label: "False" });
    } else if (enumValues && type !== "array") {
      enumValues.forEach((value, valueIndex) => actions.push({ action: `v${valueIndex}`, label: String(value) }));
    } else if (!forceInput) {
      actions.push({ action: "input", label: "Enter value" });
    }
    if (!required && !forceInput) actions.push({ action: "skip", label: "Skip" });
    if (!forceInput) actions.push({ action: "cancel", label: "Cancel" });
    const useForceReply = forceInput;
    const result = await this.deps.sendRendered(conversationId, messageWithTitle(
      `MCP field ${index + 1}/${fields.length}: ${title}`,
      description,
    ), {
      ...(useForceReply
        ? { forceReply: true, forceReplyInstruction: "Reply with the field value.", inputFieldPlaceholder: title }
        : { replyMarkup: mcpElicitationKeyboard(token, actions) }),
      disableWebPagePreview: true,
    });
    await this.storeMcpPrompt(result.messageId, conversationId, sessionKeyValue, state, expiresAt);
  }

  private async storeMcpPrompt(
    messageId: MessageId | undefined,
    conversationId: ConversationId,
    sessionKeyValue: string,
    state: Record<string, unknown>,
    expiresAt: number,
  ): Promise<void> {
    if (!messageId) throw new Error("IM adapter did not return an MCP form message id.");
    const scope = parseChatScopeKey(String(conversationId));
    this.deps.store.setPendingPrompt({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      promptMessageId: messageId,
      kind: "codex_mcp_elicitation",
      createdAt: Date.now(),
      sessionKey: sessionKeyValue,
      payloadJson: JSON.stringify(state),
      expiresAt,
    });
    const requestId = state.requestId as string | number | undefined;
    if (requestId !== undefined) {
      const request = this.mcpRequests.get(codexRequestKey(sessionKeyValue, requestId));
      if (request) request.promptMessageId = messageId;
    }
  }

  async answerMcpCallback(message: CallbackMessage, payload: string): Promise<void> {
    const [, token, action] = payload.split(":");
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const state = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_mcp_elicitation" || !state || state.token !== token || isExpired(pending)) {
      await this.expireMcpPrompt(message, pending, state);
      return;
    }
    if (!pending.sessionKey) throw new Error("MCP elicitation session is missing.");
    if (action === "decline" || action === "cancel" || (state.mode === "url" && action === "complete")) {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle(action === "complete" ? "MCP action completed." : action === "decline" ? "MCP request declined." : "MCP request cancelled."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.respondMcp(pending.sessionKey, state.requestId as string | number, action === "complete" ? "accept" : action, null);
      return;
    }
    if (action === "submit") {
      await this.deps.renderStrictCallbackPage(message, messageWithTitle("MCP form submitted."), { inline_keyboard: [] });
      this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
      await this.respondMcp(pending.sessionKey, state.requestId as string | number, "accept", asPromptRecord(state.answers) ?? {});
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
      await this.sendMcpFormStep(message.conversationId, pending.sessionKey, state, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS, true);
      return;
    }
    let value: unknown;
    if (action === "skip" && field.required !== true) value = undefined;
    else if (action === "true" || action === "false") value = action === "true";
    else if (action?.startsWith("v")) value = mcpEnumValues(schema)?.[Number(action.slice(1))];
    else throw new Error("MCP form action is unavailable.");
    await this.deps.renderStrictCallbackPage(message, messageWithTitle(value === undefined ? "MCP field skipped." : "MCP field recorded."), { inline_keyboard: [] });
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.advanceMcpForm(message.conversationId, pending, state, typeof field.name === "string" ? field.name : "field", value);
  }

  async answerMcpFreeText(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
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
      await this.sendMcpFormStep(conversationId, pending.sessionKey, state, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS, true);
      return;
    }
    this.deps.store.deletePendingPrompt(conversationId, promptMessageId);
    await this.deps.sendRendered(conversationId, messageWithTitle(parsed.value === undefined ? "MCP field skipped." : "MCP field recorded."));
    await this.advanceMcpForm(conversationId, pending, state, field.name, parsed.value);
  }

  private async advanceMcpForm(
    conversationId: ConversationId,
    pending: PendingPrompt,
    state: Record<string, unknown>,
    fieldName: string,
    value: unknown,
  ): Promise<void> {
    if (!pending.sessionKey) return;
    const answers = { ...(asPromptRecord(state.answers) ?? {}) };
    if (value !== undefined) answers[fieldName] = value;
    const next = { ...state, answers, index: (typeof state.index === "number" ? state.index : 0) + 1 };
    await this.sendMcpFormStep(conversationId, pending.sessionKey, next, pending.expiresAt ?? Date.now() + CODEX_PROMPT_TTL_MS);
  }

  private async respondMcp(sessionKeyValue: string, requestId: string | number, action: string, content: unknown): Promise<void> {
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer MCP elicitations.");
    const key = codexRequestKey(sessionKeyValue, requestId);
    const request = this.mcpRequests.get(key);
    if (request) clearTimeout(request.timer);
    this.mcpRequests.delete(key);
    await this.deps.agent.respond(sessionKeyValue, requestId, { action, content, _meta: null });
    await this.deps.markActiveTask(sessionKeyValue, "running");
  }

  private async timeoutMcpRequest(key: string): Promise<void> {
    const request = this.mcpRequests.get(key);
    if (!request) return;
    this.mcpRequests.delete(key);
    if (request.promptMessageId !== undefined) this.deps.store.deletePendingPrompt(request.scopeKey, request.promptMessageId);
    await this.deps.agent.respond?.(request.sessionKey, request.requestId, { action: "cancel", content: null, _meta: null }).catch(() => undefined);
    await this.deps.markActiveTask(request.sessionKey, "running");
  }

  private async expireMcpPrompt(message: CallbackMessage, pending: PendingPrompt | undefined, state: Record<string, unknown> | undefined): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    if (pending?.sessionKey && state?.requestId !== undefined) {
      await this.respondMcp(pending.sessionKey, state.requestId as string | number, "cancel", null);
    }
    await this.deps.renderStrictCallbackPage(message, messageWithTitle("MCP request expired."), { inline_keyboard: [] });
  }

  private async recordCodexAnswer(
    pending: PendingPrompt,
    data: Record<string, unknown>,
    answers: string[],
  ): Promise<{ sessionKey: string; requestId: string | number; result: unknown } | "expired" | undefined> {
    if (!pending.sessionKey) throw new Error("Question session is missing.");
    const requestId = data.requestId as string | number | undefined;
    const questionId = typeof data.questionId === "string" ? data.questionId : undefined;
    if (requestId === undefined || !questionId) throw new Error("Question payload is invalid.");

    const request = this.codexRequests.get(codexRequestKey(pending.sessionKey, requestId));
    if (!request) {
      const scopeKey = pending.scopeKey ?? pending.conversationId;
      this.deps.store.deletePendingPrompt(scopeKey, pending.promptMessageId);
      await this.deps.sendRendered(scopeKey, expiredQuestionMessage());
      return "expired";
    }

    request.answers[questionId] = { answers };
    this.deps.store.deletePendingPrompt(pending.scopeKey ?? pending.conversationId, pending.promptMessageId);
    if (Object.keys(request.answers).length !== request.questions.length) return undefined;
    this.codexRequests.delete(codexRequestKey(pending.sessionKey, requestId));
    return { sessionKey: pending.sessionKey, requestId, result: { answers: request.answers } };
  }

  private async respondToCodexPrompt(response: { sessionKey: string; requestId: string | number; result: unknown }): Promise<void> {
    if (!this.deps.agent.respond) throw new Error("Agent driver cannot answer Codex prompts.");
    await this.deps.agent.respond(response.sessionKey, response.requestId, response.result);
    await this.deps.markActiveTask(response.sessionKey, "running");
  }

  async answerApproval(message: CallbackMessage, payload: string): Promise<void> {
    const parts = payload.split(":");
    const [, token, decision] = parts;
    const pending = message.messageId ? this.deps.store.getPendingPrompt(message.conversationId, message.messageId) : undefined;
    const data = parsePromptPayload(pending?.payloadJson);
    if (!pending || pending.kind !== "codex_approval" || !data || data.token !== token || isExpired(pending)) {
      await this.expireApprovalPrompt(message, pending, data);
      return;
    }
    if (!pending.sessionKey || !this.deps.agent.respond) throw new Error("Approval session is missing.");
    const approved = decision === "once" || decision === "session" || decision === "turn" || decision === "exec" || Boolean(decision?.startsWith("net"));
    await this.deps.renderStrictCallbackPage(
      message,
      formatApprovalDecisionMessage(
        approved ? "Approved." : decision === "cancel" ? "Cancelled." : "Denied.",
        typeof data.title === "string" ? data.title : "Approval request",
        typeof data.body === "string" ? data.body : "",
      ),
      { inline_keyboard: [] },
    );
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, decision ?? "decline", data.params));
    await this.deps.markActiveTask(pending.sessionKey, "running");
  }

  private async expireQuestionPrompt(message: CallbackMessage): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    await this.deps.renderStrictCallbackPage(message, expiredQuestionMessage(), { inline_keyboard: [] });
  }

  private async expireApprovalPrompt(
    message: CallbackMessage,
    pending: PendingPrompt | undefined,
    data: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    const agent = this.deps.agent;
    const sessionKeyValue = pending?.sessionKey;
    if (sessionKeyValue && data && data.requestId !== undefined && typeof data.approvalKind === "string" && agent.respond) {
      await this.deps.renderStrictCallbackPage(
        message,
        messageWithTitle(
          "Approval expired.",
          "The blocked action was denied. Resend the instruction if you still want Codex to continue.",
        ),
        { inline_keyboard: [] },
      );
      await agent.respond(
        sessionKeyValue,
        data.requestId as string | number,
        approvalResponse(data.approvalKind as AgentApprovalKind, false, data.params),
      );
      await this.deps.markActiveTask(sessionKeyValue, "running");
      return;
    }
    await this.deps.renderStrictCallbackPage(
      message,
      messageWithTitle("Approval expired.", "Send /interrupt to stop the blocked turn, then resend your instruction."),
      { inline_keyboard: [] },
    );
  }

  clearForSession(sessionKeyValue: string): void {
    this.deps.store.deletePendingPromptsForSession(sessionKeyValue, ["codex_user_input", "codex_approval", "codex_mcp_elicitation"]);
    for (const key of this.codexRequests.keys()) {
      if (key.startsWith(`${sessionKeyValue}:`)) this.codexRequests.delete(key);
    }
    for (const [key, request] of this.mcpRequests.entries()) {
      if (request.sessionKey !== sessionKeyValue) continue;
      clearTimeout(request.timer);
      this.mcpRequests.delete(key);
      void this.deps.agent.respond?.(request.sessionKey, request.requestId, { action: "cancel", content: null, _meta: null }).catch(() => undefined);
    }
  }
}

function mcpEnumValues(schema: Record<string, unknown> | undefined): unknown[] | undefined {
  if (Array.isArray(schema?.enum)) return schema.enum;
  const items = asPromptRecord(schema?.items);
  return Array.isArray(items?.enum) ? items.enum : undefined;
}

function mcpInputHint(schema: Record<string, unknown> | undefined): string | undefined {
  const type = typeof schema?.type === "string" ? schema.type : undefined;
  const values = mcpEnumValues(schema);
  if (type === "array" && values) return `Enter comma-separated values: ${values.join(", ")}`;
  if (values) return `Choose one of: ${values.join(", ")}`;
  if (type === "boolean") return "Choose true or false.";
  if (type === "integer") return "Enter a whole number.";
  if (type === "number") return "Enter a number.";
  if (typeof schema?.format === "string") return `Format: ${schema.format}.`;
  return undefined;
}

function parseMcpFieldValue(text: string, schema: Record<string, unknown>, required: boolean): { value: unknown } | string {
  const trimmed = text.trim();
  if (!trimmed || (!required && trimmed.toLowerCase() === "skip")) {
    if (schema.default !== undefined) return { value: schema.default };
    return required ? "A value is required." : { value: undefined };
  }
  const type = typeof schema.type === "string" ? schema.type : "string";
  if (type === "number" || type === "integer") {
    const value = Number(trimmed);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return type === "integer" ? "Enter a whole number." : "Enter a valid number.";
    if (typeof schema.minimum === "number" && value < schema.minimum) return `Value must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `Value must be at most ${schema.maximum}.`;
    return { value };
  }
  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(trimmed)) return { value: true };
    if (/^(false|no|0)$/i.test(trimmed)) return { value: false };
    return "Enter true or false.";
  }
  if (type === "array") {
    const values = trimmed.split(",").map((value) => value.trim()).filter(Boolean);
    const allowed = mcpEnumValues(schema);
    if (allowed && values.some((value) => !allowed.includes(value))) return `Allowed values: ${allowed.join(", ")}.`;
    if (typeof schema.minItems === "number" && values.length < schema.minItems) return `Select at least ${schema.minItems} values.`;
    if (typeof schema.maxItems === "number" && values.length > schema.maxItems) return `Select at most ${schema.maxItems} values.`;
    return { value: values };
  }
  if (typeof schema.minLength === "number" && trimmed.length < schema.minLength) return `Value must contain at least ${schema.minLength} characters.`;
  if (typeof schema.maxLength === "number" && trimmed.length > schema.maxLength) return `Value must contain at most ${schema.maxLength} characters.`;
  const allowed = mcpEnumValues(schema);
  if (allowed && !allowed.includes(trimmed)) return `Allowed values: ${allowed.join(", ")}.`;
  if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address.";
  if (schema.format === "uri") {
    try { new URL(trimmed); } catch { return "Enter a valid URI."; }
  }
  if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "Enter a date in YYYY-MM-DD format.";
  if (schema.format === "date-time" && Number.isNaN(Date.parse(trimmed))) return "Enter a valid date-time.";
  return { value: trimmed };
}

function expiredQuestionMessage(): RenderedTelegramText {
  return messageWithTitle("Question expired.", "Send /interrupt to stop the blocked turn, then resend your instruction.");
}
