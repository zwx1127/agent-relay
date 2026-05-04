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
