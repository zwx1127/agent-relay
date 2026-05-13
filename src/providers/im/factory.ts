import type { AppConfig } from "../../runtime/config.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";
import type { ImAdapter } from "../../ports/im.ts";
import { LarkAdapter } from "./lark/adapter.ts";
import { TelegramAdapter } from "./telegram/adapter.ts";

export function createImAdapter(config: AppConfig, logger: Logger = noopLogger): ImAdapter {
  switch (config.imProvider) {
    case "telegram":
      if (!config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
      return new TelegramAdapter(config.telegramBotToken, fetch, logger, {
        pollTimeoutSeconds: config.telegramPollTimeoutSeconds,
        requestRetryMaxAttempts: config.telegramRequestRetryMaxAttempts,
        retryInitialDelayMs: config.telegramRetryInitialDelayMs,
        retryMaxDelayMs: config.telegramRetryMaxDelayMs,
      });
    case "lark":
      if (!config.larkAppId) throw new Error("LARK_APP_ID is required");
      if (!config.larkAppSecret) throw new Error("LARK_APP_SECRET is required");
      return LarkAdapter.create({
        appId: config.larkAppId,
        appSecret: config.larkAppSecret,
        domain: config.larkDomain,
        cardActionDispatchDelayMs: config.larkCardActionDispatchDelayMs,
        logger,
      });
  }
}
