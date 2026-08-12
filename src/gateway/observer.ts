import packageJson from "../../package.json" with { type: "json" };

type RpcId = number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * A private, read-only subscription that keeps Gateway's in-memory projection
 * current while all user-facing clients are disconnected.
 */
export class GatewayObserver {
  private readonly threads = new Set<string>();
  private readonly pending = new Map<RpcId, PendingRequest>();
  private socket?: WebSocket;
  private nextId = 1;
  private stopping = false;
  private reconnectTimer?: Timer;
  private ready?: Promise<void>;

  constructor(
    private readonly backendUrl: string,
    private readonly onMessage: (message: Record<string, unknown>) => void,
    private readonly onError: (error: Error) => void = () => undefined,
    private readonly onSnapshot: (threadId: string, value: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    await this.ensureConnected();
  }

  anchor(threadId: string): void {
    if (!threadId || this.threads.has(threadId)) return;
    this.threads.add(threadId);
    void this.ensureConnected()
      .then(() => this.resume(threadId))
      .catch((error) => this.onError(toError(error)));
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new Error("Gateway observer stopped."));
    this.socket?.close();
    this.socket = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.ready) return await this.ready;
    this.ready = this.connect().finally(() => {
      this.ready = undefined;
    });
    return await this.ready;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.backendUrl);
      let settled = false;
      const timeout = setTimeout(() => {
        socket.close();
        if (!settled) reject(new Error(`Timed out connecting Gateway observer to ${this.backendUrl}.`));
      }, 10_000);
      socket.addEventListener("open", () => {
        this.socket = socket;
        void this.initialize().then(async () => {
          settled = true;
          clearTimeout(timeout);
          resolve();
          await Promise.all([...this.threads].map((threadId) => this.resume(threadId)));
        }).catch((error) => {
          settled = true;
          clearTimeout(timeout);
          socket.close();
          reject(toError(error));
        });
      }, { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Gateway observer connection failed: ${this.backendUrl}`));
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending(new Error("Gateway observer connection closed."));
        if (!this.stopping) this.scheduleReconnect();
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "agent-relay-gateway-observer", title: "Agent Relay Gateway Observer", version: packageJson.version },
      capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    });
    this.notify("initialized");
  }

  private async resume(threadId: string): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const result = await this.request("thread/resume", {
      threadId,
      excludeTurns: true,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    this.onSnapshot(threadId, result);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Gateway observer is not connected."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
    }
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if ((typeof message.id === "number") && !("method" in message) && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    // Server requests intentionally remain with Codex. A later native/Relay
    // resume replays them; the observer never fabricates approval or input.
    if (typeof message.method === "string" && message.id === undefined) this.onMessage(message);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch((error) => this.onError(toError(error)));
    }, 250);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
