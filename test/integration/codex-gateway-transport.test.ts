import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodexDriver } from "../../src/providers/agents/codex/driver.ts";
import { writeRelayWorkControl } from "../../src/gateway/control.ts";
import { cleanupCodexHarness, createCodexTempDir, fakeCodexBin } from "../support/codex-app-server-harness.ts";

afterEach(cleanupCodexHarness);

describe("experimental Codex Gateway transport", () => {
  test("launcher delegates local mode and fails closed for public remote or missing Gateway runtime", () => {
    const root = createCodexTempDir("agent-relay-launcher-mode-");
    const controlPath = join(root, "control.json");
    const gatewayStatePath = join(root, "gateway-state.json");
    const configPath = join(root, "launcher.json");
    const realCodexBin = fakeCodexBin();
    writeFileSync(configPath, JSON.stringify({ experimental: true, controlStatePath: controlPath, realCodexBin }));
    const run = (args: string[]) => spawnSync(process.execPath, [resolve("src/gateway/codex-launcher.ts"), ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, AGENT_RELAY_WORK_LAUNCHER_CONFIG: configPath },
    });

    writeRelayWorkControl("local", gatewayStatePath, controlPath);
    const local = run(["--version"]);
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("codex-cli 0.145.0");

    const publicRemote = run(["--remote", "ws://127.0.0.1:9999"]);
    expect(publicRemote.status).not.toBe(0);
    expect(publicRemote.stderr).toContain("--remote client mode is not available");

    writeRelayWorkControl("gateway", gatewayStatePath, controlPath);
    const unavailable = run([]);
    expect(unavailable.status).not.toBe(0);
    expect(unavailable.stderr).toContain("unexpected exit");
  });

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
    let gatewayResolutions = 0;
    const driver = new CodexDriver({
      codexBin: fakeCodexBin(),
      gatewayUrlProvider: () => {
        gatewayResolutions += 1;
        return `ws://127.0.0.1:${server.port}`;
      },
      sandbox: "workspace-write",
      approval: "on-request",
    }, (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    }, () => undefined);

    try {
      const status = await driver.start({ conversationId: "1", workspaceName: "demo", workspacePath: process.cwd(), threadId: "shared-thread" });
      expect(status.threadId).toBe("shared-thread");
      expect(gatewayResolutions).toBe(1);
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
