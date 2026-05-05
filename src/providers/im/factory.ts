import type { AppConfig } from "../../runtime/config.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";
import type { ImAdapter } from "../../ports/im.ts";
import { TelegramAdapter } from "./telegram/adapter.ts";

export function createImAdapter(config: AppConfig, logger: Logger = noopLogger): ImAdapter {
  switch (config.imProvider) {
    case "telegram":
      return new TelegramAdapter(config.telegramBotToken, fetch, logger, {
        pollTimeoutSeconds: config.telegramPollTimeoutSeconds,
        requestRetryMaxAttempts: config.telegramRequestRetryMaxAttempts,
        retryInitialDelayMs: config.telegramRetryInitialDelayMs,
        retryMaxDelayMs: config.telegramRetryMaxDelayMs,
      });
  }
}
