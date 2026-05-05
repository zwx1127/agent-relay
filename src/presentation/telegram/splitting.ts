import type { RenderedTelegramText, TelegramMessageEntity } from "./primitives.ts";

export function splitForTelegram(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const newlineIndex = window.lastIndexOf("\n");
    const splitAt = newlineIndex > Math.floor(maxChars * 0.6) ? newlineIndex + 1 : maxChars;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export function splitRenderedForTelegram(rendered: RenderedTelegramText, maxChars = 3500): RenderedTelegramText[] {
  if (rendered.text.length <= maxChars) return [rendered];
  const ranges = splitRanges(rendered.text, maxChars);
  return ranges.map(([start, end]) => ({
    text: rendered.text.slice(start, end),
    entities: rendered.entities
      .map((entity) => clipEntity(entity, start, end))
      .filter((entity): entity is TelegramMessageEntity => Boolean(entity)),
  }));
}

export function splitHtmlForTelegram(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const stack: Array<{ name: string; open: string }> = [];
  let current = "";

  for (const token of htmlTokens(text)) {
    const closing = isClosingTag(token.value) ? "" : closingTags(stack);
    if (current.length > 0 && current.length + token.value.length + closing.length > maxChars) {
      chunks.push(current + closing);
      current = stack.map((entry) => entry.open).join("");
    }

    current += token.value;
    if (token.kind === "tag") updateHtmlStack(stack, token.value);
  }

  if (current.length > 0) chunks.push(current + closingTags(stack));
  return chunks.length > 0 ? chunks : [text];
}

function splitRanges(text: string, maxChars: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + maxChars);
    const end = chooseSplitEnd(text, start, hardEnd, maxChars);
    ranges.push([start, end]);
    start = end;
  }
  return ranges.length > 0 ? ranges : [[0, 0]];
}

function chooseSplitEnd(text: string, start: number, hardEnd: number, maxChars: number): number {
  if (hardEnd >= text.length) return hardEnd;
  const window = text.slice(start, hardEnd);
  const candidates: Array<{ index: number; minRatio: number; width: number }> = [
    { index: window.lastIndexOf("\n\n"), minRatio: 0.45, width: 2 },
    { index: window.lastIndexOf("\n"), minRatio: 0.6, width: 1 },
    { index: window.lastIndexOf(" "), minRatio: 0.7, width: 1 },
  ];
  for (const candidate of candidates) {
    if (candidate.index > Math.floor(maxChars * candidate.minRatio)) {
      return start + candidate.index + candidate.width;
    }
  }
  return hardEnd;
}

function clipEntity(entity: TelegramMessageEntity, start: number, end: number): TelegramMessageEntity | undefined {
  const entityStart = entity.offset;
  const entityEnd = entity.offset + entity.length;
  const clippedStart = Math.max(entityStart, start);
  const clippedEnd = Math.min(entityEnd, end);
  if (clippedEnd <= clippedStart) return undefined;
  return {
    ...entity,
    offset: clippedStart - start,
    length: clippedEnd - clippedStart,
  };
}

function htmlTokens(text: string): Array<{ kind: "tag" | "text"; value: string }> {
  const tokens: Array<{ kind: "tag" | "text"; value: string }> = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      if (end > index) {
        tokens.push({ kind: "tag", value: text.slice(index, end + 1) });
        index = end + 1;
        continue;
      }
    }
    if (text[index] === "&") {
      const entity = /^&(?:amp|lt|gt|quot);/.exec(text.slice(index));
      if (entity) {
        tokens.push({ kind: "text", value: entity[0] });
        index += entity[0].length;
        continue;
      }
    }
    tokens.push({ kind: "text", value: text[index] ?? "" });
    index += 1;
  }
  return tokens;
}

function updateHtmlStack(stack: Array<{ name: string; open: string }>, tag: string): void {
  const close = /^<\/([a-z0-9]+)>$/i.exec(tag);
  if (close) {
    const name = close[1]?.toLowerCase();
    const index = stack.findLastIndex((entry) => entry.name === name);
    if (index >= 0) stack.splice(index, 1);
    return;
  }

  const open = /^<([a-z0-9]+)(?:\s[^>]*)?>$/i.exec(tag);
  if (!open) return;
  const name = open[1]?.toLowerCase();
  if (!name || tag.endsWith("/>")) return;
  stack.push({ name, open: tag });
}

function isClosingTag(value: string): boolean {
  return /^<\/[a-z0-9]+>$/i.test(value);
}

function closingTags(stack: Array<{ name: string }>): string {
  return stack.toReversed().map((entry) => `</${entry.name}>`).join("");
}
