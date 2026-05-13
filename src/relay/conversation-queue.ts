import type { ConversationId } from "../domain/ids.ts";

export class ConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(conversationId: ConversationId, task: () => Promise<T>): Promise<T> {
    const key = String(conversationId);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
