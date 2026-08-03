import { asPromptRecord } from "../ui/prompt-state.ts";

export function mcpEnumValues(schema: Record<string, unknown> | undefined): unknown[] | undefined {
  if (Array.isArray(schema?.enum)) return schema.enum;
  const items = asPromptRecord(schema?.items);
  return Array.isArray(items?.enum) ? items.enum : undefined;
}

export function mcpInputHint(schema: Record<string, unknown> | undefined): string | undefined {
  const type = typeof schema?.type === "string" ? schema.type : undefined;
  const values = mcpEnumValues(schema);
  if (type === "array" && values) return `Enter comma-separated values: ${values.join(", ")}`;
  if (values) return `Choose one of: ${values.join(", ")}`;
  if (type === "boolean") return "Choose true or false.";
  if (type === "integer") return "Enter a whole number.";
  if (type === "number") return "Enter a number.";
  if (typeof schema?.format === "string") return `Format: ${schema.format}.`;
  return undefined;
}

export function parseMcpFieldValue(text: string, schema: Record<string, unknown>, required: boolean): { value: unknown } | string {
  const trimmed = text.trim();
  if (!trimmed || (!required && trimmed.toLowerCase() === "skip")) {
    if (schema.default !== undefined) return { value: schema.default };
    return required ? "A value is required." : { value: undefined };
  }
  const type = typeof schema.type === "string" ? schema.type : "string";
  if (type === "number" || type === "integer") {
    const value = Number(trimmed);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) return type === "integer" ? "Enter a whole number." : "Enter a valid number.";
    if (typeof schema.minimum === "number" && value < schema.minimum) return `Value must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `Value must be at most ${schema.maximum}.`;
    return { value };
  }
  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(trimmed)) return { value: true };
    if (/^(false|no|0)$/i.test(trimmed)) return { value: false };
    return "Enter true or false.";
  }
  if (type === "array") {
    const values = trimmed.split(",").map((value) => value.trim()).filter(Boolean);
    const allowed = mcpEnumValues(schema);
    if (allowed && values.some((value) => !allowed.includes(value))) return `Allowed values: ${allowed.join(", ")}.`;
    if (typeof schema.minItems === "number" && values.length < schema.minItems) return `Select at least ${schema.minItems} values.`;
    if (typeof schema.maxItems === "number" && values.length > schema.maxItems) return `Select at most ${schema.maxItems} values.`;
    return { value: values };
  }
  if (typeof schema.minLength === "number" && trimmed.length < schema.minLength) return `Value must contain at least ${schema.minLength} characters.`;
  if (typeof schema.maxLength === "number" && trimmed.length > schema.maxLength) return `Value must contain at most ${schema.maxLength} characters.`;
  const allowed = mcpEnumValues(schema);
  if (allowed && !allowed.includes(trimmed)) return `Allowed values: ${allowed.join(", ")}.`;
  if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address.";
  if (schema.format === "uri") {
    try { new URL(trimmed); } catch { return "Enter a valid URI."; }
  }
  if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "Enter a date in YYYY-MM-DD format.";
  if (schema.format === "date-time" && Number.isNaN(Date.parse(trimmed))) return "Enter a valid date-time.";
  return { value: trimmed };
}
