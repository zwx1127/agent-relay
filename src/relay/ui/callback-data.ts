import { createHash } from "node:crypto";
import { CALLBACK_LIMIT_BYTES } from "./constants.ts";

export function shortToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export function codexRequestKey(sessionKeyValue: string, requestId: string | number): string {
  return `${sessionKeyValue}:${String(requestId)}`;
}

export function workspaceCallbackData(name: string): string {
  const callbackData = `ar:uh:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

export function workspaceIntroCallbackData(name: string, pageIndex: number): string {
  const callbackData = `ar:wi:${pageIndex}:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace intro callback data is too long.");
  }
  return callbackData;
}

export function deleteWorkspaceCallbackData(name: string, confirmed: boolean): string {
  const callbackData = `ar:${confirmed ? "wd!" : "wd?"}:${workspaceCallbackToken(name)}`;
  if (new TextEncoder().encode(callbackData).length > CALLBACK_LIMIT_BYTES) {
    throw new Error("Workspace callback data is too long.");
  }
  return callbackData;
}

export function workspaceCallbackToken(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 16);
}

export function isConsolePayload(payload: string): boolean {
  return payload === "s"
    || payload === "w"
    || payload === "n"
    || payload === "status"
    || payload === "stop"
    || payload.startsWith("wl:")
    || payload.startsWith("wi:")
    || payload.startsWith("wd?:")
    || payload.startsWith("wd!:")
    || payload.startsWith("uh:");
}
