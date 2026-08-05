import { describe, expect, test } from "bun:test";
import { GatewayLiveEventSequencer } from "../../src/gateway/live-events.ts";

describe("experimental relay work Gateway live events", () => {
  test("assigns connection-lifetime per-thread sequences without retaining replay payloads", () => {
    const events = new GatewayLiveEventSequencer();
    const first = events.sequence("desktop", { method: "item/started", params: { threadId: "t1", itemId: "1" } }, 1);
    const second = events.sequence("desktop", { method: "item/completed", params: { threadId: "t1", itemId: "1" } }, 2);
    expect(first).toEqual({ seq: 1, threadId: "t1", method: "item/started" });
    expect(second).toEqual({ seq: 2, threadId: "t1", method: "item/completed" });
    expect(first).not.toHaveProperty("message");
  });

  test("deduplicates the same live broadcast observed through different clients", () => {
    const events = new GatewayLiveEventSequencer();
    const message = { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn" } } };
    const first = events.sequence("desktop", message, 100);
    const duplicate = events.sequence("relay", message, 101);
    const repeatedFromOrigin = events.sequence("desktop", message, 102);
    expect(duplicate?.seq).toBe(first?.seq);
    expect(repeatedFromOrigin?.seq).toBe(2);
  });
});
