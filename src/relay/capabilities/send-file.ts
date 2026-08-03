import { inputRecord, optionalInputString } from "./input.ts";

export const RELAY_CAPABILITY_SEND_FILE = "send_file";

export interface SendFileCapabilityRequest {
  path: string;
  cwd?: string;
  sessionKey?: string;
  caption?: string;
}

export function parseSendFileRequest(body: unknown): SendFileCapabilityRequest {
  const record = inputRecord(body);
  const path = typeof record?.path === "string" ? record.path.trim() : "";
  if (!path) throw new Error("path is required");
  const cwd = optionalInputString(record, "cwd");
  const sessionKey = optionalInputString(record, "sessionKey");
  const caption = optionalInputString(record, "caption");
  return {
    path,
    ...(cwd ? { cwd } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(caption ? { caption } : {}),
  };
}
