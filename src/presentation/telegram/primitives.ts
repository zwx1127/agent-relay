import type { TextEntity } from "../../ports/im.ts";

export type TelegramMessageEntity = TextEntity;

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

export class TelegramTextBuilder {
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
