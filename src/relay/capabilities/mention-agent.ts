import { inputRecord, optionalInputString, requiredInputString } from "./input.ts";

export const RELAY_CAPABILITY_MENTION_AGENT = "mention_agent";

export interface MentionAgentCapabilityRequest {
  peerId: string;
  message: string;
  cwd?: string;
  sessionKey?: string;
}

export function parseMentionAgentRequest(body: unknown): MentionAgentCapabilityRequest {
  const record = inputRecord(body);
  const peerId = requiredInputString(record, "peerId");
  const message = requiredInputString(record, "message");
  const cwd = optionalInputString(record, "cwd");
  const sessionKey = optionalInputString(record, "sessionKey");
  return {
    peerId,
    message,
    ...(cwd ? { cwd } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}
