import { describe, expect, test } from "bun:test";
import { GatewayObserver } from "../../src/gateway/observer.ts";

describe("experimental Relay Gateway observer", () => {
  test("re-subscribes anchored threads and keeps observing after its backend socket drops", async () => {
    const received: Array<Record<string, unknown>> = [];
    const observed: Array<Record<string, unknown>> = [];
    const snapshots: Array<{ threadId: string; value: unknown }> = [];
    let activeSocket: { close(code?: number, reason?: string): void } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request)) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          activeSocket = socket;
        },
        close(socket) {
          if (activeSocket === socket) activeSocket = undefined;
        },
        message(socket, data) {
          const message = JSON.parse(String(data)) as Record<string, unknown>;
          received.push(message);
          const id = message.id;
          if (message.method === "initialize") socket.send(JSON.stringify({ id, result: { userAgent: "codex-cli 0.145.0" } }));
          else if (message.method === "thread/resume") {
            socket.send(JSON.stringify({ id, result: { thread: { id: "thread-1" }, initialTurnsPage: { data: [] } } }));
            socket.send(JSON.stringify({ method: "thread/goal/updated", params: { threadId: "thread-1", goal: { objective: "shared" } } }));
          }
        },
      },
    });
    const observer = new GatewayObserver(
      `ws://127.0.0.1:${server.port}`,
      (message) => observed.push(message),
      undefined,
      (threadId, value) => snapshots.push({ threadId, value }),
    );

    try {
      await observer.start();
      observer.anchor("thread-1");
      await waitFor(() => received.filter((message) => message.method === "thread/resume").length === 1);
      expect(received.find((message) => message.method === "thread/resume")?.params).toEqual({
        threadId: "thread-1",
        excludeTurns: true,
        initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
      });
      expect(observed).toContainEqual(expect.objectContaining({ method: "thread/goal/updated" }));
      expect(snapshots).toContainEqual({
        threadId: "thread-1",
        value: { thread: { id: "thread-1" }, initialTurnsPage: { data: [] } },
      });

      activeSocket?.close(1012, "test reconnect");
      await waitFor(() => received.filter((message) => message.method === "thread/resume").length >= 2, 3_000);
      expect(received.filter((message) => message.method === "initialize")).toHaveLength(2);
    } finally {
      observer.stop();
      server.stop(true);
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Gateway observer state.");
    await Bun.sleep(10);
  }
}
