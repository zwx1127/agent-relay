import type { AgentActivityCategory, AgentMcpElicitationSchema, AgentModelSummary, AgentNativeCommandSummary, AgentUserInputQuestion } from "../../../ports/agent.ts";
import { redactNativeDiagnostic } from "../native-redaction.ts";

export type JsonObject = Record<string, unknown>;
export const TESTED_CLAUDE_VERSION = "2.1.285";
export const MINIMUM_CLAUDE_VERSION = "2.1.280";

export function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
export function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
export function parseClaudeVersion(value: string): string | undefined { return value.match(/\b(\d+\.\d+\.\d+)\s+\(Claude Code\)/)?.[1]; }
export function isSupportedClaudeVersion(version: string): boolean {
  const parts = version.split(".").map(Number);
  // The SDK control wire format is version-tested, not a cross-major RPC contract.
  return parts[0] === 2 && (parts[1]! > 1 || parts[1] === 1 && parts[2]! >= 280);
}
export function isSessionId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

export function commandsFrom(value: unknown): AgentNativeCommandSummary[] {
  if (!Array.isArray(value)) return [];
  const commands = new Map<string, AgentNativeCommandSummary>();
  for (const raw of value) {
    const item = record(raw);
    const name = typeof raw === "string" ? raw : string(item?.name);
    if (!name || !/^[\w:.-]+$/.test(name)) continue;
    const description = string(item?.description) ?? "Native Claude command";
    const hint = string(item?.argumentHint);
    for (const command of [name, ...strings(item?.aliases)].filter((alias) => /^[\w:.-]+$/.test(alias))) {
      commands.set(command, { command, description: hint ? `${description} ${hint}` : description, availability: "supported" });
    }
  }
  return [...commands.values()];
}

export function modelsFrom(value: unknown): AgentModelSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    const id = string(item?.value);
    return id ? [{ id, model: string(item?.resolvedModel) ?? id, displayName: string(item?.displayName), description: string(item?.description), supportedReasoningEfforts: strings(item?.supportedEffortLevels) }] : [];
  });
}

export function questionsFrom(input: JsonObject): AgentUserInputQuestion[] {
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 4) throw new Error("Unsupported Claude question list.");
  const seen = new Set<string>();
  return input.questions.map((raw, index) => {
    const q = record(raw);
    const question = string(q?.question);
    if (!question || seen.has(question) || !Array.isArray(q?.options)) throw new Error("Invalid or duplicate Claude question.");
    seen.add(question);
    const options = q.options.map((rawOption) => {
      const option = record(rawOption);
      if (!string(option?.label)) throw new Error("Invalid Claude question option.");
      return { label: option!.label as string, description: string(option?.description) ?? "" };
    });
    return { id: `question-${index}`, header: string(q.header) ?? "Question", question, options, isOther: true, multiSelect: q.multiSelect === true };
  });
}

export function questionAnswer(input: JsonObject, result: unknown): JsonObject {
  const incoming = record(record(result)?.answers);
  if (!incoming) throw new Error("Claude question response must include answers.");
  const questions = questionsFrom(input);
  const answers: Record<string, string | string[]> = Object.create(null);
  for (const question of questions) {
    const raw = record(incoming[question.id])?.answers;
    if (!Array.isArray(raw) || !raw.length || raw.some((v) => typeof v !== "string" || !v.trim())) throw new Error(`Missing answer for ${question.id}.`);
    if (!question.multiSelect && raw.length !== 1) throw new Error("This Claude question permits one answer.");
    answers[question.question] = question.multiSelect ? [...new Set(raw as string[])] : raw[0] as string;
  }
  return { ...input, questions: input.questions, answers };
}

export function toolCategory(name: string): AgentActivityCategory {
  if (name === "Bash") return "command";
  if (["Edit", "Write", "NotebookEdit"].includes(name)) return "fileChange";
  if (name.startsWith("mcp__")) return "mcp";
  if (["WebSearch", "WebFetch"].includes(name)) return "webSearch";
  if (["Agent", "Task", "Skill"].includes(name)) return "collaboration";
  return "other";
}

export function toolDetail(input: JsonObject): string | undefined {
  // Do not dump arbitrary tool payloads (which can contain tokens) to logs/activity.
  return string(input.command) ?? string(input.file_path) ?? string(input.description) ?? string(input.query);
}

/** Restrict diagnostic output without exposing authentication URLs or credentials. */
export function safeMessage(value: unknown): string {
  return redactNativeDiagnostic(value, "Claude request failed.");
}

/** Only the primitive MCP form surface our shared UI can render is accepted. */
export function elicitationSchema(value: unknown): AgentMcpElicitationSchema | undefined {
  const schema = record(value), properties = record(schema?.properties);
  if (schema?.type !== "object" || !properties) return undefined;
  const structuralKeys = new Set(["type", "properties", "required", "title", "description", "$schema", "additionalProperties"]);
  if (Object.keys(schema).some((key) => !structuralKeys.has(key)) || schema.additionalProperties === true) return undefined;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)))) return undefined;
  const fieldKeys = new Set(["type", "title", "description", "default", "minLength", "maxLength", "minimum", "maximum", "format", "enum", "enumNames", "items", "minItems", "maxItems"]);
  for (const raw of Object.values(properties)) {
    const field = record(raw);
    if (!field || !["string", "number", "integer", "boolean", "array"].includes(String(field.type)) || Object.keys(field).some((key) => !fieldKeys.has(key))) return undefined;
    if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(String(field.format))) return undefined;
    if (field.enum !== undefined && !Array.isArray(field.enum)) return undefined;
    if (field.type === "array") {
      const items = record(field.items);
      if (!items || items.type !== "string" || !Array.isArray(items.enum) || items.enum.some((item) => typeof item !== "string") || Object.keys(items).some((key) => !["type", "enum"].includes(key))) return undefined;
    }
  }
  return schema as unknown as AgentMcpElicitationSchema;
}

export function validateElicitationContent(schema: AgentMcpElicitationSchema, value: unknown): JsonObject {
  const content = record(value);
  if (!content) throw new Error("Claude form response requires an object.");
  for (const key of schema.required ?? []) if (!Object.hasOwn(content, key)) throw new Error(`Missing required Claude form field: ${key}.`);
  for (const [key, value] of Object.entries(content)) {
    const field = schema.properties[key];
    if (!field) throw new Error(`Unknown Claude form field: ${key}.`);
    let valid = field.type === "array" ? Array.isArray(value) : field.type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === field.type;
    if (field.enum) valid &&= field.enum.includes(value);
    if (typeof value === "number") valid &&= Number.isFinite(value) && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
    if (typeof value === "string") {
      valid &&= (field.minLength === undefined || value.length >= field.minLength) && (field.maxLength === undefined || value.length <= field.maxLength);
      if (field.format === "email") valid &&= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      if (field.format === "uri") { try { new URL(value); } catch { valid = false; } }
      if (field.format === "date") valid &&= /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
      if (field.format === "date-time") valid &&= /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
    }
    if (Array.isArray(value)) valid &&= value.every((item) => typeof item === "string" && field.items?.enum?.includes(item)) && (field.minItems === undefined || value.length >= field.minItems) && (field.maxItems === undefined || value.length <= field.maxItems);
    if (!valid) throw new Error(`Invalid Claude form field: ${key}.`);
  }
  return content;
}
