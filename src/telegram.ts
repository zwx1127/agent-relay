import type { ChatId, IMAdapter, InboundMessage } from "./types.ts";
import { splitForTelegram } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => Promise<Response>;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
}

export class TelegramAdapter implements IMAdapter {
  private offset = 0;
  private stopped = false;
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly logger: Logger = noopLogger,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  stop(): void {
    this.stopped = true;
    this.logger.info("telegram.polling_stop_requested");
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.logger.info("telegram.polling_started");
    await this.skipPendingUpdates();
    while (!this.stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.request<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message"],
        });
      } catch (error) {
        this.logger.error("telegram.polling_failed", { error: error instanceof Error ? error : new Error(String(error)) });
        throw error;
      }
      if (updates.length > 0) {
        this.logger.debug("telegram.updates_received", { count: updates.length, offset: this.offset });
      }
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const message = update.message;
        if (!message?.text || !message.from) {
          this.logger.debug("telegram.update_ignored", {
            update_id: update.update_id,
            has_message: Boolean(message),
            has_text: Boolean(message?.text),
            has_from: Boolean(message?.from),
          });
          continue;
        }
        this.logger.debug("telegram.message_received", {
          update_id: update.update_id,
          message_id: message.message_id,
          chat_id: message.chat.id,
          user_id: message.from.id,
          text_len: message.text.length,
          message_text: message.text,
        });
        await onMessage({
          id: String(message.message_id),
          chatId: message.chat.id,
          userId: message.from.id,
          text: message.text,
          date: message.date,
        });
      }
    }
    this.logger.info("telegram.polling_stopped");
  }

  private async skipPendingUpdates(): Promise<void> {
    const updates = await this.request<TelegramUpdate[]>("getUpdates", {
      offset: -1,
      timeout: 0,
      allowed_updates: ["message"],
    });
    const lastUpdate = updates.at(-1);
    if (!lastUpdate) return;

    this.offset = lastUpdate.update_id + 1;
    this.logger.info("telegram.pending_updates_skipped", { offset: this.offset });
  }

  async sendMessage(chatId: ChatId, text: string): Promise<void> {
    const chunks = splitForTelegram(text.length > 0 ? text : "(empty)");
    this.logger.debug("telegram.send_message_started", { chat_id: chatId, text_len: text.length, chunks: chunks.length });
    for (const chunk of chunks) {
      try {
        await this.request("sendMessage", {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        });
      } catch (error) {
        this.logger.error("telegram.send_message_failed", {
          chat_id: chatId,
          text_len: text.length,
          chunks: chunks.length,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    }
    this.logger.debug("telegram.send_message_completed", { chat_id: chatId, text_len: text.length, chunks: chunks.length });
  }

  private async request<T>(method: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      this.logger.error("telegram.api_http_error", { method, status: response.status });
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      this.logger.error("telegram.api_error", { method, description: payload.description || "unknown API error" });
      throw new Error(`Telegram ${method} failed: ${payload.description || "unknown API error"}`);
    }
    return payload.result as T;
  }
}
