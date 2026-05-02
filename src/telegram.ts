import type { ChatId, IMAdapter, InboundMessage } from "./types.ts";
import { splitForTelegram } from "./text.ts";

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
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  stop(): void {
    this.stopped = true;
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      const updates = await this.request<TelegramUpdate[]>("getUpdates", {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const message = update.message;
        if (!message?.text || !message.from) continue;
        await onMessage({
          id: String(message.message_id),
          chatId: message.chat.id,
          userId: message.from.id,
          text: message.text,
          date: message.date,
        });
      }
    }
  }

  async sendMessage(chatId: ChatId, text: string): Promise<void> {
    const chunks = splitForTelegram(text.length > 0 ? text : "(empty)");
    for (const chunk of chunks) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
  }

  private async request<T>(method: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      throw new Error(`Telegram ${method} failed: ${payload.description || "unknown API error"}`);
    }
    return payload.result as T;
  }
}
