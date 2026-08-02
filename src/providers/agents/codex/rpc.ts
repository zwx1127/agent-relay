export interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification
  | { id: string | number; result?: unknown; error?: unknown };

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: Timer;
};

export class CodexRpcClient {
  private readonly pending = new Map<number | string, PendingRpc>();
  private nextRequestId = 1;

  constructor(
    private readonly write: (message: JsonRpcMessage, options?: { ensureWritable?: boolean }) => Promise<void>,
  ) {}

  request(method: string, params?: unknown, options: { ensureWritable?: boolean } = {}): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, method, timer });
      void this.write({ id, method, params }, { ensureWritable: options.ensureWritable }).catch((error) => {
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  respond(requestId: string | number, result: unknown): Promise<void> {
    return this.write({ id: requestId, result }, { ensureWritable: false });
  }

  notify(method: string, params?: unknown, options: { ensureWritable?: boolean } = {}): Promise<void> {
    return this.write({ method, ...(params === undefined ? {} : { params }) }, options);
  }

  rejectRequest(requestId: string | number, code: number, message: string): Promise<void> {
    return this.write({ id: requestId, error: { code, message } }, { ensureWritable: false });
  }

  handleResponse(message: JsonRpcResponse, onUnmatched: (id: string | number) => void): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      onUnmatched(message.id);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`Codex ${pending.method} failed: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
