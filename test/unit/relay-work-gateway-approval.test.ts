import { describe, expect, test } from "bun:test";
import {
  deliverLiveEvent,
  handleServerRequestResolved,
  isShareableServerRequest,
  routeServerRequestResponse,
  shareServerRequest,
  updateClientFromBackend,
  updateClientFromRequest,
  type ConnectedClient,
  type PendingServerRequest,
} from "../../src/gateway/main.ts";

describe("experimental relay work Gateway approval arbitration", () => {
  test("routes the first response to the originating app-server and drops later responses", () => {
    const backendMessages: string[] = [];
    const originMessages: string[] = [];
    const peerMessages: string[] = [];
    const backend = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => {
        backendMessages.push(raw);
      },
    } as unknown as WebSocket;
    const origin = {
      data: { id: "desktop", connectedAt: 1, backend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => originMessages.push(raw) },
    } as unknown as ConnectedClient;
    const peer = {
      data: { id: "relay", connectedAt: 2, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => peerMessages.push(raw) },
    } as unknown as ConnectedClient;
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const pending = new Map<string, PendingServerRequest>();
    const relayed = new Map<string, string>();

    shareServerRequest(origin, {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    }, backend, clients, pending, relayed);
    const shared = JSON.parse(peerMessages[0]!) as { id: string };

    expect(routeServerRequestResponse(peer.data, { id: shared.id, result: { decision: "accept" } }, "", clients, pending, relayed)).toBe(true);
    expect(JSON.parse(backendMessages[0]!)).toEqual({ id: 7, result: { decision: "accept" } });
    expect(routeServerRequestResponse(origin.data, { id: 7, result: { decision: "decline" } }, JSON.stringify({ id: 7, result: { decision: "decline" } }), clients, pending, relayed)).toBe(true);
    expect(backendMessages).toHaveLength(1);
    expect(JSON.parse(originMessages[0]!)).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 7 } });
    expect(JSON.parse(peerMessages[1]!)).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: shared.id } });
  });

  test("shares only approval and user-input server request methods", () => {
    expect(isShareableServerRequest("item/fileChange/requestApproval")).toBe(true);
    expect(isShareableServerRequest("item/tool/requestUserInput")).toBe(true);
    expect(isShareableServerRequest("mcpServer/elicitation/request")).toBe(true);
    expect(isShareableServerRequest("account/login/completed")).toBe(false);
  });

  test("suppresses an upstream resolved notification after notifying every participant", () => {
    const backend = { readyState: WebSocket.OPEN, send: () => undefined } as unknown as WebSocket;
    const originMessages: string[] = [];
    const peerMessages: string[] = [];
    const origin = {
      data: { id: "desktop", connectedAt: 1, backend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => originMessages.push(raw) },
    } as unknown as ConnectedClient;
    const peer = {
      data: { id: "relay", connectedAt: 2, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => peerMessages.push(raw) },
    } as unknown as ConnectedClient;
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const pending = new Map<string, PendingServerRequest>();
    const relayed = new Map<string, string>();
    shareServerRequest(origin, { id: 8, method: "item/tool/requestUserInput", params: { threadId: "thread-1" } }, backend, clients, pending, relayed);
    const peerRequestId = (JSON.parse(peerMessages[0]!) as { id: string }).id;

    expect(handleServerRequestResolved(origin.data, {
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 8 },
    }, clients, pending)).toBe(true);
    expect(JSON.parse(originMessages[0]!)).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 8 } });
    expect(JSON.parse(peerMessages[1]!)).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: peerRequestId } });
  });

  test("fans out each sequenced thread event once to currently connected clients", () => {
    const desktopMessages: string[] = [];
    const relayMessages: string[] = [];
    const otherMessages: string[] = [];
    const makeClient = (id: string, name: string, threads: string[], output: string[]): ConnectedClient => ({
      data: { id, name, connectedAt: 1, queued: [], threads: new Set(threads), deliveredSeq: new Map() },
      socket: { send: (raw: string) => output.push(raw) },
    } as unknown as ConnectedClient);
    const desktop = makeClient("desktop", "codex-desktop", ["thread-1"], desktopMessages);
    const relay = makeClient("relay", "agent-relay", ["thread-1"], relayMessages);
    const other = makeClient("other", "codex-cli", ["thread-2"], otherMessages);
    const clients = new Map([[desktop.data.id, desktop], [relay.data.id, relay], [other.data.id, other]]);
    const message = { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } };
    const event = { seq: 3, threadId: "thread-1", method: "turn/started" };
    const raw = JSON.stringify(message);

    deliverLiveEvent(event, raw, desktop, clients);
    deliverLiveEvent(event, raw, relay, clients);

    expect(desktopMessages).toEqual([raw]);
    expect(otherMessages).toEqual([]);
    expect(relayMessages).toEqual([raw]);
  });

  test("keeps ephemeral fork events on the originating Gateway connection", () => {
    const originMessages: string[] = [];
    const peerMessages: string[] = [];
    const makeClient = (id: string, output: string[]): ConnectedClient => ({
      data: { id, connectedAt: 1, queued: [], threads: new Set(["parent"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => output.push(raw) },
    } as unknown as ConnectedClient);
    const origin = makeClient("relay-origin", originMessages);
    const peer = makeClient("codex-cli", peerMessages);
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);

    updateClientFromRequest(origin.data, {
      id: 20,
      method: "thread/fork",
      params: { threadId: "parent", ephemeral: true, excludeTurns: true },
    });
    updateClientFromBackend(origin.data, { id: 20, result: { thread: { id: "btw-child" } } });

    expect(origin.data.threads.has("btw-child")).toBe(true);
    expect(peer.data.threads.has("btw-child")).toBe(false);

    const raw = JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "btw-child", turnId: "btw-turn", delta: "private answer" },
    });
    deliverLiveEvent({ seq: 1, threadId: "btw-child", method: "item/agentMessage/delta" }, raw, origin, clients);

    expect(originMessages).toEqual([raw]);
    expect(peerMessages).toEqual([]);
  });

  test("tracks resume and unsubscribe only after their RPC outcomes", () => {
    const client = { id: "relay", connectedAt: 1, queued: [], threads: new Set<string>(), deliveredSeq: new Map() };
    updateClientFromRequest(client, { id: 1, method: "thread/resume", params: { threadId: "thread-1" } });
    expect(client.threads.has("thread-1")).toBe(true);
    updateClientFromBackend(client, { id: 1, error: { code: -1, message: "missing" } });
    expect(client.threads.has("thread-1")).toBe(false);

    updateClientFromRequest(client, { id: 2, method: "thread/resume", params: { threadId: "thread-1" } });
    updateClientFromBackend(client, { id: 2, result: { thread: { id: "thread-1" } } });
    expect(client.threads.has("thread-1")).toBe(true);
    updateClientFromRequest(client, { id: 3, method: "thread/unsubscribe", params: { threadId: "thread-1" } });
    expect(client.threads.has("thread-1")).toBe(true);
    updateClientFromBackend(client, { id: 3, result: { status: "unsubscribed" } });
    expect(client.threads.has("thread-1")).toBe(false);
  });
});
