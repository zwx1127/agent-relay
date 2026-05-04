import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { TelegramAdapter } from "./telegram/adapter.ts";
import { Store } from "./storage/store.ts";
import { CodexDriver } from "./codex/driver.ts";
import { MessageRouter } from "./router/message-router.ts";
import { TextLogger } from "./logger.ts";
import { parseSendImageRequest, RELAY_CAPABILITY_SEND_IMAGE } from "./capabilities.ts";
import { relayCapabilityInstructions } from "./control/skills.ts";
import { startControlServer, type RunningControlServer } from "./control/server.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new TextLogger(config.logLevel);
  const store = new Store(config.sqlitePath, logger);
  const telegram = new TelegramAdapter(config.telegramBotToken, fetch, logger, {
    pollTimeoutSeconds: config.telegramPollTimeoutSeconds,
    requestRetryMaxAttempts: config.telegramRequestRetryMaxAttempts,
    retryInitialDelayMs: config.telegramRetryInitialDelayMs,
    retryMaxDelayMs: config.telegramRetryMaxDelayMs,
  });
  let router: MessageRouter;
  let control: RunningControlServer | undefined;
  const helperPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-relay-helper");
  const controlToken = randomBytes(32).toString("hex");
  const controlEnv: Record<string, string> = {};
  let controlInstructions: string | undefined;
  if (config.relayControlEnabled) {
    controlInstructions = relayCapabilityInstructions(helperPath);
  }
  const agent = new CodexDriver(
    {
      codexBin: config.codexBin,
      sandbox: config.codexSandbox,
      approval: config.codexApproval,
      developerInstructions: [config.codexDeveloperInstructions, controlInstructions].filter(Boolean).join("\n\n") || undefined,
      baseInstructions: config.codexBaseInstructions,
      env: controlEnv,
    },
    (event) => router.handleAgentOutput(event),
    (event) => router.handleAgentExit(event.sessionKey, `Codex exited with code ${event.exitCode ?? "unknown"}${event.signalCode ? ` (${event.signalCode})` : ""}.`),
    logger,
  );
  router = new MessageRouter({ config, store, adapter: telegram, agent, logger });
  if (config.relayControlEnabled) {
    control = startControlServer({
      port: config.relayControlPort,
      token: controlToken,
      logger,
      capabilities: [{
        name: RELAY_CAPABILITY_SEND_IMAGE,
        handle: async (body) => {
          const result = await router.sendDebugImage(parseSendImageRequest(body));
          return { ok: true, message: "image sent", path: result.path };
        },
      }],
    });
    controlEnv.AGENT_RELAY_CONTROL_URL = control.url;
    controlEnv.AGENT_RELAY_CONTROL_TOKEN = controlToken;
    controlEnv.AGENT_RELAY_HELPER = helperPath;
  }

  const shutdown = (signal: string): void => {
    logger.info("app.shutdown_requested", { signal });
    control?.stop();
    telegram.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("app.started", {
    log_level: config.logLevel,
    workspace_root: config.workspaceRoot,
    sqlite_path: config.sqlitePath,
    codex_bin: config.codexBin,
    codex_sandbox: config.codexSandbox,
    codex_approval: config.codexApproval,
    telegram_poll_timeout_seconds: config.telegramPollTimeoutSeconds,
    telegram_request_retry_max_attempts: config.telegramRequestRetryMaxAttempts,
    telegram_retry_initial_delay_ms: config.telegramRetryInitialDelayMs,
    telegram_retry_max_delay_ms: config.telegramRetryMaxDelayMs,
    telegram_image_max_bytes: config.telegramImageMaxBytes,
    relay_control_enabled: config.relayControlEnabled,
    relay_control_port: config.relayControlPort,
    allowed_user_count: config.telegramAllowedUserIds.size,
    allowed_chat_count: config.telegramAllowedChatIds?.size ?? 0,
  });
  await telegram.start((message) => router.handle(message));
}

if (import.meta.main) {
  await main();
}
