import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { loadDotEnvFile, parseBooleanEnv, parsePositiveIntegerEnv } from "../runtime/env.ts";
import { codexAppServerWebSocketSpawnCommand } from "../providers/agents/codex/spawn.ts";
import { GatewayLiveEventSequencer, messageThreadId, type GatewayLiveEvent } from "./live-events.ts";
import { gatewayLogPath, isProcessAlive, readGatewayState, resolveGatewayStatePath, RELAY_GATEWAY_PROTOCOL_VERSION, type RelayGatewayState } from "./state.ts";
import { defaultGatewayStatePath } from "./control.ts";
import { GatewayRelayControl } from "./relay-control.ts";
import { GatewayObserver } from "./observer.ts";

interface GatewayRuntimeConfig {
  codexBin: string;
  port: number;
  statePath: string;
  logPath: string;
}

export interface GatewayClientData {
  id: string;
  connectedAt: number;
  name?: string;
  backend?: WebSocket;
  queued: string[];
  threads: Set<string>;
  deliveredSeq: Map<string, number>;
  relayControlVersion?: number;
  relayInstanceId?: string;
  relayControlAcks?: Map<string, number>;
  pendingThreadRequests?: Map<string, PendingThreadRequest>;
}

export interface PendingThreadRequest {
  method: "thread/start" | "thread/resume" | "thread/fork" | "thread/unsubscribe";
  threadId?: string;
  wasSubscribed?: boolean;
}

export interface ConnectedClient {
  data: GatewayClientData;
  socket: ServerWebSocket<GatewayClientData>;
}

export interface PendingServerRequest {
  key: string;
  originClientId: string;
  originBackend: WebSocket;
  originalId: string | number;
  threadId?: string;
  resolved: boolean;
  resolvedNotified: boolean;
  participants: Map<string, string | number>;
}

