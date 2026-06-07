import type { AgentBackgroundTerminalSummary, AgentThreadGoal, AgentThreadSummary, AgentUserInputQuestion } from "../../ports/agent.ts";
import { renderTelegramText, truncateForTelegramLabel, type RenderedTelegramText, type TelegramTextPart } from "../../presentation/telegram/text.ts";
import { UI_BUTTON } from "./constants.ts";
import { bold, code } from "./text-parts.ts";

export function formatHelpMessage(): RenderedTelegramText {
  return renderTelegramText([
    bold("Relay commands"),
    "\n\n",
    "Use these slash commands in Relay:\n",
    "- ", code("/help"), " - Show this command help.\n",
    "- ", code("/relay"), " - Open Relay Home.\n",
    "- ", code("/review"), " - Review uncommitted changes.\n",
    "- ", code("/review branch <name>"), " - Review against a base branch.\n",
    "- ", code("/review commit <sha> [title]"), " - Review a commit.\n",
    "- ", code("/review <instructions>"), " - Run a custom review.\n",
    "- ", code("/compact"), " - Start Codex thread compaction.\n",
    "- ", code("/init"), " - Ask Codex to create AGENTS.md if missing.\n",
    "- ", code("/new"), ", ", code("/clear"), " - Start a fresh Codex thread.\n",
    "- ", code("/resume [search]"), " - Resume a recent Codex thread.\n",
    "- ", code("/fork"), " - Fork the current thread.\n",
    "- ", code("/side <prompt>"), ", ", code("/btw <prompt>"), " - Ask in an ephemeral side conversation.\n",
    "- ", code("/rename <name>"), " - Rename the current thread.\n",
    "- ", code("/plan"), " - Toggle Plan mode.\n",
    "- ", code("/plan <prompt>"), " - Run a prompt in Plan mode.\n",
    "- ", code("/goal"), " - Show the current goal.\n",
    "- ", code("/goal <objective>"), " - Set the current goal.\n",
    "- ", code("/goal pause"), ", ", code("/goal resume"), ", ", code("/goal clear"), " - Manage the goal.\n",
    "- ", code("/interrupt"), " - Interrupt the active Codex turn.\n",
    "- ", code("/interrupt all"), " - Interrupt the active turn and queued prompts.\n",
    "- ", code("/ps"), " - List Codex background terminals.\n",
    "- ", code("/stop"), " - Clean Codex background terminals for this thread.",
  ]);
}

export function formatResumeMessage(threads: AgentThreadSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Resume chat"), "\n\n"];
  for (const [index, thread] of threads.entries()) {
    if (index > 0) parts.push("\n");
    parts.push(`${index + 1}. `, code(thread.name ?? thread.id));
    if (thread.preview) parts.push(` - ${truncateForTelegramLabel(thread.preview, 80)}`);
  }
  return renderTelegramText(parts);
}

export function formatBackgroundTerminalsMessage(terminals: AgentBackgroundTerminalSummary[]): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Background terminals"), "\n\n"];
  if (terminals.length === 0) {
    parts.push("No background terminals running.");
    return renderTelegramText(parts);
  }

  const shown = terminals.slice(0, 16);
  for (const [index, terminal] of shown.entries()) {
    if (index > 0) parts.push("\n");
    parts.push("- ", code(truncateForTelegramLabel(firstLine(terminal.commandDisplay), 120)));
    for (const chunk of terminal.recentChunks) {
      parts.push("\n  ", truncateForTelegramLabel(firstLine(chunk), 120));
    }
  }
  const remaining = terminals.length - shown.length;
  if (remaining > 0) parts.push(`\n... and ${remaining} more running`);
  return renderTelegramText(parts);
}

export function formatGoalMessage(goal: AgentThreadGoal | null): RenderedTelegramText {
  const parts: TelegramTextPart[] = [bold("Goal"), "\n\n"];
  if (!goal) {
    parts.push(
      "Usage:\n",
      "- /goal\n",
      "- /goal <objective>\n",
      "- /goal pause\n",
      "- /goal resume\n",
      "- /goal clear\n\n",
      "No goal is currently set.",
    );
    return renderTelegramText(parts);
  }

  parts.push(
    "Status: ",
    formatGoalStatus(goal.status),
    "\nObjective: ",
    goal.objective,
  );
  const summary = goalUsageSummary(goal);
  if (summary) parts.push("\n", summary);
  return renderTelegramText(parts);
}

export function formatGoalUpdatedMessage(goal: AgentThreadGoal): RenderedTelegramText {
  return renderTelegramText([bold("Goal updated."), "\n\n", ...goalSummaryParts(goal)]);
}

export function formatGoalReplaceMessage(current: AgentThreadGoal, objective: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Replace goal?"),
    "\n\nCurrent: ",
    current.objective,
    "\n\nNew: ",
    objective,
  ]);
}

export function formatGoalClearedMessage(cleared: boolean): RenderedTelegramText {
  return renderTelegramText([bold(cleared ? "Goal cleared." : "No goal to clear.")]);
}

function goalSummaryParts(goal: AgentThreadGoal): TelegramTextPart[] {
  const parts: TelegramTextPart[] = [
    "Status: ",
    formatGoalStatus(goal.status),
    "\nObjective: ",
    goal.objective,
  ];
  const summary = goalUsageSummary(goal);
  if (summary) parts.push("\n", summary);
  return parts;
}

function goalUsageSummary(goal: AgentThreadGoal): string {
  const parts: string[] = [];
  if (goal.timeUsedSeconds > 0) parts.push(`Time: ${formatGoalDuration(goal.timeUsedSeconds)}.`);
  if (goal.tokenBudget !== null) parts.push(`Tokens: ${formatGoalCount(goal.tokensUsed)}/${formatGoalCount(goal.tokenBudget)}.`);
  return parts.join(" ");
}

function formatGoalStatus(status: AgentThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "budgetLimited":
      return "limited by budget";
    case "complete":
      return "complete";
  }
}

function formatGoalDuration(secondsValue: number): string {
  const seconds = Math.max(0, Math.floor(secondsValue));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatGoalCount(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}K`;
  return String(value);
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
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

export function formatCodexSelectedAnswerSummary(answer: string): RenderedTelegramText {
  return renderTelegramText([
    bold("Selected:"),
    " ",
    answer,
  ]);
}

export function formatCodexAnswerNotePrompt(): RenderedTelegramText {
  return renderTelegramText([
    bold("Add note"),
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
        parts.push("workspace: ", code(line.slice(5)));
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
      `\n\nNo workspace directories found.\nUse ${UI_BUTTON.create} to create one.`,
    ]);
  }
  const parts: TelegramTextPart[] = [bold("Workspaces"), `\n\nPage ${pageIndex + 1}/${totalPages}\n`];
  for (const workspace of workspaces) {
    parts.push("\n", workspace.selected ? "✅ " : "⬜ ", code(workspace.name));
  }
  return renderTelegramText(parts);
}
