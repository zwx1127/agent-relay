import { describe, expect, test } from "bun:test";
import {
  deliverLiveEvent,
  handleServerRequestResolved,
  isShareableServerRequest,
  routeServerRequestResponse,
  rebindPendingRequestParticipant,
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
      data: { id: "relay", connectedAt: 2, relayInstanceId: "relay-instance", queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
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
    expect(JSON.parse(peerMessages[1]!)).toEqual({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: shared.id, result: { decision: "accept" } },
    });
  });

  test("coalesces the same logical approval from multiple app-server connections", () => {
    const desktopBackendMessages: string[] = [];
    const relayBackendMessages: string[] = [];
    const desktopMessages: string[] = [];
    const relayMessages: string[] = [];
    const desktopBackend = { readyState: WebSocket.OPEN, send: (raw: string) => desktopBackendMessages.push(raw) } as unknown as WebSocket;
    const relayBackend = { readyState: WebSocket.OPEN, send: (raw: string) => relayBackendMessages.push(raw) } as unknown as WebSocket;
    const desktop = {
      data: { id: "desktop", connectedAt: 1, backend: desktopBackend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => desktopMessages.push(raw) },
    } as unknown as ConnectedClient;
    const relay = {
      data: { id: "relay", connectedAt: 2, relayInstanceId: "relay-instance", backend: relayBackend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => relayMessages.push(raw) },
    } as unknown as ConnectedClient;
    const clients = new Map([[desktop.data.id, desktop], [relay.data.id, relay]]);
    const pending = new Map<string, PendingServerRequest>();
    const relayed = new Map<string, string>();
    const first = {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "bun test" },
    };

    expect(shareServerRequest(desktop, first, desktopBackend, clients, pending, relayed)).toEqual({
      kind: "created",
      deliverToOrigin: true,
      conflict: false,
    });
    const relayRequest = JSON.parse(relayMessages[0]!) as { id: string; params: { command: string } };
    expect(relayRequest.params.command).toBe("bun test");

    expect(shareServerRequest(relay, {
      ...first,
      id: 19,
      params: { ...first.params, command: "changed command" },
    }, relayBackend, clients, pending, relayed)).toEqual({
      kind: "coalesced",
      deliverToOrigin: false,
      conflict: true,
    });
    expect(relayMessages).toHaveLength(1);

    expect(routeServerRequestResponse(relay.data, { id: relayRequest.id, result: { decision: "accept" } }, "", clients, pending, relayed)).toBe(true);
    expect(JSON.parse(desktopBackendMessages[0]!)).toEqual({ id: 7, result: { decision: "accept" } });
    expect(JSON.parse(relayBackendMessages[0]!)).toEqual({ id: 19, result: { decision: "accept" } });
    expect(JSON.parse(desktopMessages[0]!)).toEqual({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 7 } });
    expect(JSON.parse(relayMessages[1]!)).toEqual({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: relayRequest.id, result: { decision: "accept" } },
    });

    expect(shareServerRequest(relay, { ...first, id: 19 }, relayBackend, clients, pending, relayed)).toEqual({
      kind: "duplicate",
      deliverToOrigin: false,
      conflict: false,
    });
    expect(JSON.parse(relayBackendMessages[1]!)).toEqual({ id: 19, result: { decision: "accept" } });
    expect(relayMessages).toHaveLength(2);
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

  test("replays a resolved request to the same Relay instance after reconnect", () => {
    const backendMessages: string[] = [];
    const backend = { readyState: WebSocket.OPEN, send: (raw: string) => backendMessages.push(raw) } as unknown as WebSocket;
    const origin = {
      data: { id: "desktop", connectedAt: 1, backend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: () => undefined },
    } as unknown as ConnectedClient;
    const oldMessages: string[] = [];
    const oldRelay = {
      data: { id: "relay-old", connectedAt: 2, relayInstanceId: "relay-instance", queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => oldMessages.push(raw) },
    } as unknown as ConnectedClient;
    const clients = new Map([[origin.data.id, origin], [oldRelay.data.id, oldRelay]]);
    const pending = new Map<string, PendingServerRequest>();
    const relayed = new Map<string, string>();
    shareServerRequest(origin, { id: 9, method: "item/tool/requestUserInput", params: { threadId: "thread-1" } }, backend, clients, pending, relayed);
    const visibleRequestId = (JSON.parse(oldMessages[0]!) as { id: string }).id;
    clients.delete(oldRelay.data.id);
    routeServerRequestResponse(origin.data, { id: 9, result: { answers: {} } }, JSON.stringify({ id: 9, result: { answers: {} } }), clients, pending, relayed);

    const newMessages: string[] = [];
    const newRelay = {
      data: { id: "relay-new", connectedAt: 3, relayInstanceId: "relay-instance", queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: (raw: string) => newMessages.push(raw) },
    } as unknown as ConnectedClient;
    clients.set(newRelay.data.id, newRelay);
    rebindPendingRequestParticipant(newRelay, pending);

    expect(JSON.parse(newMessages[0]!)).toEqual({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: visibleRequestId, result: { answers: {} } },
    });
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
