export const RELAY_CAPABILITY_MENTION_AGENT = "mention_agent";

export interface MentionAgentCapabilityRequest {
  peerId: string;
  message: string;
  cwd?: string;
  sessionKey?: string;
}

export function parseMentionAgentRequest(body: unknown): MentionAgentCapabilityRequest {
  const record = asRecord(body);
  const peerId = requiredString(record, "peerId");
  const message = requiredString(record, "message");
  const cwd = optionalString(record, "cwd");
  const sessionKey = optionalString(record, "sessionKey");
  return {
    peerId,
    message,
    ...(cwd ? { cwd } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function requiredString(record: Record<string, unknown> | undefined, key: string): string {
  const value = optionalString(record, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
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