async function main(): Promise<void> {
  const env = { ...loadDotEnvFile(), ...process.env };
  if (!parseBooleanEnv(env, "EXPERIMENTAL_RELAY_WORK_ENABLED", false)) {
    throw new Error("Experimental relay work is disabled. Set EXPERIMENTAL_RELAY_WORK_ENABLED=true explicitly.");
  }
  const statePath = resolveGatewayStatePath(env.EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH?.trim() || defaultGatewayStatePath());
  const port = parsePositiveIntegerEnv(env, "EXPERIMENTAL_RELAY_GATEWAY_PORT", 18765);
  if (port > 65534) throw new Error("EXPERIMENTAL_RELAY_GATEWAY_PORT must be at most 65534.");
  const config: GatewayRuntimeConfig = {
    codexBin: env.CODEX_BIN?.trim() || "codex",
    port,
    statePath,
    logPath: gatewayLogPath(statePath),
  };
  mkdirSync(dirname(config.statePath), { recursive: true });
  const existing = readGatewayState(config.statePath);
  if (existing) {
    const gatewayAlive = isProcessAlive(existing.pid);
    const appServerAlive = isProcessAlive(existing.appServerPid);
    if (gatewayAlive && appServerAlive) return;
    if (gatewayAlive && !appServerAlive) {
      throw new Error(`Experimental relay Gateway state is inconsistent: Gateway pid ${existing.pid} is alive but app-server pid ${existing.appServerPid} is not.`);
    }
    if (appServerAlive) {
      try {
        process.kill(existing.appServerPid, "SIGTERM");
      } catch {
        // The orphan may have exited between the liveness check and termination.
      }
      await waitForProcessExit(existing.appServerPid, 5_000);
      if (isProcessAlive(existing.appServerPid)) {
        throw new Error(`Orphaned Codex app-server pid ${existing.appServerPid} did not exit; refusing to start a split failure domain.`);
      }
    }
  }
  if (existsSync(config.statePath)) unlinkSync(config.statePath);

  const lockPath = `${config.statePath}.lock`;
  acquireLock(lockPath);
  let child: ChildProcess | undefined;
  let frontendServer: ReturnType<typeof Bun.serve<GatewayClientData>> | undefined;
  let observer: GatewayObserver | undefined;
  let stopping = false;
  const clients = new Map<string, ConnectedClient>();
  const pendingRequests = new Map<string, PendingServerRequest>();
  const relayedRequestIds = new Map<string, string>();
  const liveEvents = new GatewayLiveEventSequencer();
  const relayControl = new GatewayRelayControl(() => clients.values(), (threadId) => observer?.anchor(threadId));
  const startedAt = Date.now();
  const cleanup = (): void => {
    const state = readGatewayState(config.statePath);
    if (state?.pid === process.pid) unlinkSync(config.statePath);
    if (existsSync(lockPath)) {
      try {
        if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) unlinkSync(lockPath);
      } catch {
        // Another process may have already cleaned a stale lock.
      }
    }
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log(config.logPath, "gateway stopping", { signal, pid: process.pid, appServerPid: child?.pid });
    frontendServer?.stop(true);
    observer?.stop();
    for (const client of clients.values()) client.data.backend?.close();
    child?.kill(signal);
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("exit", () => {
    if (child && !child.killed) child.kill();
    cleanup();
  });

  const backendUrl = `ws://127.0.0.1:${config.port + 1}`;
  const command = codexAppServerWebSocketSpawnCommand(config.codexBin, backendUrl, env);
  child = spawn(command.command, command.args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(command.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
  });
  child.stdout?.on("data", (chunk) => logRaw(config.logPath, "app-server stdout", String(chunk)));
  child.stderr?.on("data", (chunk) => logRaw(config.logPath, "app-server stderr", String(chunk)));
  child.on("error", (error) => log(config.logPath, "app-server spawn error", { error: error.message }));
  child.on("exit", (code, signal) => {
    log(config.logPath, "app-server exited", { code, signal });
    cleanup();
    if (!stopping) process.exit(code ?? 1);
  });
  if (!child.pid) throw new Error("Codex app-server did not provide a process id.");
  const watchdog = spawn(process.execPath, [resolve("src/gateway/child-watchdog.ts"), String(process.pid), String(child.pid)], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  watchdog.unref();
  await waitForPort(config.port + 1, 15_000);
  observer = new GatewayObserver(
    backendUrl,
    (message) => relayControl.handleObserver(message),
    (error) => log(config.logPath, "gateway observer error", { error: error.message }),
  );
  await observer.start();

  const handleFrontendMessage = (client: ConnectedClient, raw: string): void => {
    const message = parseMessage(raw);
    let forwardedRaw = raw;
    if (message) {
      const control = relayControl.handleFrontend(client, message);
      if (control.handled) return;
      const forwarded = control.message ?? message;
      forwardedRaw = forwarded === message ? raw : JSON.stringify(forwarded);
      updateClientFromRequest(client.data, forwarded);
      if (isRpcResponse(forwarded) && routeServerRequestResponse(client.data, forwarded, forwardedRaw, clients, pendingRequests, relayedRequestIds)) return;
    }
    const backend = client.data.backend;
    if (backend?.readyState === WebSocket.OPEN) backend.send(forwardedRaw);
    else {
      client.data.queued.push(forwardedRaw);
      if (client.data.queued.length > 1_000) client.socket.close(1013, "Gateway backend queue exceeded");
    }
  };

  const connectBackend = (client: ConnectedClient): void => {
    const backend = new WebSocket(backendUrl);
    client.data.backend = backend;
    backend.addEventListener("open", () => {
      for (const raw of client.data.queued.splice(0)) backend.send(raw);
    });
    backend.addEventListener("message", (event) => {
      const frontendConnected = clients.has(client.data.id);
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      const message = parseMessage(raw);
      if (message) {
        updateClientFromBackend(client.data, message);
        relayControl.handleBackend(client, message);
      }
      if (!message) {
        if (frontendConnected) client.socket.send(raw);
        return;
      }
      if (handleServerRequestResolved(client.data, message, clients, pendingRequests)) return;
      const liveEvent = liveEvents.sequence(client.data.id, message);
      if (liveEvent) deliverLiveEvent(liveEvent, raw, client, clients);
      else if (frontendConnected) client.socket.send(raw);
      if (isServerRequest(message) && isShareableServerRequest(message.method)) {
        shareServerRequest(client, message, backend, clients, pendingRequests, relayedRequestIds);
      }
      if (isRpcResponse(message)) {
        const responseThreadId = messageThreadId(message);
        if (responseThreadId) {
          observer?.anchor(responseThreadId);
          if (frontendConnected) relayControl.sendSnapshot(client, responseThreadId);
        }
      }
    });
    backend.addEventListener("error", () => {
      if (clients.has(client.data.id)) client.socket.close(1011, "Codex app-server connection failed");
    });
    backend.addEventListener("close", () => {
      if (clients.has(client.data.id)) client.socket.close(1011, "Codex app-server connection closed");
    });
  };

  frontendServer = Bun.serve<GatewayClientData>({
    hostname: "127.0.0.1",
    port: config.port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/readyz" || url.pathname === "/healthz") return Response.json({ ok: true, experimental: true });
      if (url.pathname === "/v1/clients") {
        return Response.json({
          clients: [...clients.values()].map(({ data }) => ({
            id: data.id,
            name: data.name,
            connectedAt: data.connectedAt,
            threads: [...data.threads],
          })),
        });
      }
      const data: GatewayClientData = {
        id: randomUUID(),
        connectedAt: Date.now(),
        queued: [],
        threads: new Set(),
        deliveredSeq: new Map(),
        pendingThreadRequests: new Map(),
      };
      if (server.upgrade(request, { data })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        const client = { data: socket.data, socket };
        clients.set(socket.data.id, client);
        log(config.logPath, "gateway client connected", { clientId: socket.data.id });
        connectBackend(client);
      },
      message(socket, data) {
        handleFrontendMessage(clients.get(socket.data.id) ?? { data: socket.data, socket }, String(data));
      },
      close(socket) {
        clients.delete(socket.data.id);
        const keepBackendForResponse = relayControl.clientDisconnected(socket.data.id);
        if (keepBackendForResponse) {
          setTimeout(() => {
            socket.data.backend?.close();
            relayControl.clientBackendClosed(socket.data.id);
          }, 10_000).unref();
        } else {
          socket.data.backend?.close();
          relayControl.clientBackendClosed(socket.data.id);
        }
        for (const [key, pending] of pendingRequests) {
          if (pending.originClientId !== socket.data.id) continue;
          pending.resolved = true;
          notifyServerRequestResolved(pending, clients);
          removePendingRequest(key, pendingRequests, relayedRequestIds);
        }
        log(config.logPath, "gateway client disconnected", { clientId: socket.data.id });
      },
    },
  });

  const url = `ws://127.0.0.1:${config.port}`;
  const state: RelayGatewayState = {
    experimental: true,
    protocolVersion: RELAY_GATEWAY_PROTOCOL_VERSION,
    pid: process.pid,
    appServerPid: child.pid,
    url,
    startedAt,
  };
  writeJsonAtomic(config.statePath, state);
  log(config.logPath, "experimental relay Gateway ready", state);
  await new Promise<void>(() => undefined);
}

