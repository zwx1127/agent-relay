import { inputRecord, optionalInputString } from "./input.ts";

export const RELAY_CAPABILITY_SEND_IMAGE = "send_image";

export interface SendImageCapabilityRequest {
  path: string;
  cwd?: string;
  sessionKey?: string;
  caption?: string;
}

export function parseSendImageRequest(body: unknown): SendImageCapabilityRequest {
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
