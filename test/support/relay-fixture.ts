import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageId } from "../../src/domain/ids.ts";
import { TextLogger, type LogLevel } from "../../src/domain/logger.ts";
import { RelayController } from "../../src/relay/controller.ts";
import type { AppConfig } from "../../src/runtime/config.ts";
import { SQLiteStore } from "../../src/storage/sqlite-store.ts";
import { FakeAgent, FakeImAdapter, sleep } from "./fakes.ts";

const TEST_STREAM_QUIET_MS = 5;
const fixtureDirs: string[] = [];
const fixtureStores: SQLiteStore[] = [];

export interface RelayFixture {
  router: RelayController;
  store: SQLiteStore;
  adapter: FakeImAdapter;
  agent: FakeAgent;
  root: string;
  logLines: string[];
}

export function relayFixture(logLevel: LogLevel = "info", configOverrides: Partial<AppConfig> = {}): RelayFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-controller-root-"));
  fixtureDirs.push(root);
  const store = new SQLiteStore(":memory:");
  fixtureStores.push(store);
  const adapter = new FakeImAdapter();
  const agent = new FakeAgent();
  const logLines: string[] = [];
  const logger = new TextLogger(logLevel, (line) => logLines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));
  const config = relayTestConfig(root, logLevel, configOverrides);
  const router = new RelayController({ config, store, adapter, agent, logger, streamTiming: { quietMs: TEST_STREAM_QUIET_MS } });
  return { router, store, adapter, agent, root, logLines };
}

export function relayTestConfig(root: string, logLevel: LogLevel = "info", configOverrides: Partial<AppConfig> = {}): AppConfig {
  return {
    imProvider: "telegram",
    agentProvider: "codex",
    telegramBotToken: "token",
    allowedUserIds: new Set(["7"]),
    mediaMaxBytes: 20 * 1024 * 1024,
    telegramPollTimeoutSeconds: 30,
    telegramRequestRetryMaxAttempts: 3,
    telegramRetryInitialDelayMs: 500,
    telegramRetryMaxDelayMs: 10000,
    larkDomain: "lark",
    larkCardActionDispatchDelayMs: 150,
    workspaceRoot: root,
    sqlitePath: ":memory:",
    codexBin: "codex",
    codexSandbox: "workspace-write",
    codexApproval: "on-request",
    relayPeerAgents: [],
    relayControlEnabled: false,
    relayControlPort: 0,
    experimentalRelayWorkEnabled: false,
    experimentalRelayGatewayPort: 18765,
    experimentalRelayGatewayStatePath: ".data/agent-relay-gateway.json",
    logLevel,
    ...configOverrides,
  };
}

export function cleanupRelayFixtures(): void {
  for (const store of fixtureStores.splice(0)) store.close();
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function sentPrompt(text: string, collaborationMode: "default" | "plan" = "default", explicit = false): {
  key: string;
  text: string;
  options: { collaborationMode: "default" | "plan"; collaborationModeExplicit?: true };
} {
  return { key: "codex:1:demo", text, options: { collaborationMode, ...(explicit ? { collaborationModeExplicit: true } : {}) } };
}

export async function waitForStreamFlush(): Promise<void> {
  await sleep(TEST_STREAM_QUIET_MS + 20);
}

export function textMessage(text: string, userId = 7, replyToMessageId?: number, conversationId = "1") {
  return { kind: "message" as const, id: "1", messageId: "1", conversationId, userId, text, replyToMessageId };
}

export function mediaMessage(caption?: string, userId = 7) {
  return {
    kind: "media" as const,
    id: "1",
    messageId: "1",
    conversationId: "1",
    userId,
    ...(caption ? { caption } : {}),
    photos: [
      { fileId: "photo-small", width: 10, height: 10, fileSize: 10 },
      { fileId: "photo-large", fileUniqueId: "unique-large", width: 100, height: 100, fileSize: 100 },
    ],
  };
}

export function fileMessage(caption?: string, userId = 7) {
  return {
    kind: "file" as const,
    id: "1",
    messageId: "1",
    conversationId: "1",
    userId,
    ...(caption ? { caption } : {}),
    file: { fileId: "file-doc", fileName: "file.txt", mimeType: "text/plain", fileSize: 5 },
  };
}

export function audioMessage(caption?: string, userId = 7) {
  return {
    kind: "audio" as const,
    id: "1",
    messageId: "1",
    conversationId: "1",
    userId,
    ...(caption ? { caption } : {}),
    audio: { fileId: "voice-1", fileName: "voice.ogg", mimeType: "audio/ogg", fileSize: 3 },
    durationSeconds: 2,
  };
}

export function callbackMessage(data: string, userId = 7, callbackQueryId = "cb1", messageId: MessageId = 42, conversationId = "1") {
  return { kind: "callback_query" as const, id: callbackQueryId, conversationId, userId, callbackQueryId, messageId, data };
}
