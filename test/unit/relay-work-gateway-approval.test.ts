import { describe, expect, test } from "bun:test";
import {
  deliverLiveEvent,
  isShareableServerRequest,
  routeServerRequestResponse,
  shareServerRequest,
  type ConnectedClient,
  type PendingServerRequest,
} from "../../src/gateway/main.ts";

describe("experimental relay work Gateway approval arbitration", () => {
  test("routes the first response to the originating app-server and drops later responses", () => {
    const backendMessages: string[] = [];
    const peerMessages: string[] = [];
    const backend = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => {
        backendMessages.push(raw);
      },
    } as unknown as WebSocket;
    const origin = {
      data: { id: "desktop", connectedAt: 1, backend, queued: [], threads: new Set(["thread-1"]), deliveredSeq: new Map() },
      socket: { send: () => undefined },
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

    expect(routeServerRequestResponse(peer.data, { id: shared.id, result: { decision: "accept" } }, "", pending, relayed)).toBe(true);
    expect(JSON.parse(backendMessages[0]!)).toEqual({ id: 7, result: { decision: "accept" } });
    expect(routeServerRequestResponse(origin.data, { id: 7, result: { decision: "decline" } }, JSON.stringify({ id: 7, result: { decision: "decline" } }), pending, relayed)).toBe(true);
    expect(backendMessages).toHaveLength(1);
  });

  test("shares only approval and user-input server request methods", () => {
    expect(isShareableServerRequest("item/fileChange/requestApproval")).toBe(true);
    expect(isShareableServerRequest("item/tool/requestUserInput")).toBe(true);
    expect(isShareableServerRequest("mcpServer/elicitation/request")).toBe(true);
    expect(isShareableServerRequest("account/login/completed")).toBe(false);
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
});
