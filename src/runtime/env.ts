import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "./config-types.ts";

export function loadDotEnvFile(path = ".env"): Env {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) return {};

  const env: Env = {};
  const text = readFileSync(resolvedPath, "utf8");
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex < 1) throw new Error(`${path}:${index + 1} is not a valid KEY=value entry`);

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${path}:${index + 1} contains an invalid environment key: ${key}`);
    }
    env[key] = parseDotEnvValue(normalized.slice(equalsIndex + 1).trim());
  }
  return env;
}

function parseDotEnvValue(value: string): string {
  if (!value) return "";
  const quote = value[0];
  if ((quote === `"` || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === `"` ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, `"`) : inner;
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

export function parseStringSet(value: string, name: string): Set<string> {
  const ids = new Set<string>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (part.length > 0) ids.add(part);
  }
  if (ids.size === 0) throw new Error(`${name} must contain at least one id`);
  return ids;
}

export function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parsePositiveIntegerEnv(env: Env, name: string, defaultValue: number): number {
  const rawEnvValue = env[name];
  if (rawEnvValue === undefined) return defaultValue;
  const rawValue = rawEnvValue.trim();
  if (!rawValue || !/^\d+$/.test(rawValue)) throw new Error(`${name} must be a positive integer`);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseNonNegativeIntegerEnv(env: Env, name: string, defaultValue: number): number {
  const rawEnvValue = env[name];
  if (rawEnvValue === undefined) return defaultValue;
  const rawValue = rawEnvValue.trim();
  if (!rawValue || !/^\d+$/.test(rawValue)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function parseBooleanEnv(env: Env, name: string, defaultValue: boolean): boolean {
  const rawEnvValue = env[name];
  if (rawEnvValue === undefined) return defaultValue;
  const rawValue = rawEnvValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(rawValue)) return true;
  if (["0", "false", "no", "off"].includes(rawValue)) return false;
  throw new Error(`${name} must be a boolean`);
}
