import type { TextEntity } from "../../ports/im.ts";

export function renderLarkMarkdown(text: string, entities: TextEntity[] = []): string {
  if (text.length === 0) return "(empty)";

  const sorted = entities
    .filter((entity) => entity.length > 0 && entity.offset >= 0 && entity.offset < text.length)
    .map((entity) => ({ ...entity, length: Math.min(entity.length, text.length - entity.offset) }))
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  let cursor = 0;
  let output = "";
  for (const entity of sorted) {
    if (entity.offset < cursor) continue;
    output += escapeMarkdown(text.slice(cursor, entity.offset));
    output += renderEntity(text.slice(entity.offset, entity.offset + entity.length), entity);
    cursor = entity.offset + entity.length;
  }
  output += escapeMarkdown(text.slice(cursor));
  return output.length > 0 ? output : "(empty)";
}

function renderEntity(value: string, entity: TextEntity): string {
  switch (entity.type) {
    case "bold":
      return `**${escapeMarkdown(value)}**`;
    case "italic":
      return `*${escapeMarkdown(value)}*`;
    case "underline":
      return escapeMarkdown(value);
    case "strikethrough":
      return `~~${escapeMarkdown(value)}~~`;
    case "spoiler":
      return escapeMarkdown(value);
    case "code":
      return inlineCode(value);
    case "pre":
      return fencedCode(value, entity.language);
    case "text_link":
      return entity.url ? `[${escapeLinkLabel(value)}](${entity.url})` : escapeMarkdown(value);
    case "blockquote":
    case "expandable_blockquote":
      return value
        .split("\n")
        .map((line) => `> ${escapeMarkdown(line)}`)
        .join("\n");
  }
}

function inlineCode(value: string): string {
  if (!value.includes("`")) return `\`${value}\``;
  return `\`\`${value.replaceAll("``", "` `")}\`\``;
}

function fencedCode(value: string, language: string | undefined): string {
  const safeValue = value.replaceAll("```", "` ``");
  return `\`\`\`${language ?? ""}\n${safeValue}\n\`\`\``;
}

function escapeLinkLabel(value: string): string {
  return escapeMarkdown(value).replaceAll("[", "").replaceAll("]", "");
}

function escapeMarkdown(value: string): string {
  return value;
}
