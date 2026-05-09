import type {
  AgentApprovalKind,
  AgentApprovalRequestEvent,
  AgentDriver,
  AgentUserInputOption,
  AgentUserInputQuestion,
  AgentUserInputRequestEvent,
} from "../ports/agent.ts";
import type { ImAdapter, InboundMessage, InlineKeyboardMarkup, SendMessageOptions } from "../ports/im.ts";
import type { ConversationId, MessageId } from "../domain/ids.ts";
import { parseSessionKey } from "../domain/session.ts";
import type { RelayStore } from "../storage/store.ts";
import { CODEX_PROMPT_TTL_MS } from "./ui/constants.ts";
import { codexRequestKey, shortToken } from "./ui/callback-data.ts";
import { approvalKeyboard, codexQuestionConfirmKeyboard, codexQuestionKeyboard } from "./ui/keyboards.ts";
import { approvalResponse, asPromptRecord, isExpired, parsePromptPayload } from "./ui/prompt-state.ts";
import {
  answeredMessage,
  formatApprovalDecisionMessage,
  formatApprovalMessage,
  formatCodexAnswerNotePrompt,
  formatCodexQuestion,
  formatCodexSelectedAnswer,
  formatCodexSelectedAnswerSummary,
} from "./ui/messages.ts";
import { messageWithTitle, textMessage } from "./ui/text-parts.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

interface PendingPrompt {
  conversationId: ConversationId;
  promptMessageId: MessageId;
  kind: "workspace_name" | "codex_user_input" | "codex_approval" | "relay_command";
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
  renderCallbackPage(message: CallbackMessage, body: string | RenderedTelegramText, replyMarkup: InlineKeyboardMarkup): Promise<void>;
  markActiveTask(sessionKey: string, status: "blocked" | "running", turnId?: string): Promise<void>;
}

export class CodexPromptFlow {
  private readonly codexRequests = new Map<string, {
    sessionKey: string;
    requestId: string | number;
    questions: AgentUserInputQuestion[];
    answers: Record<string, { answers: string[] }>;
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
    await this.sendCodexQuestion(parsed.conversationId, event.sessionKey, event.requestId, first, 0, token, expiresAt);
  }

  async handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const token = shortToken();
    const expiresAt = Date.now() + CODEX_PROMPT_TTL_MS;
    const result = await this.deps.sendRendered(parsed.conversationId, formatApprovalMessage(event.title, event.body), {
      replyMarkup: approvalKeyboard(token),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return an approval prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: parsed.conversationId,
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
    const result = await this.deps.sendRendered(conversationId, formatCodexQuestion(question, questionIndex, totalQuestions), {
      ...(useInlineOptions ? { replyMarkup: codexQuestionKeyboard(token, options, Boolean(question.isOther)) } : { forceReply: true }),
      disableWebPagePreview: true,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId,
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
      await this.expireCallbackPrompt(message);
      return;
    }

    if (rawAction === "submit") {
      const selectedAnswer = typeof data.selectedAnswer === "string" ? data.selectedAnswer : undefined;
      if (!selectedAnswer) throw new Error("Question selection expired.");
      const response = await this.recordCodexAnswer(pending, data, [selectedAnswer]);
      if (response === "expired") return;
      if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
      await this.deps.renderCallbackPage(message, answeredMessage(selectedAnswer), { inline_keyboard: [] });
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
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: undefined, answerMode: undefined }),
      });
      await this.deps.renderCallbackPage(message, formatCodexQuestion(question, questionIndex, totalQuestions), codexQuestionKeyboard(token, options, Boolean(data.isOther)));
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
      this.deps.store.setPendingPrompt({
        ...pending,
        payloadJson: JSON.stringify({ ...data, selectedAnswer: answer }),
      });
      await this.deps.renderCallbackPage(message, formatCodexSelectedAnswer(answer), codexQuestionConfirmKeyboard(token));
      return;
    }

    const response = await this.recordCodexAnswer(pending, data, [answer]);
    if (response === "expired") return;
    if (!response) await this.sendNextCodexQuestion(message.conversationId, pending, data);
    await this.deps.renderCallbackPage(message, answeredMessage(answer), { inline_keyboard: [] });
    if (response) await this.respondToCodexPrompt(response);
  }

  private async promptForCodexAnswerNote(
    message: CallbackMessage,
    pending: PendingPrompt,
    data: Record<string, unknown>,
    selectedAnswer: string,
  ): Promise<void> {
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.deps.renderCallbackPage(message, formatCodexSelectedAnswerSummary(selectedAnswer), { inline_keyboard: [] });
    const result = await this.deps.sendRendered(message.conversationId, formatCodexAnswerNotePrompt(), {
      forceReply: true,
      disableWebPagePreview: true,
      replyToMessageId: pending.promptMessageId,
    });
    if (!result.messageId) throw new Error("IM adapter did not return a note prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
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
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.deps.renderCallbackPage(message, formatCodexSelectedAnswerSummary("Other"), { inline_keyboard: [] });
    const result = await this.deps.sendRendered(message.conversationId, messageWithTitle("Other answer", "Reply with the answer to use."), {
      forceReply: true,
      disableWebPagePreview: true,
      replyToMessageId: pending.promptMessageId,
    });
    if (!result.messageId) throw new Error("IM adapter did not return an other-answer prompt message id.");
    this.deps.store.setPendingPrompt({
      conversationId: message.conversationId,
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
      await this.deps.sendRendered(conversationId, textMessage("Question expired."));
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
      this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
      await this.deps.sendRendered(pending.conversationId, textMessage("Question expired."));
      return "expired";
    }

    request.answers[questionId] = { answers };
    this.deps.store.deletePendingPrompt(pending.conversationId, pending.promptMessageId);
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
      await this.expireCallbackPrompt(message);
      return;
    }
    if (!pending.sessionKey || !this.deps.agent.respond) throw new Error("Approval session is missing.");
    const approved = decision === "y";
    this.deps.store.deletePendingPrompt(message.conversationId, pending.promptMessageId);
    await this.deps.renderCallbackPage(
      message,
      formatApprovalDecisionMessage(
        approved ? "Approved." : "Denied.",
        typeof data.title === "string" ? data.title : "Approval request",
        typeof data.body === "string" ? data.body : "",
      ),
      { inline_keyboard: [] },
    );
    await this.deps.agent.respond(pending.sessionKey, data.requestId as string | number, approvalResponse(data.approvalKind as AgentApprovalKind, approved, data.params));
    await this.deps.markActiveTask(pending.sessionKey, "running");
  }

  private async expireCallbackPrompt(message: CallbackMessage): Promise<void> {
    if (message.messageId) this.deps.store.deletePendingPrompt(message.conversationId, message.messageId);
    await this.deps.renderCallbackPage(message, messageWithTitle("Question expired."), { inline_keyboard: [] });
  }

  clearForSession(sessionKeyValue: string): void {
    this.deps.store.deletePendingPromptsForSession(sessionKeyValue, ["codex_user_input", "codex_approval"]);
    for (const key of this.codexRequests.keys()) {
      if (key.startsWith(`${sessionKeyValue}:`)) this.codexRequests.delete(key);
    }
  }
}
