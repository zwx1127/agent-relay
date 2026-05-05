export const RELAY_CAPABILITY_SEND_IMAGE = "send_image";

export interface SendImageCapabilityRequest {
  path: string;
  cwd?: string;
  sessionKey?: string;
  caption?: string;
}

export interface CapabilityResponse {
  ok: true;
  message: string;
  path?: string;
}

export type CapabilityHandler = (body: unknown) => Promise<CapabilityResponse>;

export interface CapabilityDefinition {
  name: string;
  handle: CapabilityHandler;
  helperCommand?: string;
  instructions?: string;
}

export class CapabilityRegistry {
  private readonly definitions: CapabilityDefinition[] = [];

  register(definition: CapabilityDefinition): void {
    if (this.definitions.some((existing) => existing.name === definition.name)) {
      throw new Error(`Capability already registered: ${definition.name}`);
    }
    this.definitions.push(definition);
  }

  list(): CapabilityDefinition[] {
    return [...this.definitions];
  }

  instructions(): string | undefined {
    const sections = this.definitions.map((definition) => definition.instructions).filter((section): section is string => Boolean(section?.trim()));
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }
}

export function parseSendImageRequest(body: unknown): SendImageCapabilityRequest {
  const record = asRecord(body);
  const path = typeof record?.path === "string" ? record.path.trim() : "";
  if (!path) throw new Error("path is required");
  const cwd = optionalString(record, "cwd");
  const sessionKey = optionalString(record, "sessionKey");
  const caption = optionalString(record, "caption");
  return {
    path,
    ...(cwd ? { cwd } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(caption ? { caption } : {}),
  };
}

function optionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
