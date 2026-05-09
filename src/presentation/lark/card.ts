import type { InlineKeyboardButton, InlineKeyboardMarkup, TextEntity } from "../../ports/im.ts";
import { renderLarkMarkdown } from "./markdown.ts";

export interface LarkCardOptions {
  entities?: TextEntity[];
  replyMarkup?: InlineKeyboardMarkup;
  forceReply?: boolean;
  inputFieldPlaceholder?: string;
}

export function createLarkCard(text: string, options: LarkCardOptions = {}): object {
  const bodyElements: object[] = [
    {
      tag: "markdown",
      content: renderLarkMarkdown(text, options.entities),
    },
  ];

  if (options.forceReply) {
    bodyElements.push({
      tag: "markdown",
      content: replyPromptMarkdown(options.inputFieldPlaceholder),
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: bodyElements,
    },
    ...(options.replyMarkup && options.replyMarkup.inline_keyboard.length > 0 ? {
      footer: {
        elements: options.replyMarkup.inline_keyboard.flatMap((row) => row.map(buttonElement)),
      },
    } : {}),
  };
}

function replyPromptMarkdown(placeholder: string | undefined): string {
  if (!placeholder) return "**Reply to this message.**";
  return `**Reply to this message.**\n${renderLarkMarkdown(placeholder)}`;
}

function buttonElement(button: InlineKeyboardButton): object {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.text,
    },
    type: buttonType(button.text),
    behaviors: [
      {
        type: "callback",
        value: {
          callback_data: button.callback_data,
        },
      },
    ],
  };
}

function buttonType(text: string): "default" | "primary" | "danger" {
  const normalized = text.trim().toLowerCase();
  if (["deny", "delete", "stop", "interrupt"].includes(normalized)) return "danger";
  if (["approve", "submit", "implement", "select", "continue"].includes(normalized)) return "primary";
  return "default";
}
