import type { AgentThreadSummary, AgentUserInputQuestion } from "../../ports/agent.ts";
import { renderTelegramText, truncateForTelegramLabel, type RenderedTelegramText, type TelegramTextPart } from "../../presentation/telegram/text.ts";
import { UI_BUTTON } from "./constants.ts";
import { bold, code } from "./text-parts.ts";

export function formatResumeMessage(threads: AgentThreadSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Resume chat"), "\n\n"];
  for (const [index, thread] of threads.entries()) {
    if (index > 0) parts.push("\n");
    parts.push(`${index + 1}. `, code(thread.name ?? thread.id));
    if (thread.preview) parts.push(` - ${truncateForTelegramLabel(thread.preview, 80)}`);
  }
  return renderTelegramText(parts);
}

export function confirmMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText([bold(title), "\n\n", body]);
}

export function answeredMessage(answer: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Answered:"),
    " ",
    answer,
  ]);
}

export function formatCodexSelectedAnswer(answer: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Selected:"),
    " ",
    answer,
    "\n\n",
    "Submit this answer, add a note, or change your selection.",
  ]);
}

export function formatCodexAnswerNotePrompt(answer: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Add note"),
    "\n\n",
    "Selected: ",
    answer,
    "\n\n",
    "Reply with the extra details to include.",
  ]);
}

export function formatErrorMessage(detail: string): RenderedTelegramText {
  return renderTelegramText([bold("Error:"), " ", detail]);
}

export function formatCodexQuestion(question: AgentUserInputQuestion, questionIndex?: number, totalQuestions?: number): RenderedTelegramText {
  if (typeof questionIndex === "number" && typeof totalQuestions === "number" && totalQuestions > 1) {
    return renderCodexQuestionBody([
      bold(`Question ${questionIndex + 1}/${totalQuestions}`),
      "\n",
      bold(question.header),
      "\n\n",
      question.question,
    ], question);
  }
  return renderCodexQuestionBody([bold(question.header), "\n\n", question.question], question);
}

export function renderCodexQuestionBody(parts: TelegramTextPart[], question: AgentUserInputQuestion): RenderedTelegramText {
  const options = question.options ?? [];
  if (!question.isSecret && options.length > 0) {
    parts.push("\n\n");
    for (const [index, option] of options.entries()) {
      if (index > 0) parts.push("\n");
      parts.push(bold(option.label));
      if (option.description) parts.push(` - ${option.description}`);
    }
    if (question.isOther) {
      parts.push("\n", bold("Other"));
    }
  }
  return renderTelegramText(parts);
}

export function formatApprovalMessage(title: string, body: string): RenderedTelegramText {
  return renderTelegramText(approvalMessageParts(title, body));
}

export function formatApprovalDecisionMessage(decision: string, title: string, body: string): RenderedTelegramText {
  return renderTelegramText([
    bold(decision),
    "\n\n",
    ...approvalMessageParts(title, body),
  ]);
}

export function approvalMessageParts(title: string, body: string): TelegramTextPart[] {
  const parts: TelegramTextPart[] = [bold(title)];
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (lines.length > 0) {
    parts.push("\n\n");
    for (const [index, line] of lines.entries()) {
      if (index > 0) parts.push("\n");
      if (line.startsWith("cwd: ")) {
        parts.push("cwd: ", code(line.slice(5)));
      } else if (index === lines.length - 1 && lines.length > 1) {
        parts.push(code(line));
      } else {
        parts.push(line);
      }
    }
  }
  return parts;
}

export function formatWorkspacesMessage(workspaces: Array<{ name: string; selected: boolean }>, pageIndex: number, totalPages: number): RenderedTelegramText {
  if (workspaces.length === 0) {
    return renderTelegramText([
      bold("Workspaces"),
      `\n\nNo cwd directories found.\nUse ${UI_BUTTON.create} to create one.`,
    ]);
  }
  const parts: TelegramTextPart[] = [bold("Workspaces"), `\n\nPage ${pageIndex + 1}/${totalPages}\n`];
  for (const workspace of workspaces) {
    parts.push("\n", workspace.selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `, code(workspace.name));
  }
  return renderTelegramText(parts);
}
