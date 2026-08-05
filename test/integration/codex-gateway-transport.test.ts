import { afterEach, describe, expect, test } from "bun:test";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import { cleanupCodexHarness, fakeCodexBin } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("experimental Codex Gateway transport", () => {
  test("restores current active-turn state and forwards only notifications received while connected", async () => {
    const received: Array<Record<string, unknown>> = [];
    const outputs: Array<Record<string, unknown>> = [];
    const server = Bun.serve<{ name?: string }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request, { data: {} })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(socket, data) {
          const message = JSON.parse(String(data)) as Record<string, unknown>;
          received.push(message);
          const id = message.id;
          const method = message.method;
          const params = message.params as Record<string, unknown> | undefined;
          const send = (result: unknown) => socket.send(JSON.stringify({ id, result }));
          if (method === "initialize") send({ userAgent: "codex-cli 0.145.0" });
          else if (method === "model/list") send({ data: [{ id: "gpt-test", model: "gpt-test", isDefault: true }] });
          else if (method === "collaborationMode/list") send({ data: [{ mode: "default" }, { mode: "plan" }] });
          else if (method === "thread/resume") send({
            thread: {
              id: params?.threadId,
              status: { type: "active" },
            },
            initialTurnsPage: { data: [{ id: "active-turn", status: "inProgress", items: [] }], nextCursor: null },
            model: "gpt-test",
          });
          else if (method === "thread/backgroundTerminals/list") {
            send({ data: [] });
            socket.send(JSON.stringify({
              id: "shared-question",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "shared-thread",
                turnId: "active-turn",
                itemId: "question",
                questions: [{ id: "mode", header: "Mode", question: "Pick one.", options: [] }],
              },
            }));
            setTimeout(() => socket.send(JSON.stringify({
              method: "serverRequest/resolved",
              params: { threadId: "shared-thread", requestId: "shared-question" },
            })), 5);
            socket.send(JSON.stringify({
              method: "item/agentMessage/delta",
              params: { threadId: "shared-thread", turnId: "active-turn", itemId: "reply", delta: "live after connection" },
            }));
          } else if (method === "turn/steer") send({ turn: { id: "active-turn", status: "inProgress", items: [] } });
          else if (method === "thread/list") send({ data: [{ id: "shared-thread", status: { type: "active" } }] });
        },
      },
    });
    const driver = new CodexDriver({
      codexBin: fakeCodexBin(),
      gatewayUrl: `ws://127.0.0.1:${server.port}`,
      sandbox: "workspace-write",
      approval: "on-request",
    }, (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    }, () => undefined);

    try {
      const status = await driver.start({ conversationId: "1", workspaceName: "demo", workspacePath: process.cwd(), threadId: "shared-thread" });
      expect(status.threadId).toBe("shared-thread");
      expect(status.activeTurnId).toBe("active-turn");
      await Bun.sleep(20);
      await driver.send(status.sessionKey, "steer from IM");
      const resume = received.find((message) => message.method === "thread/resume");
      expect((resume?.params as Record<string, unknown>)?.excludeTurns).toBe(true);
      expect((resume?.params as Record<string, unknown>)?.initialTurnsPage).toEqual({ limit: 1, sortDirection: "desc", itemsView: "summary" });
      expect(received.some((message) => message.method === "turn/steer")).toBe(true);
      expect(outputs).toContainEqual(expect.objectContaining({ type: "message", chunk: "live after connection" }));
      expect(outputs).toContainEqual(expect.objectContaining({ type: "user_input_request", requestId: "shared-question" }));
      expect(outputs).toContainEqual({ type: "server_request_resolved", sessionKey: status.sessionKey, requestId: "shared-question" });
      expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBe("active-turn");
    } finally {
      server.stop(true);
    }
  });
});
