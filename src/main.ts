import { loadConfig } from "./config.ts";
import { TelegramAdapter } from "./telegram.ts";
import { Store } from "./store.ts";
import { CodexDriver } from "./codex.ts";
import { MessageRouter } from "./router.ts";
import { TextLogger } from "./logger.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new TextLogger(config.logLevel);
  const store = new Store(config.sqlitePath, logger);
  const telegram = new TelegramAdapter(config.telegramBotToken, fetch, logger);
  let router: MessageRouter;
  const agent = new CodexDriver(
    { codexBin: config.codexBin, sandbox: config.codexSandbox, approval: config.codexApproval },
    (event) => router.handleAgentOutput(event),
    (event) => router.handleAgentExit(event.sessionKey, `Codex exited with code ${event.exitCode ?? "unknown"}${event.signalCode ? ` (${event.signalCode})` : ""}.`),
    logger,
  );
  router = new MessageRouter({ config, store, adapter: telegram, agent, logger });

  const shutdown = (signal: string): void => {
    logger.info("app.shutdown_requested", { signal });
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
    allowed_user_count: config.telegramAllowedUserIds.size,
    allowed_chat_count: config.telegramAllowedChatIds?.size ?? 0,
  });
  await telegram.start((message) => router.handle(message));
}

if (import.meta.main) {
  await main();
}
