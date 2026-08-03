import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RelayPeerAgent } from "./config-types.ts";

export function normalizeTelegramUsername(value: string): string {
  const normalized = value.trim().replace(/^@+/, "");
  if (!normalized) throw new Error("TELEGRAM_BOT_USERNAME must not be empty");
  return normalized;
}

export function parsePeerAgentsFile(filePath: string | undefined): RelayPeerAgent[] {
  const trimmed = filePath?.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(trimmed), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`RELAY_PEER_AGENTS_FILE could not be read: ${detail}`);
  }
  if (!Array.isArray(parsed)) throw new Error("RELAY_PEER_AGENTS_FILE must contain a JSON array");
  const ids = new Set<string>();
  return parsed.map((item, index) => parsePeerAgent(item, index, ids));
}

function parsePeerAgent(value: unknown, index: number, ids: Set<string>): RelayPeerAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RELAY_PEER_AGENTS_FILE[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = requiredPeerString(record, "id", index);
  if (ids.has(id)) throw new Error(`RELAY_PEER_AGENTS_FILE contains duplicate id: ${id}`);
  ids.add(id);
  const peer: RelayPeerAgent = { id };
  const name = optionalPeerString(record, "name", index);
  const telegramUsername = optionalPeerString(record, "telegramUsername", index);
  const larkOpenId = optionalPeerString(record, "larkOpenId", index);
  const larkUserId = optionalPeerString(record, "larkUserId", index);
  if (name) peer.name = name;
  if (telegramUsername) peer.telegramUsername = normalizeTelegramUsername(telegramUsername);
  if (larkOpenId) peer.larkOpenId = larkOpenId;
  if (larkUserId) peer.larkUserId = larkUserId;
  if (!peer.telegramUsername && !peer.larkOpenId && !peer.larkUserId) {
    throw new Error(`RELAY_PEER_AGENTS_FILE[${index}] must define telegramUsername, larkOpenId, or larkUserId`);
  }
  return peer;
}

function requiredPeerString(record: Record<string, unknown>, key: string, index: number): string {
  const value = optionalPeerString(record, key, index);
  if (!value) throw new Error(`RELAY_PEER_AGENTS_FILE[${index}].${key} is required`);
  return value;
}

function optionalPeerString(record: Record<string, unknown>, key: string, index: number): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`RELAY_PEER_AGENTS_FILE[${index}].${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}
