import type { AgentTokenUsage, TelegramMessageEntity } from "../types.ts";

export interface RenderedTelegramText {
  text: string;
  entities: TelegramMessageEntity[];
}

export type TelegramTextPart =
  | string
  | {
    text: string;
    entity?: TelegramMessageEntity["type"];
    url?: string;
    language?: string;
  };

export function truncateForTelegramLabel(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return ".".repeat(maxChars);
  const head = Math.ceil((maxChars - 3) / 2);
  const tail = Math.floor((maxChars - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

export function contextUsageBar(percent: number | undefined, width = 5): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "▱".repeat(safeWidth);
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * safeWidth);
  return `${"▰".repeat(filled)}${"▱".repeat(safeWidth - filled)}`;
}

export function renderTelegramText(parts: TelegramTextPart[]): RenderedTelegramText {
  const output = new TelegramTextBuilder();
  for (const part of parts) {
    if (typeof part === "string") {
      output.append(part);
      continue;
    }
    const start = output.length;
    output.append(part.text);
    if (part.entity) {
      output.entity({
        type: part.entity,
        offset: start,
        length: output.length - start,
        ...(part.url ? { url: part.url } : {}),
        ...(part.language ? { language: part.language } : {}),
      });
    }
  }
  return output.rendered();
}

export function appendRendered(base: RenderedTelegramText, suffix: RenderedTelegramText): RenderedTelegramText {
  const offset = base.text.length;
  return {
    text: `${base.text}${suffix.text}`,
    entities: [
      ...base.entities,
      ...suffix.entities.map((entity) => ({ ...entity, offset: entity.offset + offset })),
    ],
  };
}

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

export function renderCodexMarkdownForTelegram(text: string): RenderedTelegramText {
  const output = new TelegramTextBuilder();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let codeBlock: { language?: string; lines: string[] } | undefined;
  let firstRenderedLine = true;

  const beginRenderedLine = (): void => {
    if (firstRenderedLine) {
      firstRenderedLine = false;
      return;
    }
    output.newline();
  };

  const renderCodeBlock = (): void => {
    if (!codeBlock) return;
    beginRenderedLine();
    const start = output.length;
    output.append(codeBlock.lines.join("\n"));
    if (output.length > start) {
      output.entity({
        type: "pre",
        offset: start,
        length: output.length - start,
        ...(codeBlock.language ? { language: codeBlock.language } : {}),
      });
    }
    codeBlock = undefined;
  };

  for (const line of lines) {
    const fence = /^\s*```([A-Za-z0-9_+.-]+)?\s*$/.exec(line);
    if (fence) {
      if (codeBlock) {
        renderCodeBlock();
      } else {
        codeBlock = { language: fence[1], lines: [] };
      }
      continue;
    }

    if (codeBlock) {
      codeBlock.lines.push(line);
      continue;
    }

    beginRenderedLine();
    renderMarkdownLine(output, line);
  }

  renderCodeBlock();

  return output.rendered();
}

class TelegramTextBuilder {
  private value = "";
  private readonly entityList: TelegramMessageEntity[] = [];

  get length(): number {
    return this.value.length;
  }

  append(text: string): void {
    this.value += text;
  }

  newline(): void {
    this.value += "\n";
  }

  entity(entity: TelegramMessageEntity): void {
    if (entity.length > 0) this.entityList.push(entity);
  }

  rendered(): RenderedTelegramText {
    return { text: this.value, entities: this.entityList };
  }
}

function renderMarkdownLine(output: TelegramTextBuilder, line: string): void {
  if (line.trim().length === 0) return;

  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const start = output.length;
    renderInlineMarkdown(output, heading[2] ?? "");
    output.entity({ type: "bold", offset: start, length: output.length - start });
    return;
  }

  const blockquote = /^\s*>\s?(.+)$/.exec(line);
  if (blockquote) {
    const start = output.length;
    renderInlineMarkdown(output, blockquote[1] ?? "");
    output.entity({ type: "blockquote", offset: start, length: output.length - start });
    return;
  }

  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
  if (task) {
    output.append(task[1] ?? "");
    output.append(task[2]?.toLowerCase() === "x" ? "[x] " : "[ ] ");
    renderInlineMarkdown(output, task[3] ?? "");
    return;
  }

  const unordered = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (unordered) {
    output.append(unordered[1] ?? "");
    output.append("• ");
    renderInlineMarkdown(output, unordered[2] ?? "");
    return;
  }

  const ordered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(line);
  if (ordered) {
    output.append(ordered[1] ?? "");
    output.append(`${ordered[2]}. `);
    renderInlineMarkdown(output, ordered[3] ?? "");
    return;
  }

  renderInlineMarkdown(output, line);
}

function renderInlineMarkdown(output: TelegramTextBuilder, value: string): void {
  let index = 0;

  while (index < value.length) {
    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      if (end > index + 1) {
        const start = output.length;
        output.append(value.slice(index + 1, end));
        output.entity({ type: "code", offset: start, length: output.length - start });
        index = end + 1;
        continue;
      }
    }

    const link = tryParseMarkdownLink(value, index);
    if (link) {
      const start = output.length;
      renderInlineMarkdown(output, link.label);
      output.entity({ type: "text_link", offset: start, length: output.length - start, url: link.url });
      index = link.end;
      continue;
    }

    const boldMarker = value.startsWith("**", index) ? "**" : value.startsWith("__", index) ? "__" : undefined;
    if (boldMarker) {
      const end = value.indexOf(boldMarker, index + boldMarker.length);
      if (end > index + boldMarker.length) {
        const start = output.length;
        renderInlineMarkdown(output, value.slice(index + boldMarker.length, end));
        output.entity({ type: "bold", offset: start, length: output.length - start });
        index = end + boldMarker.length;
        continue;
      }
    }

    const italicMarker = value[index] === "*" ? "*" : value[index] === "_" ? "_" : undefined;
    if (italicMarker) {
      const end = value.indexOf(italicMarker, index + 1);
      if (end > index + 1) {
        const start = output.length;
        renderInlineMarkdown(output, value.slice(index + 1, end));
        output.entity({ type: "italic", offset: start, length: output.length - start });
        index = end + 1;
        continue;
      }
    }

    output.append(value[index] ?? "");
    index += 1;
  }
}

function tryParseMarkdownLink(value: string, index: number): { label: string; url: string; end: number } | undefined {
  if (value[index] !== "[") return undefined;
  const labelEnd = value.indexOf("]", index + 1);
  if (labelEnd <= index + 1 || value[labelEnd + 1] !== "(") return undefined;
  const urlEnd = value.indexOf(")", labelEnd + 2);
  if (urlEnd <= labelEnd + 2) return undefined;

  const url = value.slice(labelEnd + 2, urlEnd);
  if (!/^https?:\/\/[^\s<>"()]+$/i.test(url)) return undefined;
  return { label: value.slice(index + 1, labelEnd), url, end: urlEnd + 1 };
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

export interface StatusView {
  workspaceName?: string;
  workspacePath?: string;
  running?: boolean;
  recentOutputAt?: number;
  recentError?: string;
  threadId?: string;
  threadName?: string;
  threadStatus?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: string;
  tokenUsage?: AgentTokenUsage;
  contextWindow?: number;
  waitingForUserInput?: boolean;
  waitingForApproval?: boolean;
  queuedTaskCount?: number;
  blockedTaskCount?: number;
  activeTaskId?: number;
  activeTaskStatus?: string;
}
