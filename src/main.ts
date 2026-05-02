import { loadConfig } from "./config.ts";
import { TelegramAdapter } from "./telegram.ts";
import { Store } from "./store.ts";
import { CodexDriver } from "./codex.ts";
import { MessageRouter } from "./router.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.sqlitePath);
  const telegram = new TelegramAdapter(config.telegramBotToken);
  let router: MessageRouter;
  const agent = new CodexDriver(
    { codexBin: config.codexBin, sandbox: config.codexSandbox, approval: config.codexApproval },
    (event) => router.handleAgentOutput(event),
    (event) => router.handleAgentExit(event.sessionKey, `Codex exited with code ${event.exitCode ?? "unknown"}${event.signalCode ? ` (${event.signalCode})` : ""}.`),
  );
  router = new MessageRouter({ config, store, adapter: telegram, agent });

  process.on("SIGINT", () => {
    telegram.stop();
    store.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    telegram.stop();
    store.close();
    process.exit(0);
  });

  console.log("agent-relay polling Telegram.");
  await telegram.start((message) => router.handle(message));
}

if (import.meta.main) {
  await main();
}
