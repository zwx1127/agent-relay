import type { AppConfig } from "../app/config.ts";
import { noopLogger, type Logger } from "../core/logger.ts";
import type { MessagingAdapter } from "./types.ts";
import { TelegramAdapter } from "./telegram/adapter.ts";

export function createMessagingAdapter(config: AppConfig, logger: Logger = noopLogger): MessagingAdapter {
  switch (config.messagingProvider) {
    case "telegram":
      return new TelegramAdapter(config.telegramBotToken, fetch, logger, {
        pollTimeoutSeconds: config.telegramPollTimeoutSeconds,
        requestRetryMaxAttempts: config.telegramRequestRetryMaxAttempts,
        retryInitialDelayMs: config.telegramRetryInitialDelayMs,
        retryMaxDelayMs: config.telegramRetryMaxDelayMs,
      });
  }
}
