import { describe, expect, test } from "bun:test";
import {
  GatewayRelayControl,
  RELAY_CONTROL_COMMAND_METHOD,
  RELAY_CONTROL_ACK_METHOD,
  RELAY_CONTROL_HELLO_METHOD,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
  RELAY_CONTROL_PLAN_DECISION_METHOD,
  RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD,
  RELAY_CONTROL_RESYNC_METHOD,
  RELAY_CONTROL_SNAPSHOT_METHOD,
  RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
  type RelayControlClient,
} from "../../src/gateway/relay-control.ts";

interface TestClient extends RelayControlClient {
  sent: Array<Record<string, unknown>>;
}

function client(id: string, name: string, threads: string[] = []): TestClient {
  const sent: Array<Record<string, unknown>> = [];
  return {
    data: { id, name, threads: new Set(threads) },
    sent,
    socket: { send: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>) },
  };
}

function hello(control: GatewayRelayControl, target: TestClient, id = 1): void {
  control.handleFrontend(target, {
    id,
    method: RELAY_CONTROL_HELLO_METHOD,
    params: { version: RELAY_CONTROL_PROTOCOL_VERSION, instanceId: `instance-${target.data.id}` },
  });
  target.sent.length = 0;
}

function notifications(target: TestClient, method: string): Array<Record<string, unknown>> {
  return target.sent.filter((message) => message.method === method);
}

