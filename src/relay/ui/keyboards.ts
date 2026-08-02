import type { AgentThreadSummary, AgentUserInputOption } from "../../ports/agent.ts";
import type { InlineKeyboardMarkup } from "../../ports/im.ts";
import type { HomeStatusMode, WorkspaceRecord } from "../types.ts";
import { UI_BUTTON } from "./constants.ts";
import { deleteWorkspaceCallbackData, workspaceCallbackData, workspaceIntroCallbackData } from "./callback-data.ts";

export function pagedOutputKeyboard(token: string, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  if (totalPages <= 1) return { inline_keyboard: [] };
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.firstPage, callback_data: `ar:p:${token}:0` },
      { text: UI_BUTTON.previousPage, callback_data: `ar:p:${token}:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:p:${token}:${Math.min(totalPages - 1, pageIndex + 1)}` },
      { text: UI_BUTTON.lastPage, callback_data: `ar:p:${token}:${totalPages - 1}` },
    ]],
  };
}

export function resumeKeyboard(token: string, threads: AgentThreadSummary[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: threads.map((thread, index) => [{
      text: buttonLabel(thread.name ?? thread.id),
      callback_data: `ar:cmd:resume:${token}:${index}`,
    }]),
  };
}

export function planReadyKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Implement", callback_data: `ar:cmd:plan:${token}:implement` },
      { text: "Continue", callback_data: `ar:cmd:plan:${token}:continue` },
    ]],
  };
}

export function approvalKeyboard(token: string, choices: Array<{ action: string; label: string }>): InlineKeyboardMarkup {
  return {
    inline_keyboard: choices.map((choice) => [{ text: choice.label, callback_data: `ar:a:${token}:${choice.action}` }]),
  };
}

export function attachmentPickerKeyboard(
  token: string,
  entries: Array<{ label: string }>,
  pageIndex: number,
  totalPages: number,
): InlineKeyboardMarkup {
  const rows = entries.map((entry, index) => [{
    text: buttonLabel(entry.label),
    callback_data: `ar:cmd:attach:${token}:i${pageIndex * 8 + index}`,
  }]);
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.previousPage, callback_data: `ar:cmd:attach:${token}:p${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:cmd:attach:${token}:p${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }
  return { inline_keyboard: rows };
}

export function activityDetailsKeyboard(detailsToken?: string, diffToken?: string): InlineKeyboardMarkup {
  const row: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (detailsToken) row.push({ text: "View details", callback_data: `ar:p:${detailsToken}:0` });
  if (diffToken) row.push({ text: "View diff", callback_data: `ar:p:${diffToken}:0` });
  return { inline_keyboard: row.length ? [row] : [] };
}

export function commandConfirmKeyboard(token: string, command: string, confirmLabel: string, action = "confirm"): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: confirmLabel, callback_data: `ar:cmd:${command}:${token}:${action}` },
      { text: "Cancel", callback_data: `ar:cmd:${command}:${token}:cancel` },
    ]],
  };
}

export function backgroundTerminalsKeyboard(token: string, terminals: AgentThreadSummaryLike[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: terminals
      .filter((terminal) => Boolean(terminal.processId))
      .map((terminal, index) => [{
        text: `Stop ${buttonLabel(terminal.commandDisplay || terminal.processId || "terminal")}`,
        callback_data: `ar:cmd:terminal:${token}:${index}`,
      }]),
  };
}

interface AgentThreadSummaryLike {
  processId?: string;
  commandDisplay: string;
}

export function mcpElicitationKeyboard(token: string, actions: Array<{ action: string; label: string }>): InlineKeyboardMarkup {
  return {
    inline_keyboard: actions.map((choice) => [{ text: choice.label, callback_data: `ar:m:${token}:${choice.action}` }]),
  };
}

export function codexQuestionKeyboard(token: string, options: AgentUserInputOption[], includeOther = false): InlineKeyboardMarkup {
  const rows = options.map((option, index) => [{
      text: buttonLabel(option.label),
      callback_data: `ar:q:${token}:${index}`,
    }]);
  if (includeOther) rows.push([{ text: "Other", callback_data: `ar:q:${token}:other` }]);
  return {
    inline_keyboard: rows,
  };
}

export function codexQuestionConfirmKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "Submit", callback_data: `ar:q:${token}:submit` },
        { text: "Add note", callback_data: `ar:q:${token}:note` },
      ],
      [{ text: "Change", callback_data: `ar:q:${token}:change` }],
    ],
  };
}

export function consoleKeyboard(status: { workspaceName?: string; running?: boolean }, mode: HomeStatusMode): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  rows.push([
    { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    { text: mode === "details" ? UI_BUTTON.compact : UI_BUTTON.status, callback_data: "ar:status" },
    { text: UI_BUTTON.refresh, callback_data: "ar:s" },
  ]);
  if (status.workspaceName) {
    rows.push([{ text: UI_BUTTON.stop, callback_data: "ar:stop" }]);
  }
  return {
    inline_keyboard: rows,
  };
}

export function workspacesKeyboard(workspaces: WorkspaceRecord[], selected: string | undefined, pageIndex: number, totalPages: number): InlineKeyboardMarkup {
  const rows = workspaces.map((workspace) => [
    {
      text: buttonLabel(workspace.name),
      callback_data: workspaceIntroCallbackData(workspace.name, pageIndex),
    },
    {
      text: workspace.name === selected ? UI_BUTTON.selected : UI_BUTTON.unselected,
      callback_data: workspaceCallbackData(workspace.name),
    },
    { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(workspace.name, false) },
  ]);
  if (totalPages > 1) {
    rows.push([
      { text: UI_BUTTON.previousPage, callback_data: `ar:wl:${Math.max(0, pageIndex - 1)}` },
      { text: UI_BUTTON.nextPage, callback_data: `ar:wl:${Math.min(totalPages - 1, pageIndex + 1)}` },
    ]);
  }

  return {
    inline_keyboard: [
      ...rows,
      [
        { text: UI_BUTTON.back, callback_data: "ar:home" },
        { text: UI_BUTTON.create, callback_data: `ar:n:${pageIndex}` },
        { text: UI_BUTTON.refresh, callback_data: "ar:w" },
      ],
    ],
  };
}

export function deleteWorkspaceConfirmKeyboard(name: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(name, true) },
      { text: UI_BUTTON.back, callback_data: "ar:home" },
    ]],
  };
}

export function workspaceIntroKeyboard(workspace: WorkspaceRecord, selected: boolean, pageIndex: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: UI_BUTTON.back, callback_data: `ar:wl:${pageIndex}` },
        {
          text: selected ? UI_BUTTON.selected : UI_BUTTON.unselected,
          callback_data: workspaceCallbackData(workspace.name),
        },
        { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(workspace.name, false) },
      ],
    ],
  };
}

export function buttonLabel(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}
