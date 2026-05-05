import type { AppConfig } from "../../runtime/config.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";
import type { MessagingAdapter } from "../../ports/messaging.ts";
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
