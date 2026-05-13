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
      text_align: "left",
      text_size: "normal",
    },
  ];

  if (options.forceReply) {
    elements.push({
      tag: "markdown",
      content: replyPromptMarkdown(options.inputFieldPlaceholder),
      text_align: "left",
      text_size: "normal",
    });
  }

  for (const row of options.replyMarkup?.inline_keyboard ?? []) {
    if (row.length === 0) continue;
    elements.push(buttonRowElement(row, callbackNonce));
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
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
    width: "fill",
    size: "small",
    behaviors: [{
      type: "callback",
      value: {
        callback_nonce: callbackNonce,
        callback_data: button.callback_data,
      },
    }],
  };
}

function buttonRowElement(row: InlineKeyboardButton[], callbackNonce: string): object {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: row.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      padding: "0px 0px 0px 0px",
      vertical_spacing: "8px",
      elements: [buttonElement(button, callbackNonce)],
    })),
  };
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