function observeIdle(control: GatewayRelayControl, threadId = "thread-1"): void {
  control.handleObserver({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
}

function updateNativeMode(control: GatewayRelayControl, target: TestClient, id: number, mode: "default" | "plan"): void {
  const routed = control.handleFrontend(target, {
    id,
    method: "thread/settings/update",
    params: { threadId: "thread-1", collaborationMode: { mode, settings: {} } },
  });
  expect(routed.handled).toBe(false);
  control.handleBackend(target, { id, result: {} });
}

describe("experimental Relay Gateway control plane", () => {
  test("keeps thread mode and command snapshots in memory with revisioned envelopes", () => {
    const origin = client("origin", "agent-relay", ["thread-1"]);
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, origin);
    hello(control, peer);
    observeIdle(control);
    origin.sent.length = 0;
    peer.sent.length = 0;

    control.handleFrontend(origin, {
      id: 2,
      method: RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
      params: { threadId: "thread-1", operation: "set", mode: "plan" },
    });
    expect(origin.sent.find((message) => message.id === 2)?.result).toEqual({ collaborationMode: "plan" });
    expect(notifications(peer, "agent-relay/control/threadState")).toHaveLength(0);
    updateNativeMode(control, origin, 22, "plan");
    const state = peer.sent.find((message) => message.method === "agent-relay/control/threadState");
    expect(state?.params).toMatchObject({
      threadId: "thread-1",
      collaborationMode: "plan",
      collaborationModeApplied: true,
      collaborationModeSource: { kind: "relay", label: "Agent Relay" },
      threadStatus: "idle",
      waitingOn: null,
    });

    const metadata = { version: RELAY_CONTROL_PROTOCOL_VERSION, commandId: "command-1", kind: "review", originToken: "origin-1" };
    const routed = control.handleFrontend(origin, {
      id: 3,
      method: "review/start",
      params: { threadId: "thread-1", target: { type: "uncommittedChanges" } },
      relayControl: metadata,
    });
    expect(routed.message).not.toHaveProperty("relayControl");
    control.handleBackend(origin, { id: 3, result: { turn: { id: "turn-1", status: "inProgress" } } });
    control.handleBackend(origin, {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });

    peer.sent.length = 0;
    control.sendSnapshot(peer, "thread-1");
    const snapshot = notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>;
    expect(snapshot).toMatchObject({ gatewayEpoch: control.gatewayEpoch, consistency: "live" });
    expect(snapshot.threadState).toMatchObject({ collaborationMode: "plan", collaborationModeApplied: true, threadStatus: "idle" });
    expect(snapshot.commands).toEqual([expect.objectContaining({ commandId: "command-1", kind: "review", phase: "completed" })]);
    expect(JSON.stringify(snapshot)).not.toContain("uncommittedChanges");
    expect(JSON.stringify(snapshot)).not.toContain("origin-1");
  });

  test("arbitrates one shared Plan decision and completes it on the implementation turn", () => {
    const origin = client("origin", "agent-relay", ["thread-1"]);
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, origin);
    hello(control, peer);

    control.handleFrontend(origin, {
      id: 50,
      method: RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD,
      params: { threadId: "thread-1", planTurnId: "plan-turn" },
    });
    expect(notifications(peer, RELAY_CONTROL_PLAN_DECISION_METHOD).at(-1)?.params).toMatchObject({
      threadId: "thread-1",
      planTurnId: "plan-turn",
      phase: "ready",
    });

    control.handleFrontend(peer, {
      id: 51,
      method: RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
      params: { threadId: "thread-1", planTurnId: "plan-turn", action: "implement" },
    });
    control.handleFrontend(origin, {
      id: 52,
      method: RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
      params: { threadId: "thread-1", planTurnId: "plan-turn", action: "continue" },
    });
    expect(peer.sent.find((message) => message.id === 51)?.result).toMatchObject({ claimed: true, state: { phase: "implementing", action: "implement" } });
    expect(origin.sent.find((message) => message.id === 52)?.result).toMatchObject({ claimed: false, state: { phase: "implementing", action: "implement" } });

    control.handleObserver({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "unrelated-turn" } } });
    expect(notifications(origin, RELAY_CONTROL_PLAN_DECISION_METHOD).at(-1)?.params).toMatchObject({ phase: "implementing" });

    const reconnectedPeer = client("peer-reconnected", "agent-relay", ["thread-1"]);
    clients.delete(peer.data.id);
    clients.set(reconnectedPeer.data.id, reconnectedPeer);
    control.handleFrontend(reconnectedPeer, {
      id: 53,
      method: RELAY_CONTROL_HELLO_METHOD,
      params: { version: RELAY_CONTROL_PROTOCOL_VERSION, instanceId: "instance-peer" },
    });
    control.handleFrontend(reconnectedPeer, { id: 54, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "Implement the approved plan." }] } });
    control.handleObserver({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "implementation-turn" } } });
    expect(notifications(origin, RELAY_CONTROL_PLAN_DECISION_METHOD).at(-1)?.params).toMatchObject({
      phase: "implementation_started",
      implementationTurnId: "implementation-turn",
    });

    origin.sent.length = 0;
    control.sendSnapshot(origin, "thread-1");
    const snapshot = notifications(origin, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>;
    expect(snapshot.planDecisions).toEqual([expect.objectContaining({ planTurnId: "plan-turn", phase: "implementation_started" })]);
  });

  test("expires ready Plan decisions when the shared thread returns to Default mode", () => {
    const relay = client("relay", "agent-relay", ["thread-1"]);
    const clients = new Map([[relay.data.id, relay]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, relay);
    observeIdle(control);
    updateNativeMode(control, relay, 60, "plan");
    control.handleFrontend(relay, {
      id: 61,
      method: RELAY_CONTROL_PLAN_DECISION_REGISTER_METHOD,
      params: { threadId: "thread-1", planTurnId: "plan-turn" },
    });
    updateNativeMode(control, relay, 62, "default");
    control.handleFrontend(relay, {
      id: 63,
      method: RELAY_CONTROL_PLAN_DECISION_CLAIM_METHOD,
      params: { threadId: "thread-1", planTurnId: "plan-turn", action: "continue" },
    });

    expect(relay.sent.find((message) => message.id === 63)?.result).toMatchObject({ claimed: false, state: { phase: "expired" } });
  });

  test("rejects collaboration mode changes while active or waiting", () => {
    const native = client("native", "codex-cli", ["thread-1"]);
    const relay = client("relay", "agent-relay", ["thread-1"]);
    const control = new GatewayRelayControl(() => [native, relay]);
    hello(control, relay);
    control.handleObserver({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
    });
    relay.sent.length = 0;

    expect(control.handleFrontend(relay, {
      id: 70,
      method: RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
      params: { threadId: "thread-1", operation: "toggle" },
    }).handled).toBe(true);
    expect(relay.sent.find((message) => message.id === 70)?.error).toMatchObject({
      code: -32000,
      message: "'/plan' is disabled while a task is in progress.",
    });

    expect(control.handleFrontend(native, {
      id: 71,
      method: "thread/settings/update",
      params: { threadId: "thread-1", collaborationMode: { mode: "plan", settings: {} } },
    }).handled).toBe(true);
    expect(native.sent.find((message) => message.id === 71)?.error).toMatchObject({ code: -32000 });
    expect(notifications(relay, "agent-relay/control/threadState")).toHaveLength(0);
  });

  test("serializes idle mode changes with turn starts in both request orders", () => {
    const native = client("native", "codex-cli", ["thread-1"]);
    const relay = client("relay", "agent-relay", ["thread-1"]);
    const control = new GatewayRelayControl(() => [native, relay]);
    hello(control, relay);
    observeIdle(control);

    control.handleFrontend(relay, {
      id: 72,
      method: RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
      params: { threadId: "thread-1", operation: "set", mode: "plan" },
    });
    expect(control.handleFrontend(native, {
      id: 73,
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work" }] },
    }).handled).toBe(true);
    expect(native.sent.find((message) => message.id === 73)?.error).toMatchObject({ code: -32000 });

    control.handleFrontend(relay, {
      id: 74,
      method: "thread/settings/update",
      params: { threadId: "thread-1", collaborationMode: { mode: "plan", settings: {} } },
    });
    control.handleBackend(relay, { id: 74, result: {} });
    control.handleFrontend(native, {
      id: 75,
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work" }] },
    });
    expect(control.handleFrontend(relay, {
      id: 76,
      method: RELAY_CONTROL_THREAD_STATE_UPDATE_METHOD,
      params: { threadId: "thread-1", operation: "set", mode: "default" },
    }).handled).toBe(true);
    expect(relay.sent.find((message) => message.id === 76)?.error).toMatchObject({
      code: -32000,
      message: "'/plan' is disabled while a task is in progress.",
    });
  });

  test("projects native start, waiting, interrupt, and terminal source without letting old terminals clear a new turn", () => {
    const native = client("native", "codex-cli", ["thread-1"]);
    const relay = client("relay", "agent-relay", ["thread-1"]);
    const control = new GatewayRelayControl(() => [native, relay]);
    hello(control, relay);
    observeIdle(control);
    relay.sent.length = 0;

    control.handleFrontend(native, {
      id: 80,
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "work" }] },
    });
    control.handleBackend(native, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", startedAt: 100 } },
    });
    control.handleBackend(native, {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    });
    control.handleObserver({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", startedAt: 100, itemsView: "summary" } },
    });
    expect(notifications(relay, "agent-relay/control/threadState").at(-1)?.params).toMatchObject({
      threadStatus: "active",
      waitingOn: "approval",
      activeTurn: { turnId: "turn-1", source: { kind: "codexCli", label: "Codex CLI" }, startedAt: 100_000 },
    });

    control.handleFrontend(native, {
      id: 81,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    expect(notifications(relay, "agent-relay/control/threadState").at(-1)?.params).toMatchObject({
      activeTurn: { turnId: "turn-1", interruptRequest: { source: { kind: "codexCli" } } },
    });
    control.handleBackend(native, {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", startedAt: 100, completedAt: 101 } },
    });
    control.handleObserver({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", startedAt: 100, completedAt: 101, itemsView: "summary" } },
    });
    expect(notifications(relay, "agent-relay/control/threadState").at(-1)?.params).toMatchObject({
      threadStatus: "idle",
      waitingOn: null,
      latestTurn: {
        turnId: "turn-1",
        status: "interrupted",
        source: { kind: "codexCli" },
        interruptedBy: { kind: "codexCli" },
        finishedAt: 101_000,
      },
    });

    control.handleFrontend(native, {
      id: 82,
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "new" }] },
    });
    control.handleBackend(native, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress", startedAt: 102 } },
    });
    control.handleObserver({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", completedAt: 103 } },
    });
    expect(notifications(relay, "agent-relay/control/threadState").at(-1)?.params).toMatchObject({
      threadStatus: "active",
      activeTurn: { turnId: "turn-2" },
      latestTurn: { turnId: "turn-1", status: "interrupted" },
    });
  });

  test("keeps ephemeral BTW forks outside Relay control snapshots", () => {
    const origin = client("origin", "agent-relay", ["parent"]);
    const peer = client("peer", "agent-relay", ["parent"]);
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, origin);
    hello(control, peer);

    const routed = control.handleFrontend(origin, {
      id: 10,
      method: "thread/fork",
      params: { threadId: "parent", ephemeral: true, excludeTurns: true },
    });
    expect(routed).toEqual({ handled: false, message: expect.objectContaining({ method: "thread/fork" }) });
    control.handleBackend(origin, { id: 10, result: { thread: { id: "child" } } });
    control.handleFrontend(origin, {
      id: 11,
      method: "turn/start",
      params: { threadId: "child", input: [{ type: "text", text: "private live question" }] },
    });
    control.handleBackend(origin, { id: 11, result: { turn: { id: "side-turn", status: "inProgress" } } });
    control.handleBackend(origin, {
      method: "item/agentMessage/delta",
      params: { threadId: "child", turnId: "side-turn", itemId: "answer", delta: "live answer" },
    });
    control.handleBackend(origin, {
      method: "turn/completed",
      params: { threadId: "child", turn: { id: "side-turn", status: "completed" } },
    });

    expect(notifications(peer, RELAY_CONTROL_COMMAND_METHOD)).toHaveLength(0);

    peer.sent.length = 0;
    control.sendSnapshot(peer, "parent");
    const snapshot = notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params;
    expect(snapshot).toMatchObject({ consistency: "live", commands: [] });
  });

  test("observes supported native operations for Relay peers and ignores unrelated threads", () => {
    const native = client("native", "codex-desktop", ["thread-1"]);
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const unrelated = client("other", "agent-relay", ["thread-2"]);
    const clients = new Map([[native.data.id, native], [peer.data.id, peer], [unrelated.data.id, unrelated]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, peer);
    hello(control, unrelated);

    control.handleFrontend(native, { id: 20, method: "thread/name/set", params: { threadId: "thread-1", name: "Shared" } });
    control.handleBackend(native, { id: 20, result: {} });

    const events = notifications(peer, RELAY_CONTROL_COMMAND_METHOD);
    expect(events).toHaveLength(2);
    expect(events[0]?.params).toMatchObject({ kind: "rename", phase: "accepted", source: "codex" });
    expect(events[1]?.params).toMatchObject({ kind: "rename", phase: "completed", source: "codex" });
    expect(notifications(unrelated, RELAY_CONTROL_COMMAND_METHOD)).toHaveLength(0);
    expect(native.sent).toHaveLength(0);
  });

  test("completes lifecycle commands when the native notification precedes the RPC response", () => {
    const native = client("native", "codex-desktop", ["thread-1"]);
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const clients = new Map([[native.data.id, native], [peer.data.id, peer]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, peer);

    control.handleFrontend(native, { id: 25, method: "thread/delete", params: { threadId: "thread-1" } });
    control.handleBackend(native, { method: "thread/deleted", params: { threadId: "thread-1" } });
    control.handleBackend(native, { id: 25, result: {} });

    const events = notifications(peer, RELAY_CONTROL_COMMAND_METHOD);
    expect(events).toHaveLength(2);
    expect(events[0]?.params).toMatchObject({ kind: "delete", phase: "accepted" });
    expect(events[1]?.params).toMatchObject({ kind: "delete", phase: "completed" });
  });

  test("does not keep ephemeral BTW work alive as a shared control command after disconnect", () => {
    const origin = client("origin", "agent-relay", ["parent"]);
    const peer = client("peer", "agent-relay", ["parent"]);
    const clients = new Map([[origin.data.id, origin], [peer.data.id, peer]]);
    const control = new GatewayRelayControl(() => clients.values());
    hello(control, origin);
    hello(control, peer);
    control.handleFrontend(origin, {
      id: 30,
      method: "thread/fork",
      params: { threadId: "parent", ephemeral: true },
    });
    control.handleBackend(origin, { id: 30, result: { thread: { id: "side-child" } } });
    control.handleFrontend(origin, { id: 31, method: "turn/start", params: { threadId: "side-child", input: [{ type: "text", text: "keep going" }] } });
    control.handleBackend(origin, { id: 31, result: { turn: { id: "side-turn", status: "inProgress" } } });

    peer.sent.length = 0;
    expect(control.clientDisconnected("origin")).toBe(false);
    expect(notifications(peer, RELAY_CONTROL_COMMAND_METHOD)).toHaveLength(0);
    control.handleObserver({
      method: "item/agentMessage/delta",
      params: { threadId: "side-child", turnId: "side-turn", itemId: "answer", delta: "after disconnect" },
    });
    control.handleObserver({
      method: "turn/completed",
      params: { threadId: "side-child", turn: { id: "side-turn", status: "completed" } },
    });
    expect(notifications(peer, RELAY_CONTROL_COMMAND_METHOD)).toHaveLength(0);
  });

  test("starts a fresh Gateway epoch in native Default mode and supports ACK plus resync", () => {
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const control = new GatewayRelayControl(() => [peer]);
    hello(control, peer);

    control.handleFrontend(peer, {
      id: 40,
      method: RELAY_CONTROL_RESYNC_METHOD,
      params: { threadId: "thread-1" },
    });
    const snapshot = notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>;
    expect(snapshot.threadState).toMatchObject({ collaborationMode: "default", collaborationModeApplied: true });
    expect(peer.sent.at(-1)).toEqual({ id: 40, result: { gatewayEpoch: control.gatewayEpoch, revision: 0 } });

    control.handleFrontend(peer, {
      method: RELAY_CONTROL_ACK_METHOD,
      params: { gatewayEpoch: control.gatewayEpoch, threadId: "thread-1", revision: 0 },
    });
    expect(peer.data.relayControlAcks?.get("thread-1")).toBe(0);
  });

  test("hydrates active and terminal state from observer resume snapshots without replay data", () => {
    const native = client("native", "codex-cli", ["thread-1"]);
    const peer = client("peer", "agent-relay", ["thread-1"]);
    const control = new GatewayRelayControl(() => [native, peer]);
    hello(control, peer);

    control.handleObserverSnapshot("thread-1", {
      thread: { id: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
      initialTurnsPage: { data: [{ id: "turn-1", status: "inProgress", startedAt: 200 }] },
    });
    peer.sent.length = 0;
    control.sendSnapshot(peer, "thread-1");
    expect((notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>)?.threadState).toMatchObject({
      threadStatus: "active",
      waitingOn: "userInput",
      activeTurn: { turnId: "turn-1", source: { kind: "unknown" }, startedAt: 200_000 },
    });

    control.handleFrontend(native, {
      id: 90,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });

    control.handleObserverSnapshot("thread-1", {
      thread: { id: "thread-1", status: { type: "idle" } },
      initialTurnsPage: { data: [{ id: "turn-1", status: "interrupted", startedAt: 200, completedAt: 201, error: { message: "boom" } }] },
    });
    peer.sent.length = 0;
    control.sendSnapshot(peer, "thread-1");
    expect((notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>)?.threadState).toMatchObject({
      threadStatus: "idle",
      waitingOn: null,
      latestTurn: {
        turnId: "turn-1",
        status: "interrupted",
        source: { kind: "unknown" },
        interruptedBy: { kind: "codexCli" },
        finishedAt: 201_000,
        error: "boom",
      },
    });

    control.handleObserverSnapshot("thread-1", {
      thread: { id: "thread-1", status: { type: "idle" } },
      initialTurnsPage: { data: [] },
    });
    peer.sent.length = 0;
    control.sendSnapshot(peer, "thread-1");
    const emptyState = (notifications(peer, RELAY_CONTROL_SNAPSHOT_METHOD).at(-1)?.params as Record<string, unknown>)?.threadState as Record<string, unknown>;
    expect(emptyState.latestTurn).toBeUndefined();
  });
});
