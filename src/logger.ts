export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFieldValue = string | number | boolean | null | undefined | Error;
export type LogFields = Record<string, LogFieldValue>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  isDebugEnabled(): boolean;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(value: string | undefined, name = "LOG_LEVEL"): LogLevel {
  const normalized = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  throw new Error(`${name} must be one of: debug, info, warn, error`);
}

export class TextLogger implements Logger {
  constructor(
    private readonly minLevel: LogLevel,
    private readonly write: (line: string) => void = (line) => console.log(line),
    private readonly now: () => Date = () => new Date(),
  ) {}

  debug(event: string, fields: LogFields = {}): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.log("error", event, fields);
  }

  isDebugEnabled(): boolean {
    return this.enabled("debug");
  }

  private log(level: LogLevel, event: string, fields: LogFields): void {
    if (!this.enabled(level)) return;
    const parts = [this.now().toISOString(), level.toUpperCase(), event];
    for (const [key, value] of Object.entries(fields)) {
      for (const [fieldKey, fieldValue] of this.expandField(key, value)) {
        if (fieldValue === undefined) continue;
        parts.push(`${fieldKey}=${formatValue(fieldValue)}`);
      }
    }
    this.write(parts.join(" "));
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private expandField(key: string, value: LogFieldValue): Array<[string, string | number | boolean | null | undefined]> {
    if (value instanceof Error) {
      return [
        [key, value.message],
        [`${key}_stack`, this.isDebugEnabled() ? value.stack : undefined],
      ];
    }
    return [[key, value]];
  }
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  isDebugEnabled: () => false,
};

function formatValue(value: string | number | boolean | null): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