export function deliverLiveEvent(
  event: GatewayLiveEvent,
  raw: string,
  origin: ConnectedClient,
  clients: Map<string, ConnectedClient>,
): void {
  for (const client of clients.values()) {
    if (client.data.id !== origin.data.id && !client.data.threads.has(event.threadId)) continue;
    if ((client.data.deliveredSeq.get(event.threadId) ?? 0) >= event.seq) continue;
    client.data.deliveredSeq.set(event.threadId, event.seq);
    client.socket.send(raw);
  }
}

export function updateClientFromRequest(client: GatewayClientData, message: Record<string, unknown>): void {
  if (message.method === "initialize") {
    const clientInfo = asRecord(asRecord(message.params)?.clientInfo);
    if (typeof clientInfo?.name === "string") client.name = clientInfo.name;
  }
  if (!isServerRequest(message)) return;
  const method = message.method;
  if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/fork" && method !== "thread/unsubscribe") return;
  const threadId = messageThreadId(message);
  const pending = client.pendingThreadRequests ??= new Map();
  pending.set(rpcIdKey(message.id), {
    method,
    ...(threadId ? { threadId } : {}),
    ...(method === "thread/resume" && threadId ? { wasSubscribed: client.threads.has(threadId) } : {}),
  });
  // A resuming connection must receive events emitted before the RPC response.
  // Roll this optimistic subscription back if app-server rejects the resume.
  if (method === "thread/resume" && threadId) client.threads.add(threadId);
}

