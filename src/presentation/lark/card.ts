import { randomBytes } from "node:crypto";
import type { InlineKeyboardButton, InlineKeyboardMarkup, TextEntity } from "../../ports/im.ts";
import { renderLarkMarkdown } from "./markdown.ts";

export interface LarkCardOptions {
  entities?: TextEntity[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  inputFieldPlaceholder?: string;
}

export function createLarkCard(text: string, options: LarkCardOptions = {}): object {
  const callbackNonce = cardCallbackNonce();
  const elements: object[] = [
    {
      tag: "markdown",
      content: renderLarkMarkdown(text, options.entities),
    },
  ];

  if (options.forceReply) {
    elements.push({
      tag: "markdown",
      content: replyPromptMarkdown(options.inputFieldPlaceholder),
    });
  }

  for (const row of options.replyMarkup?.inline_keyboard ?? []) {
    if (row.length === 0) continue;
    elements.push({
      tag: "action",
      ...actionLayout(row),
      actions: row.map((button) => buttonElement(button, callbackNonce)),
    });
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    elements,
  };
}

function replyPromptMarkdown(placeholder: string | undefined): string {
  if (!placeholder) return "**Reply to this message.**";
  return `**Reply to this message.**\n${renderLarkMarkdown(placeholder)}`;
}

function buttonElement(button: InlineKeyboardButton, callbackNonce: string): object {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.text,
    },
    type: buttonType(button.text),
    value: {
      callback_nonce: callbackNonce,
      callback_data: button.callback_data,
    },
  };
}

function actionLayout(row: InlineKeyboardButton[]): { layout?: "bisected" | "trisection" | "flow" } {
  if (row.length === 2) return { layout: "bisected" };
  if (row.length === 3) return { layout: "trisection" };
  if (row.length >= 4) return { layout: "flow" };
  return {};
}

function cardCallbackNonce(): string {
  return randomBytes(8).toString("hex");
}

function buttonType(text: string): "default" | "primary" | "danger" {
  const normalized = text.trim().toLowerCase();
  if (["deny", "delete", "stop", "interrupt"].includes(normalized)) return "danger";
  if (["approve", "submit", "implement", "select", "continue"].includes(normalized)) return "primary";
  return "default";
}
