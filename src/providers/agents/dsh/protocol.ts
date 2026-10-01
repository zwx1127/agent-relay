import { redactNativeDiagnostic } from "../native-redaction.ts";

/** Version-pinned DeepSeek Harness Web Remote protocol, not Codex JSON-RPC. */
export const VERIFIED_DSH_VERSION = "0.2.0-rc.2";
export const DSH_SOURCE_COMMIT = "639ed015397290b3745d163aafe02ffee4aa3f84";

export type RemoteMethod =
  | "session/create" | "session/list" | "session/prompt" | "session/cancel"
  | "session/page" | "session/attachment" | "session/projections" | "session/modelCatalog" | "session/selectModel"
  | "session/rename" | "session/fork" | "commands/list" | "commands/execute"
  | "$events/result" | "userQuestions/answer";
export type StreamMethod = "$events" | "session/follow";
export type JsonRecord = Record<string, unknown>;
export function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** Runtime diagnostics and Host failures must never disclose credential-bearing URLs. */
export function safeMessage(value: unknown): string {
  return redactNativeDiagnostic(value, "DeepSeek Harness request failed.");
}

export function textBlocks(value: unknown): string {
  return array(value).flatMap(block => {
    const part = record(block);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("");
}
export interface CommandDescriptor {
  name: string;
  description: string;
  definitionId?: string;
  input?: { hint: string; attachments?: boolean };
}
export function commandDescriptors(value: unknown): CommandDescriptor[] {
  if (!Array.isArray(value)) throw new Error("DSH command catalog is not an array.");
  return value.map(item => {
    const row = record(item);
    if (!row || typeof row.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(row.name) || typeof row.description !== "string") {
      throw new Error("DSH returned an invalid native command descriptor.");
    }
    const input = record(row.input);
    return { name: row.name, description: row.description,
      ...(typeof row.definitionId === "string" ? { definitionId: row.definitionId } : {}),
      ...(typeof input?.hint === "string" ? { input: { hint: input.hint, attachments: input.attachments === true } } : {}),
    };
  });
}
export function browserOnlyCommand(command: CommandDescriptor): boolean {
  return command.definitionId === "@deepseek-ai/dsh-session-log-export";
}
