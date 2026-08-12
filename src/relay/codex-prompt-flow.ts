import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentDriver,
  AgentMcpElicitationRequestEvent,
  AgentServerRequestResolvedEvent,
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
} from "../ports/agent.ts";
import type { EditMessageTextOptions, ImAdapter, InboundMessage, InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { parseSessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { RelayStore } from "../storage/store.ts";
import { CODEX_PROMPT_TTL_MS } from "./ui/constants.ts";
import { codexRequestKey, shortToken } from "./ui/callback-data.ts";
import { approvalKeyboard, codexQuestionConfirmKeyboard, codexQuestionKeyboard } from "./ui/keyboards.ts";
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
import { McpElicitationFlow } from "./prompt-flows/mcp-elicitation.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

interface PendingPrompt {
  conversationId: ConversationId;
  scopeKey?: string;
  promptMessageId: MessageId;
  kind: "workspace_name" | "codex_user_input" | "codex_approval" | "codex_mcp_elicitation" | "relay_command" | "side_conversation" | "media_action";
  createdAt: number;
  sessionKey?: string;
  payloadJson?: string;
  expiresAt?: number;
}

type InteractiveRequestEvent = AgentUserInputRequestEvent | AgentApprovalRequestEvent | AgentMcpElicitationRequestEvent;
type InteractiveRequestKind = InteractiveRequestEvent["type"];

interface InteractiveRequestClaim {
  sessionKey: string;
  logicalKey: string;
  kind: InteractiveRequestKind;
  signature: string;
  request: InteractiveRequestEvent;
  state: "rendering" | "active" | "resolved";
  expiresAt: number;
  requestIds: Map<string, string | number>;
}

const RESOLVED_REQUEST_TOMBSTONE_MS = 5 * 60_000;
const MAX_INTERACTIVE_REQUEST_CLAIMS = 2_000;

export interface CodexPromptFlowDeps {
  store: RelayStore;
  agent: Pick<AgentDriver, "respond">;
  adapter: Pick<ImAdapter, "capabilities">;
  logger: Logger;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options?: Omit<SendMessageOptions, "entities" | "parseMode">): Promise<{ messageId?: MessageId }>;
  editRendered(conversationId: ConversationId, rendered: RenderedTelegramText, options: Omit<EditMessageTextOptions, "entities" | "parseMode">): Promise<void>;
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
  private readonly renderedRequests = new Map<string, { scopeKey: string; promptMessageId: MessageId }>();
  private readonly requestClaims = new Map<string, InteractiveRequestClaim>();
  private readonly requestAliases = new Map<string, string>();
  private readonly mcp: McpElicitationFlow;

  constructor(private readonly deps: CodexPromptFlowDeps) {
    this.mcp = new McpElicitationFlow(deps);
  }

  async handleUserInputRequest(event: AgentUserInputRequestEvent): Promise<boolean> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return false;
    const claim = this.beginRequest(event);
    if (!claim) return false;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const key = codexRequestKey(event.sessionKey, event.requestId);
    this.codexRequests.set(key, { sessionKey: event.sessionKey, requestId: event.requestId, questions: event.questions, answers: {} });

    try {
      const first = event.questions[0];
      if (!first) throw new Error("Codex requested user input without questions.");
      await this.sendCodexQuestion(parsed.scopeKey, event.sessionKey, event.requestId, first, 0, token, expiresAt);
      claim.state = "active";
      return true;
    } catch (error) {
      this.codexRequests.delete(key);
      this.releaseRequestClaim(claim);
      throw error;
    }
  }

  async handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<boolean> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return false;
    const claim = this.beginRequest(event);
    if (!claim) return false;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    try {
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
      this.rememberRenderedRequest(event.sessionKey, event.requestId, parsed.scopeKey, result.messageId);
      claim.state = "active";
      return true;
    } catch (error) {
      this.releaseRequestClaim(claim);
      throw error;
    }
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
    this.rememberRenderedRequest(sessionKeyValue, requestId, scope.scopeKey, result.messageId);
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
    if (pending.sessionKey && data.requestId !== undefined) {
      this.rememberRenderedRequest(pending.sessionKey, data.requestId as string | number, String(message.conversationId), result.messageId);
    }
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
    if (pending.sessionKey && data.requestId !== undefined) {
      this.rememberRenderedRequest(pending.sessionKey, data.requestId as string | number, String(message.conversationId), result.messageId);
    }
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

  async handleMcpElicitationRequest(event: AgentMcpElicitationRequestEvent): Promise<boolean> {
    if (!parseSessionKey(event.sessionKey)) return false;
    const claim = this.beginRequest(event);
    if (!claim) return false;
    try {
      await this.mcp.handle(event);
      claim.state = "active";
      return true;
    } catch (error) {
      this.releaseRequestClaim(claim);
      throw error;
    }
  }

  async answerMcpCallback(message: CallbackMessage, payload: string): Promise<void> {
    await this.mcp.answerCallback(message, payload);
  }

  async answerMcpFreeText(conversationId: ConversationId, promptMessageId: MessageId, text: string): Promise<void> {
    await this.mcp.answerFreeText(conversationId, promptMessageId, text);
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
      this.renderedRequests.delete(codexRequestKey(sessionKeyValue, data.requestId as string | number));
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
      messageWithTitle("Approval expired.", "Use Interrupt on the latest activity card, then resend your instruction."),
      { inline_keyboard: [] },
    );
  }

  clearForSession(sessionKeyValue: string): void {
    this.deps.store.deletePendingPromptsForSession(sessionKeyValue, ["codex_user_input", "codex_approval", "codex_mcp_elicitation"]);
    for (const key of this.codexRequests.keys()) {
      if (key.startsWith(`${sessionKeyValue}:`)) this.codexRequests.delete(key);
    }
    for (const key of this.renderedRequests.keys()) {
      if (key.startsWith(`${sessionKeyValue}:`)) this.renderedRequests.delete(key);
    }
    for (const claim of [...this.requestClaims.values()]) {
      if (claim.sessionKey === sessionKeyValue) this.releaseRequestClaim(claim);
    }
    this.mcp.clearForSession(sessionKeyValue);
  }

  async handleRequestResolved(event: AgentServerRequestResolvedEvent): Promise<void> {
    const claim = this.resolveRequestClaim(event);
    const requestIds = claim ? [...claim.requestIds.values()] : [event.requestId];
    let rendered: { scopeKey: string; promptMessageId: MessageId } | undefined;
    for (const requestId of requestIds) {
      const key = codexRequestKey(event.sessionKey, requestId);
      this.codexRequests.delete(key);
      rendered ??= this.renderedRequests.get(key);
      this.renderedRequests.delete(key);
    }
    if (rendered) {
      this.deps.store.deletePendingPrompt(rendered.scopeKey, rendered.promptMessageId);
      await this.retireResolvedPrompt(rendered.scopeKey, rendered.promptMessageId, event, claim?.request);
    }
    for (const requestId of requestIds) await this.mcp.resolve(event.sessionKey, requestId, event.result);
  }

  private async retireResolvedPrompt(
    scopeKey: ConversationId,
    promptMessageId: MessageId,
    event: AgentServerRequestResolvedEvent,
    request: InteractiveRequestEvent | undefined,
  ): Promise<void> {
    const finalState = resolvedPromptMessage(request, event.result)
      ?? messageWithTitle("Codex request resolved.", "The request was answered from a connected client.");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.deps.editRendered(scopeKey, finalState, { messageId: promptMessageId, replyMarkup: { inline_keyboard: [] } });
        return;
      } catch (error) {
        lastError = error;
        this.deps.logger.warn("router.codex_resolved_prompt_edit_failed", {
          session_key: event.sessionKey,
          request_id: String(event.requestId),
          attempt,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    const replacement = await this.deps.sendRendered(scopeKey, finalState, { replyMarkup: { inline_keyboard: [] } });
    if (replacement.messageId === undefined) throw lastError;
  }

  private rememberRenderedRequest(sessionKeyValue: string, requestId: string | number, scopeKey: string, promptMessageId: MessageId): void {
    this.renderedRequests.set(codexRequestKey(sessionKeyValue, requestId), { scopeKey, promptMessageId });
  }

  private beginRequest(event: InteractiveRequestEvent): InteractiveRequestClaim | undefined {
    const now = Date.now();
    this.pruneRequestClaims(now);
    const alias = codexRequestKey(event.sessionKey, event.requestId);
    const signature = interactiveRequestSignature(event);
    const computedLogicalKey = interactiveRequestLogicalKey(event, signature);
    const aliasedLogicalKey = this.requestAliases.get(alias);
    const aliasedClaim = aliasedLogicalKey ? this.requestClaims.get(aliasedLogicalKey) : undefined;
    if (aliasedClaim?.state === "resolved" && aliasedClaim.logicalKey !== computedLogicalKey) this.releaseRequestClaim(aliasedClaim);
    const currentAliasedLogicalKey = this.requestAliases.get(alias);
    const logicalKey = currentAliasedLogicalKey ?? computedLogicalKey;
    const existing = this.requestClaims.get(logicalKey);
    if (existing) {
      const conflict = existing.kind !== event.type || existing.signature !== signature;
      const fields = {
        session_key: event.sessionKey,
        request_id: String(event.requestId),
        request_type: event.type,
        original_request_type: existing.kind,
        state: existing.state,
      };
      if (conflict) this.deps.logger.warn("router.conflicting_duplicate_interactive_request_ignored", fields);
      else this.deps.logger.info("router.duplicate_interactive_request_suppressed", fields);
      existing.requestIds.set(alias, event.requestId);
      this.requestAliases.set(alias, existing.logicalKey);
      return undefined;
    }
    const claim: InteractiveRequestClaim = {
      sessionKey: event.sessionKey,
      logicalKey,
      kind: event.type,
      signature,
      request: event,
      state: "rendering",
      expiresAt: now + CODEX_PROMPT_TTL_MS,
      requestIds: new Map([[alias, event.requestId]]),
    };
    this.requestClaims.set(logicalKey, claim);
    this.requestAliases.set(alias, logicalKey);
    this.trimRequestClaims();
    return claim;
  }

  private resolveRequestClaim(event: AgentServerRequestResolvedEvent): InteractiveRequestClaim | undefined {
    this.pruneRequestClaims(Date.now());
    const alias = codexRequestKey(event.sessionKey, event.requestId);
    const logicalKey = this.requestAliases.get(alias);
    const claim = logicalKey ? this.requestClaims.get(logicalKey) : undefined;
    if (!claim) return undefined;
    claim.state = "resolved";
    claim.expiresAt = Date.now() + RESOLVED_REQUEST_TOMBSTONE_MS;
    return claim;
  }

  private releaseRequestClaim(claim: InteractiveRequestClaim): void {
    if (this.requestClaims.get(claim.logicalKey) !== claim) return;
    this.requestClaims.delete(claim.logicalKey);
    for (const alias of claim.requestIds.keys()) {
      if (this.requestAliases.get(alias) === claim.logicalKey) this.requestAliases.delete(alias);
    }
  }

  private pruneRequestClaims(now: number): void {
    for (const claim of [...this.requestClaims.values()]) {
      if (claim.expiresAt <= now) this.releaseRequestClaim(claim);
    }
  }

  private trimRequestClaims(): void {
    while (this.requestClaims.size > MAX_INTERACTIVE_REQUEST_CLAIMS) {
      const oldest = this.requestClaims.values().next().value as InteractiveRequestClaim | undefined;
      if (!oldest) return;
      this.releaseRequestClaim(oldest);
    }
  }
}

function interactiveRequestLogicalKey(event: InteractiveRequestEvent, signature: string): string {
  const method = event.type === "approval_request" ? event.method : event.type;
  const stableId = "itemId" in event && typeof event.itemId === "string"
    ? `item:${event.itemId}`
    : "elicitationId" in event && typeof event.elicitationId === "string"
      ? `elicitation:${event.elicitationId}`
      : `payload:${signature}`;
  return `${event.sessionKey}\0${event.threadId ?? ""}\0${event.turnId ?? ""}\0${method}\0${stableId}`;
}

function interactiveRequestSignature(event: InteractiveRequestEvent): string {
  if (event.type === "approval_request") {
    return canonicalJson({ type: event.type, method: event.method, approvalKind: event.approvalKind, title: event.title, body: event.body, params: event.params });
  }
  if (event.type === "user_input_request") return canonicalJson({ type: event.type, questions: event.questions });
  return canonicalJson({
    type: event.type,
    serverName: event.serverName,
    mode: event.mode,
    message: event.message,
    requestedSchema: event.requestedSchema,
    url: event.url,
    elicitationId: event.elicitationId,
    meta: event.meta,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function expiredQuestionMessage(): RenderedTelegramText {
  return messageWithTitle("Question expired.", "Use Interrupt on the latest activity card, then resend your instruction.");
}

function resolvedPromptMessage(
  request: InteractiveRequestEvent | undefined,
  result: unknown,
): RenderedTelegramText | undefined {
  if (!request) return undefined;
  if (request.type === "user_input_request") return resolvedUserInputMessage(request.questions, result);
  if (request.type === "approval_request") {
    const decision = resolvedApprovalDecision(request.approvalKind, result);
    return decision ? formatApprovalDecisionMessage(decision, request.title, request.body) : undefined;
  }
  return undefined;
}

function resolvedUserInputMessage(
  questions: AgentUserInputQuestion[],
  result: unknown,
): RenderedTelegramText | undefined {
  const answers = asPromptRecord(asPromptRecord(result)?.answers);
  if (!answers) return undefined;
  const answered = questions.flatMap((question) => {
    const values = asPromptRecord(answers[question.id])?.answers;
    if (!Array.isArray(values)) return [];
    const textValues = values.filter((value): value is string => typeof value === "string");
    return textValues.length > 0 ? [{ question, values: textValues }] : [];
  });
  if (answered.length === 0) return undefined;
  if (questions.length === 1 && answered.length === 1) return answeredMessage(answered[0]!.values.join("\n"));
  return messageWithTitle("Answered:", answered.map(({ question, values }) => {
    const label = question.header || question.id;
    return values.length === 1 ? `${label}: ${values[0]}` : `${label}:\n${values.join("\n")}`;
  }).join("\n\n"));
}

function resolvedApprovalDecision(kind: AgentApprovalKind, result: unknown): string | undefined {
  const record = asPromptRecord(result);
  if (!record) return undefined;
  if (kind === "permissions") {
    const permissions = asPromptRecord(record.permissions);
    if (!permissions || Object.keys(permissions).length === 0) return "Denied.";
    return record.scope === "session" ? "Allowed for this session." : record.scope === "turn" ? "Allowed for this turn." : undefined;
  }
  const decision = record.decision;
  if (decision === "approved") return "Approved.";
  if (decision === "denied" || decision === "decline") return "Denied.";
  if (decision === "cancel") return "Cancelled.";
  if (decision === "accept") return "Approved once.";
  if (decision === "acceptForSession") return "Approved for this session.";
  const amendment = asPromptRecord(decision);
  if (amendment?.acceptWithExecpolicyAmendment) return "Approved command rule.";
  if (amendment?.applyNetworkPolicyAmendment) return "Approved network rule.";
  return undefined;
}
