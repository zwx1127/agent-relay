import type { AgentThreadSummary, AgentUserInputOption } from "../../ports/agent.ts";
import type { InlineKeyboardMarkup } from "../../ports/im.ts";
import type { HomeStatusMode, WorkspaceRecord } from "../types.ts";
import { UI_BUTTON, WORKSPACE_BUTTON_LABEL_WIDTH } from "./constants.ts";
import { deleteWorkspaceCallbackData, workspaceCallbackData } from "./callback-data.ts";

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

export function approvalKeyboard(token: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.approve, callback_data: `ar:a:${token}:y` },
      { text: UI_BUTTON.deny, callback_data: `ar:a:${token}:n` },
    ]],
  };
}

export function codexQuestionKeyboard(token: string, options: AgentUserInputOption[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((option, index) => [{
      text: buttonLabel(option.label),
      callback_data: `ar:q:${token}:${index}`,
    }]),
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
      text: workspaceButtonText(workspace.name, workspace.name === selected),
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
        { text: UI_BUTTON.create, callback_data: "ar:n" },
        { text: UI_BUTTON.refresh, callback_data: "ar:w" },
      ],
    ],
  };
}

export function deleteWorkspaceConfirmKeyboard(name: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: UI_BUTTON.delete, callback_data: deleteWorkspaceCallbackData(name, true) },
      { text: UI_BUTTON.workspace, callback_data: "ar:w" },
    ]],
  };
}

export function buttonLabel(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

export function workspaceButtonText(name: string, selected: boolean): string {
  const prefix = selected ? `${UI_BUTTON.selected} ` : `${UI_BUTTON.unselected} `;
  return `${prefix}${buttonLabel(name).padEnd(WORKSPACE_BUTTON_LABEL_WIDTH, "\u00A0")}`;
}