export function updateClientFromBackend(client: GatewayClientData, message: Record<string, unknown>): void {
  if (isRpcResponse(message)) {
    const pending = client.pendingThreadRequests?.get(rpcIdKey(message.id));
    if (pending) {
      client.pendingThreadRequests?.delete(rpcIdKey(message.id));
      if ("error" in message) {
        if (pending.method === "thread/resume" && pending.threadId && !pending.wasSubscribed) client.threads.delete(pending.threadId);
        return;
      }
      if (pending.method === "thread/unsubscribe") {
        if (pending.threadId) client.threads.delete(pending.threadId);
        return;
      }
      const responseThreadId = messageThreadId(message) ?? pending.threadId;
      if (responseThreadId) client.threads.add(responseThreadId);
      return;
    }
    return;
  }
  const threadId = messageThreadId(message);
  if (threadId) client.threads.add(threadId);
}

export function shareServerRequest(
  origin: ConnectedClient,
  message: Record<string, unknown> & { id: string | number; method: string },
  originBackend: WebSocket,
  clients: Map<string, ConnectedClient>,
  pendingRequests: Map<string, PendingServerRequest>,
  relayedRequestIds: Map<string, string>,
): void {
  const threadId = messageThreadId(message);
  const key = requestKey(origin.data.id, message.id);
  const pending: PendingServerRequest = {
    key,
    originClientId: origin.data.id,
    originBackend,
    originalId: message.id,
    threadId,
    resolved: false,
    resolvedNotified: false,
    participants: new Map([[origin.data.id, message.id]]),
  };
  pendingRequests.set(key, pending);
  setTimeout(() => {
    const active = pendingRequests.get(key);
    if (!active || active.resolved) return;
    active.resolved = true;
    notifyServerRequestResolved(active, clients);
    setTimeout(() => removePendingRequest(key, pendingRequests, relayedRequestIds), 5 * 60_000).unref();
  }, 5 * 60_000).unref();
  for (const peer of clients.values()) {
    if (peer.data.id === origin.data.id || (threadId && !peer.data.threads.has(threadId))) continue;
    const relayId = `agent-relay:${randomUUID()}`;
    pending.participants.set(peer.data.id, relayId);
    relayedRequestIds.set(relayId, key);
    peer.socket.send(JSON.stringify({ ...message, id: relayId }));
  }
}

export function routeServerRequestResponse(
  client: GatewayClientData,
  message: Record<string, unknown> & { id: string | number },
  raw: string,
  clients: Map<string, ConnectedClient>,
  pendingRequests: Map<string, PendingServerRequest>,
  relayedRequestIds: Map<string, string>,
): boolean {
  const id = String(message.id);
  const relayedKey = relayedRequestIds.get(id);
  const ownKey = requestKey(client.id, message.id);
  const pending = relayedKey ? pendingRequests.get(relayedKey) : pendingRequests.get(ownKey);
  if (!pending) return false;
  if (!pending.resolved && pending.originBackend.readyState === WebSocket.OPEN) {
    const response = relayedKey ? { ...message, id: pending.originalId } : JSON.parse(raw) as Record<string, unknown>;
    pending.originBackend.send(JSON.stringify(response));
    pending.resolved = true;
    notifyServerRequestResolved(pending, clients);
    setTimeout(() => removePendingRequest(pending.key, pendingRequests, relayedRequestIds), 5 * 60_000).unref();
  }
  return true;
}

