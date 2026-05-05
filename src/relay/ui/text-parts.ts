import { renderTelegramText, type RenderedTelegramText, type TelegramTextPart } from "../../presentation/telegram/text.ts";

export function bold(text: string): TelegramTextPart {
  return { text, entity: "bold" };
}

export function code(text: string): TelegramTextPart {
  return { text, entity: "code" };
}

export function textMessage(text: string): RenderedTelegramText {
  return renderTelegramText([text]);
}

export function ensureRendered(body: string | RenderedTelegramText): RenderedTelegramText {
  return typeof body === "string" ? textMessage(body) : body;
}

export function messageWithTitle(title: string, body?: string): RenderedTelegramText {
  return renderTelegramText(body ? [bold(title), "\n\n", body] : [bold(title)]);
}
