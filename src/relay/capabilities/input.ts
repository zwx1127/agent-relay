export function inputRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function optionalInputString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function requiredInputString(
  record: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = optionalInputString(record, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}
