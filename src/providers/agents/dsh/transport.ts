import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { nativeAgentSpawnCommand } from "../native-spawn.ts";
import { VERIFIED_DSH_VERSION, record, safeMessage, type RemoteMethod, type StreamMethod } from "./protocol.ts";

export interface DshTransportOptions {
  dshBin: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
interface Subscription {
  endpoint: StreamMethod;
  args: Record<string, unknown>;
  item: (value: unknown) => void;
  fail: (error: Error) => void;
}
/** Owns one loopback-only Web profile and its short-lived, in-memory browser session. */
export class DshWebTransport {
  private proc?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private origin?: string;
  private cookie?: string;
  private ready?: Promise<void>;
  private closing = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private readonly streams = new Map<string, Subscription>();
  private readonly requests = new Set<AbortController>();
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;

  constructor(
    private readonly options: DshTransportOptions,
    private readonly cwd: string,
    private readonly onConnectionLost: () => void,
    private readonly onExit: (code: number | null, signal: string | null) => void,
  ) { this.closed = new Promise(resolve => { this.resolveClosed = resolve; }); }

  start(): Promise<void> { return this.ready ??= this.launch(); }
  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    const env = { ...process.env, ...this.options.env };
    const command = nativeAgentSpawnCommand(this.options.dshBin, args, env);
    return spawn(command.command, command.args, {
      cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  }
  private async verifyVersion(): Promise<void> {
    const proc = this.spawn(["--version"]);
    let output = "";
    const timeout = this.options.startupTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("DSH version check timed out.")); }, timeout);
      proc.stdout.on("data", (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString(); });
      proc.stderr.resume();
      proc.once("error", () => { clearTimeout(timer); reject(new Error("Cannot launch DSH. Check DSH_BIN and the native CLI installation.")); });
      proc.once("close", code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error("DSH version check failed. Check the native CLI installation."));
        else resolve();
      });
    });
    const version = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s|$)/)?.[1];
    if (version !== VERIFIED_DSH_VERSION) throw new Error(`This DSH Web Remote adapter is verified for ${VERIFIED_DSH_VERSION} (developer preview). Install that version before connecting; unverified protocol versions are refused.`);
  }
  private async launch(): Promise<void> {
    try {
      await this.verifyVersion();
      if (this.closing) throw new Error("DSH transport has closed.");
      const proc = this.spawn(["--profile", "web", "--no-open", "--host", "127.0.0.1", "--port", "0"]);
      this.proc = proc;
      proc.stderr.resume(); // Never retain stderr: native diagnostics can contain secrets.
      proc.once("close", (code, signal) => {
        this.resolveClosed();
        this.closedTransport();
        this.onExit(code, signal);
      });
      const launchUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("DSH Web startup timed out.")); }, this.options.startupTimeoutMs ?? 30_000);
        const lines = createInterface({ input: proc.stdout });
        const cleanup = () => { clearTimeout(timer); lines.close(); proc.off("error", failed); proc.off("close", exited); };
        const failed = () => { cleanup(); reject(new Error("Cannot launch DSH Web. Check DSH_BIN and the native CLI installation.")); };
        const exited = () => { cleanup(); reject(new Error("DSH Web exited before becoming ready. Inspect the native CLI locally for configuration problems.")); };
        proc.once("error", failed);
        proc.once("close", exited);
        lines.on("line", line => {
          if (!line.startsWith("dsh web: http://")) return;
          const match = /^dsh web: (http:\/\/\S+)/.exec(line);
          if (!match?.[1]) return;
          try {
            const url = new URL(match[1]);
            if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || !url.searchParams.get("token") || url.username || url.password || url.hash) {
              throw new Error("DSH advertised a non-loopback or malformed launch URL.");
            }
            cleanup(); resolve(url.toString());
          } catch { cleanup(); reject(new Error("DSH advertised a non-loopback or malformed launch URL.")); }
        });
      });
      proc.stdout.resume();
      await this.authenticate(launchUrl);
      await this.connect();
    } catch (error) {
      await this.close();
      throw new Error(safeMessage(error));
    }
  }
  private async authenticate(launchUrl: string): Promise<void> {
    this.origin = new URL(launchUrl).origin;
    const response = await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000) });
    const location = response.headers.get("location");
    if (![302, 303, 307].includes(response.status) || location === null || new URL(location, this.origin).origin !== this.origin || new URL(location, this.origin).pathname !== "/") {
      throw new Error("DSH did not complete its loopback browser-session exchange.");
    }
    const cookies = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).filter((value): value is string => Boolean(value));
    if (cookies.length === 0) throw new Error("DSH did not issue a browser session.");
    this.cookie = cookies.join("; ");
    await response.body?.cancel();
  }
  private connect(): Promise<void> {
    if (this.closing || !this.origin || !this.cookie) return Promise.reject(new Error("DSH transport is closed."));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${this.origin!.replace(/^http:/, "ws:")}/api/remote.mux`, { headers: { Cookie: this.cookie!, Origin: this.origin! } });
      this.socket = socket;
      let opened = false;
      const timer = setTimeout(() => { socket.close(); reject(new Error("DSH event connection timed out.")); }, this.options.requestTimeoutMs ?? 30_000);
      socket.onopen = () => {
        clearTimeout(timer); opened = true; this.attempt = 0;
        for (const [streamId, subscription] of this.streams) this.openStream(streamId, subscription);
        resolve();
      };
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        let frame: Record<string, unknown> | undefined;
        try { frame = record(JSON.parse(String(event.data))); } catch { socket.close(); return; }
        const stream = typeof frame?.streamId === "string" ? this.streams.get(frame.streamId) : undefined;
        if (!stream) return;
        if (frame?.type === "item") stream.item(frame.value);
        else if (frame?.type === "error" || frame?.type === "end") {
          stream.fail(new Error(frame.type === "end" ? "DSH event stream ended." : safeMessage(record(frame.error)?.message)));
        } else socket.close();
      };
      socket.onerror = () => { clearTimeout(timer); if (!opened) reject(new Error("DSH event connection failed.")); };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!opened) reject(new Error("DSH event connection closed before readiness."));
        if (this.socket !== socket) return;
        this.socket = undefined;
        if (this.closing) return;
        this.onConnectionLost();
        this.scheduleReconnect();
      };
    });
  }
  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = Math.min(500 * 2 ** this.attempt++, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => { this.scheduleReconnect(); });
    }, delay);
  }
  subscribe(endpoint: StreamMethod, args: Record<string, unknown>, item: Subscription["item"], fail: Subscription["fail"]): () => void {
    if (this.closing) throw new Error("DSH transport is closed.");
    const id = randomUUID();
    const subscription = { endpoint, args, item, fail };
    this.streams.set(id, subscription);
    this.openStream(id, subscription);
    return () => {
      this.streams.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "cancel", streamId: id }));
    };
  }
  private openStream(streamId: string, stream: Subscription): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "open", streamId, endpoint: stream.endpoint, payload: { args: stream.args } }));
    }
  }
  async call(method: RemoteMethod, args: Record<string, unknown>, timeoutMs = this.options.requestTimeoutMs ?? 30_000, signal?: AbortSignal): Promise<unknown> {
    if (this.closing || !this.origin || !this.cookie) throw new Error("DSH transport is not connected.");
    const rpcId = randomUUID();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetch(`${this.origin}/api/${method}`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/json", Cookie: this.cookie, Origin: this.origin },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`DSH ${method} returned HTTP ${response.status}.`);
      const envelope = record(await response.json());
      const result = record(envelope?.result);
      if (envelope?.type !== "server-response" || envelope.rpcId !== rpcId || typeof result?.ok !== "boolean") throw new Error(`DSH ${method} returned an invalid response.`);
      if (!result.ok) throw new Error(`DSH ${method}: ${safeMessage(record(result.error)?.message)}`);
      return result.value;
    } catch (error) {
      // Never retry mutating calls: a lost response does not prove non-admission.
      throw new Error(controller.signal.aborted ? `DSH ${method} was interrupted or timed out; its outcome may be unknown.` : safeMessage(error));
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); this.requests.delete(controller); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closedTransport();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) { this.resolveClosed(); return; }
    proc.kill("SIGTERM");
    let kill: ReturnType<typeof setTimeout> | undefined;
    try {
      kill = setTimeout(() => { proc.kill("SIGKILL"); }, this.options.shutdownTimeoutMs ?? 6_000);
      await this.closed;
    } finally { if (kill) clearTimeout(kill); }
  }
  private closedTransport(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const controller of this.requests) controller.abort();
    this.streams.clear();
    this.socket?.close(); this.socket = undefined;
    this.cookie = undefined; this.origin = undefined;
  }
}
