import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { SQLiteStore } from "../storage/sqlite-store.ts";
import { RelayController } from "../relay/controller.ts";
import { TextLogger } from "../domain/logger.ts";
import { CapabilityRegistry } from "../relay/capabilities/registry.ts";
import { parseSendImageRequest, RELAY_CAPABILITY_SEND_IMAGE } from "../relay/capabilities/send-image.ts";
import { relayCapabilityInstructions, sendImageCapabilityInstructions } from "../relay/control/skills.ts";
import { startControlServer, type RunningControlServer } from "../relay/control/server.ts";
import { createImAdapter } from "../providers/im/factory.ts";
import { createAgentDriver } from "../providers/agents/factory.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new TextLogger(config.logLevel);
  const store = new SQLiteStore(config.sqlitePath, logger);
  const imAdapter = createImAdapter(config, logger);
  let router: RelayController;
  let control: RunningControlServer | undefined;
  const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agent-relay-helper");
  const controlToken = randomBytes(32).toString("hex");
  const controlEnv: Record<string, string> = {};
  const capabilities = new CapabilityRegistry();
  capabilities.register({
    name: RELAY_CAPABILITY_SEND_IMAGE,
    helperCommand: "send-image",
    instructions: sendImageCapabilityInstructions(helperPath),
    handle: async (body) => {
      const result = await router.sendDebugImage(parseSendImageRequest(body));
      return { ok: true, message: "image sent", path: result.path };
    },
  });
  let controlInstructions: string | undefined;
  if (config.relayControlEnabled) {
    controlInstructions = relayCapabilityInstructions(helperPath, capabilities.instructions());
  }
  const agent = createAgentDriver(config, {
    controlEnv,
    controlInstructions,
    onOutput: (event) => router.handleAgentOutput(event),
    onExit: (event) => router.handleAgentExit(event.sessionKey, `Agent exited with code ${event.exitCode ?? "unknown"}${event.signalCode ? ` (${event.signalCode})` : ""}.`),
    logger,
  });
  router = new RelayController({ config, store, adapter: imAdapter, agent, logger });
  if (config.relayControlEnabled) {
    control = startControlServer({
      port: config.relayControlPort,
      token: controlToken,
      logger,
      capabilities: capabilities.list(),
    });
    controlEnv.AGENT_RELAY_CONTROL_URL = control.url;
    controlEnv.AGENT_RELAY_CONTROL_TOKEN = controlToken;
    controlEnv.AGENT_RELAY_HELPER = helperPath;
  }

  const shutdown = (signal: string): void => {
    logger.info("app.shutdown_requested", { signal });
    control?.stop();
    imAdapter.stop?.();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("app.started", {
    log_level: config.logLevel,
    im_provider: config.imProvider,
    agent_provider: config.agentProvider,
    workspace_root: config.workspaceRoot,
    sqlite_path: config.sqlitePath,
    codex_bin: config.codexBin,
    codex_sandbox: config.codexSandbox,
    codex_approval: config.codexApproval,
    telegram_poll_timeout_seconds: config.telegramPollTimeoutSeconds,
    telegram_request_retry_max_attempts: config.telegramRequestRetryMaxAttempts,
    telegram_retry_initial_delay_ms: config.telegramRetryInitialDelayMs,
    telegram_retry_max_delay_ms: config.telegramRetryMaxDelayMs,
    media_max_bytes: config.mediaMaxBytes,
    relay_control_enabled: config.relayControlEnabled,
    relay_control_port: config.relayControlPort,
    allowed_user_count: config.allowedUserIds.size,
    allowed_conversation_count: config.allowedConversationIds?.size ?? 0,
  });
  await imAdapter.start((message) => router.handle(message));
}
