import { TelegramTextBuilder, type RenderedTelegramText } from "./primitives.ts";

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

    if (value.startsWith("~~", index)) {
      const end = value.indexOf("~~", index + 2);
      if (end > index + 2) {
        const start = output.length;
        renderInlineMarkdown(output, value.slice(index + 2, end));
        output.entity({ type: "strikethrough", offset: start, length: output.length - start });
        index = end + 2;
        continue;
      }
    }

    if (value.startsWith("<u>", index)) {
      const end = value.indexOf("</u>", index + 3);
      if (end > index + 3) {
        const start = output.length;
        renderInlineMarkdown(output, value.slice(index + 3, end));
        output.entity({ type: "underline", offset: start, length: output.length - start });
        index = end + 4;
        continue;
      }
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