export function handleServerRequestResolved(
  client: GatewayClientData,
  message: Record<string, unknown>,
  clients: Map<string, ConnectedClient>,
  pendingRequests: Map<string, PendingServerRequest>,
): boolean {
  if (message.method !== "serverRequest/resolved") return false;
  const params = asRecord(message.params);
  const requestId = params?.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") return false;
  const direct = pendingRequests.get(requestKey(client.id, requestId));
  const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const pending = direct ?? [...pendingRequests.values()].find((candidate) => (
    candidate.originalId === requestId && (!threadId || candidate.threadId === threadId)
  ));
  if (!pending) return false;
  pending.resolved = true;
  notifyServerRequestResolved(pending, clients);
  return true;
}

function notifyServerRequestResolved(
  pending: PendingServerRequest,
  clients: Map<string, ConnectedClient>,
): void {
  if (pending.resolvedNotified) return;
  pending.resolvedNotified = true;
  for (const [clientId, visibleRequestId] of pending.participants) {
    const client = clients.get(clientId);
    if (!client) continue;
    client.socket.send(JSON.stringify({
      method: "serverRequest/resolved",
      params: {
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
        requestId: visibleRequestId,
      },
    }));
  }
}

function removePendingRequest(
  key: string,
  pendingRequests: Map<string, PendingServerRequest>,
  relayedRequestIds: Map<string, string>,
): void {
  const pending = pendingRequests.get(key);
  if (!pending) return;
  pendingRequests.delete(key);
  for (const requestId of pending.participants.values()) {
    if (typeof requestId === "string" && requestId.startsWith("agent-relay:")) relayedRequestIds.delete(requestId);
  }
}

export function isShareableServerRequest(method: string): boolean {
  return method.includes("requestApproval")
    || method.includes("requestUserInput")
    || method === "mcpServer/elicitation/request";
}

function isServerRequest(message: Record<string, unknown>): message is Record<string, unknown> & { id: string | number; method: string } {
  return (typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string";
}

function isRpcResponse(message: Record<string, unknown>): message is Record<string, unknown> & { id: string | number } {
  return (typeof message.id === "string" || typeof message.id === "number")
    && !("method" in message)
    && ("result" in message || "error" in message);
}

function requestKey(clientId: string, id: string | number): string {
  return `${clientId}:${rpcIdKey(id)}`;
}

function rpcIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function parseMessage(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function acquireLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch {
    const existingPid = readLockPid(lockPath);
    if (existingPid && isProcessAlive(existingPid)) {
      throw new Error(`Experimental relay Gateway is already starting (pid ${existingPid}).`);
    }
    if (existsSync(lockPath)) unlinkSync(lockPath);
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  }
}

function readLockPid(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const attempt = (): void => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let finished = false;
      socket.setTimeout(500);
      socket.once("connect", () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolveWait();
      });
      const retry = (): void => {
        if (finished) return;
        finished = true;
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for Codex app-server on 127.0.0.1:${port}.`));
        else setTimeout(attempt, 100);
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
}

function log(path: string, message: string, fields: object): void {
  appendFileSync(path, `${new Date().toISOString()} ${message} ${JSON.stringify(fields)}\n`);
}

function logRaw(path: string, source: string, value: string): void {
  for (const line of value.split(/\r?\n/)) {
    if (line.trim()) appendFileSync(path, `${new Date().toISOString()} ${source}: ${line}\n`);
  }
}

if (import.meta.main) {
  void main().catch((error) => {
    const statePath = resolveGatewayStatePath(process.env.EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH?.trim() || defaultGatewayStatePath());
    const logPath = gatewayLogPath(statePath);
    mkdirSync(dirname(resolve(logPath)), { recursive: true });
    log(logPath, "gateway failed", { error: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
