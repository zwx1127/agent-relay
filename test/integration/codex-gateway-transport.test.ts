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
          else if (method === "agent-relay/control/hello") send({ version: 4, gatewayEpoch: "test-gateway" });
          else if (method === "agent-relay/control/resync") {
            socket.send(JSON.stringify({
              method: "agent-relay/control/snapshot",
              params: {
                gatewayEpoch: "test-gateway",
                threadId: params?.threadId,
                revision: 0,
                consistency: "live",
                threadState: { threadId: params?.threadId, collaborationMode: "default", collaborationModeApplied: true, revision: 0, updatedAt: Date.now() },
                commands: [],
              },
            }));
            send({ gatewayEpoch: "test-gateway", revision: 0 });
          }
          else if (method === "agent-relay/control/threadState/update") send({
            threadId: params?.threadId,
            collaborationMode: params?.mode ?? "plan",
            collaborationModeApplied: false,
            revision: 1,
            updatedAt: Date.now(),
          });
          else if (method === "model/list") send({ data: [{ id: "gpt-test", model: "gpt-test", isDefault: true }] });
          else if (method === "collaborationMode/list") send({ data: [{ mode: "default" }, { mode: "plan" }] });
          else if (method === "thread/resume") send({
            thread: {
              id: params?.threadId,
              status: { type: "active" },
            },
            initialTurnsPage: { data: [{ id: "active-turn", status: "inProgress", items: [{ type: "reasoning", id: "reason", summary: ["Already working"] }], startedAt: 1 }], nextCursor: null },
            model: "gpt-test",
          });
          else if (method === "thread/read") send({
            thread: {
              id: params?.threadId,
              status: { type: "active", activeFlags: [] },
              turns: [{ id: "active-turn", status: "inProgress", items: [{ type: "reasoning", id: "reason", summary: ["Already working"] }], startedAt: 1 }],
            },
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
            socket.send(JSON.stringify({
              method: "item/started",
              params: {
                threadId: "shared-thread",
                turnId: "active-turn",
                item: {
                  type: "userMessage",
                  id: "external-user",
                  clientId: null,
                  content: [
                    { type: "text", text: "from Codex Desktop" },
                    { type: "localImage", path: "C:/tmp/screenshot.png" },
                  ],
                },
              },
            }));
          } else if (method === "turn/steer") {
            send({ turn: { id: "active-turn", status: "inProgress", items: [] } });
            socket.send(JSON.stringify({
              method: "item/started",
              params: {
                threadId: "shared-thread",
                turnId: "active-turn",
                item: {
                  type: "userMessage",
                  id: "relay-user",
                  clientId: params?.clientUserMessageId,
                  content: [{ type: "text", text: "steer from IM" }],
                },
              },
            }));
          }
          else if (method === "thread/goal/get") send({ goal: null });
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
      developerInstructions: "relay developer instructions",
      baseInstructions: "relay base instructions",
    }, async (event) => {
      if (event.type === "user_input_request") await Bun.sleep(20);
      outputs.push(event as unknown as Record<string, unknown>);
    }, () => undefined);

    try {
      const status = await driver.start({ conversationId: "1", workspaceName: "demo", workspacePath: process.cwd(), threadId: "shared-thread" });
      expect(status.threadId).toBe("shared-thread");
      expect(gatewayResolutions).toBe(1);
      expect(status.activeTurnId).toBe("active-turn");
      expect(status.latestTurn).toMatchObject({
        id: "active-turn",
        status: "inProgress",
        startedAt: 1000,
        activities: [{ itemId: "reason", activity: { kind: "reasoning", summary: "Already working" } }],
      });
      await Bun.sleep(20);
      await driver.send(status.sessionKey, "steer from IM");
      await Bun.sleep(10);
      const resume = received.find((message) => message.method === "thread/resume");
      const resumeParams = resume?.params as Record<string, unknown>;
      expect(resumeParams.excludeTurns).toBe(true);
      expect(resumeParams.initialTurnsPage).toEqual({ limit: 1, sortDirection: "desc", itemsView: "full" });
      const reads = received.filter((message) => message.method === "thread/read");
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect(reads.every((message) => (message.params as Record<string, unknown>)?.includeTurns === true)).toBe(true);
      expect(status.threadGoal).toBeNull();
      expect(status.collaborationMode).toBe("default");
      expect(status.relayStateConsistency).toBe("live");
      for (const field of ["cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "developerInstructions", "baseInstructions"]) {
        expect(resumeParams).not.toHaveProperty(field);
      }
      const steer = received.find((message) => message.method === "turn/steer");
      expect((steer?.params as Record<string, unknown>)?.clientUserMessageId).toMatch(/^agent-relay:/);
      expect(outputs).toContainEqual(expect.objectContaining({ type: "message", chunk: "live after connection" }));
      expect(outputs).toContainEqual(expect.objectContaining({
        type: "user_message",
        sessionKey: status.sessionKey,
        input: { text: "from Codex Desktop", attachments: [{ type: "localImage", path: "C:/tmp/screenshot.png" }] },
      }));
      expect(outputs).not.toContainEqual(expect.objectContaining({ type: "user_message", input: expect.objectContaining({ text: "steer from IM" }) }));
      expect(outputs).toContainEqual(expect.objectContaining({ type: "user_input_request", requestId: "shared-question" }));
      expect(outputs).toContainEqual(expect.objectContaining({ type: "server_request_resolved", sessionKey: status.sessionKey, requestId: "shared-question" }));
      expect(driver.getStatus(status.sessionKey)?.activeTurnId).toBe("active-turn");
      expect(driver.getStatus(status.sessionKey)?.waitingForUserInput).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("mirrors live user messages across shared IM scopes without echoing the origin", async () => {
    const received: Array<Record<string, unknown>> = [];
    const outputs: Array<Record<string, unknown>> = [];
    let sendNotification: ((message: unknown) => void) | undefined;
    const server = Bun.serve<{ name?: string }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        if (bunServer.upgrade(request, { data: {} })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          sendNotification = (message) => socket.send(JSON.stringify(message));
        },
        close() {
          sendNotification = undefined;
        },
        message(socket, data) {
          const message = JSON.parse(String(data)) as Record<string, unknown>;
          received.push(message);
          const id = message.id;
          const method = message.method;
          const params = message.params as Record<string, unknown> | undefined;
          const send = (result: unknown) => socket.send(JSON.stringify({ id, result }));
          if (method === "initialize") send({ userAgent: "codex-cli 0.145.0" });
          else if (method === "agent-relay/control/hello") send({ version: 4, gatewayEpoch: "test-gateway" });
          else if (method === "agent-relay/control/resync") {
            socket.send(JSON.stringify({
              method: "agent-relay/control/snapshot",
              params: {
                gatewayEpoch: "test-gateway",
                threadId: params?.threadId,
                revision: 0,
                consistency: "live",
                threadState: { threadId: params?.threadId, collaborationMode: "default", collaborationModeApplied: true, revision: 0, updatedAt: Date.now() },
                commands: [],
              },
            }));
            send({ gatewayEpoch: "test-gateway", revision: 0 });
          }
          else if (method === "agent-relay/control/threadState/update") send({
            threadId: params?.threadId,
            collaborationMode: params?.mode ?? "plan",
            collaborationModeApplied: false,
            revision: 1,
            updatedAt: Date.now(),
          });
          else if (method === "model/list") send({ data: [{ id: "gpt-test", model: "gpt-test", isDefault: true }] });
          else if (method === "collaborationMode/list") send({ data: [{ mode: "default" }, { mode: "plan" }] });
          else if (method === "thread/resume") send({ thread: { id: params?.threadId, status: { type: "idle" } }, initialTurnsPage: { data: [], nextCursor: null } });
          else if (method === "thread/start") send({
            thread: { id: "fresh-thread", status: { type: "idle" } },
            model: "gpt-thread-config",
            reasoningEffort: "high",
          });
          else if (method === "thread/fork") send({ thread: { id: params?.ephemeral ? "side-thread" : "forked-thread", status: { type: "idle" } } });
          else if (method === "thread/backgroundTerminals/list") send({ data: [] });
          else if (method === "thread/goal/get") send({ goal: null });
          else if (method === "thread/unsubscribe") send({});
          else if (method === "thread/inject_items") send({});
          else if (method === "turn/start") {
            send({ turn: { id: "new-turn", status: "inProgress", items: [] } });
            if (params?.threadId === "side-thread") {
              socket.send(JSON.stringify({
                method: "item/agentMessage/delta",
                params: { threadId: "side-thread", turnId: "new-turn", itemId: "side-answer", delta: "side response" },
              }));
              socket.send(JSON.stringify({
                method: "turn/completed",
                params: { threadId: "side-thread", turn: { id: "new-turn", status: "completed", items: [] } },
              }));
              return;
            }
            socket.send(JSON.stringify({
              method: "item/started",
              params: {
                threadId: params?.threadId,
                turnId: "new-turn",
                item: {
                  type: "userMessage",
                  id: "relay-origin-message",
                  clientId: params?.clientUserMessageId,
                  content: [{ type: "text", text: "from scope one" }],
                },
              },
            }));
          }
        },
      },
    });
    const driver = new CodexDriver({
      codexBin: fakeCodexBin(),
      gatewayUrl: `ws://127.0.0.1:${server.port}`,
      sandbox: "workspace-write",
      approval: "on-request",
      developerInstructions: "relay developer instructions",
      baseInstructions: "relay base instructions",
    }, (event) => {
      outputs.push(event as unknown as Record<string, unknown>);
    }, () => undefined);

    try {
      const first = await driver.start({ conversationId: "1", scopeKey: "1", workspaceName: "demo", workspacePath: "C:/work/demo", threadId: "shared-thread" });
      const second = await driver.start({ conversationId: "2", scopeKey: "2", workspaceName: "demo", workspacePath: "C:/work/demo", threadId: "shared-thread" });
      const external = {
        method: "item/started",
        params: {
          threadId: "shared-thread",
          turnId: "external-turn",
          item: { type: "userMessage", id: "external-message", clientId: "codex-native", content: [{ type: "text", text: "native input" }] },
        },
      };
      sendNotification?.(external);
      sendNotification?.(external);
      await Bun.sleep(20);
      expect(outputs.filter((event) => event.type === "user_message")).toEqual([
        expect.objectContaining({ sessionKey: first.sessionKey, input: { text: "native input" } }),
        expect.objectContaining({ sessionKey: second.sessionKey, input: { text: "native input" } }),
      ]);

      outputs.length = 0;
      await driver.send(first.sessionKey, "from scope one", {
        collaborationMode: "default",
        clientUserMessageId: "agent-relay:scope-one",
      });
      await Bun.sleep(20);
      expect(outputs.filter((event) => event.type === "user_message")).toEqual([
        expect.objectContaining({
          sessionKey: second.sessionKey,
          input: { text: "from scope one" },
          clientUserMessageId: "agent-relay:scope-one",
        }),
      ]);
      const turnStart = received.find((message) => message.method === "turn/start");
      expect((turnStart?.params as Record<string, unknown>)?.clientUserMessageId).toBe("agent-relay:scope-one");
      expect(turnStart?.params as Record<string, unknown>).not.toHaveProperty("collaborationMode");

      outputs.length = 0;
      const sideEvents: Record<string, unknown>[] = [];
      const opened = await driver.openSideConversation(first.sessionKey, {
        eventSessionKey: "codex-side:1:demo",
        onEvent: (event) => { sideEvents.push(event as unknown as Record<string, unknown>); },
      });
      expect(await driver.sendSideConversationInput(first.sessionKey, opened.threadId, { text: "side question" }))
        .toMatchObject({ turnId: "new-turn", steered: false });
      await Bun.sleep(20);
      expect(sideEvents).toContainEqual(expect.objectContaining({ type: "message", chunk: "side response" }));
      expect(sideEvents).toContainEqual(expect.objectContaining({ type: "turn_completed", status: "completed" }));
      expect(outputs).toEqual([]);
      const sideFork = received.find((message) => message.method === "thread/fork" && (message.params as Record<string, unknown>)?.ephemeral === true);
      const sideForkParams = sideFork?.params as Record<string, unknown>;
      expect(sideForkParams).toMatchObject({ threadId: "shared-thread", ephemeral: true, excludeTurns: true });
      expect(sideFork).not.toHaveProperty("relayControl");
      for (const field of ["cwd", "approvalPolicy", "approvalsReviewer", "sandbox", "developerInstructions", "baseInstructions"]) {
        expect(sideForkParams).not.toHaveProperty(field);
      }
      const sideBoundary = received.find((message) => message.method === "thread/inject_items"
        && (message.params as Record<string, unknown>)?.threadId === "side-thread");
      expect(JSON.stringify(sideBoundary?.params)).toContain("side conversation");

      expect(outputs).not.toContainEqual(expect.objectContaining({ type: "relay_command_state", kind: "side" }));
      await driver.closeSideConversation(first.sessionKey, opened.threadId);

      expect(await driver.syncThreadCollaborationMode(first.sessionKey, "default", { operation: "set", mode: "plan" })).toBe("plan");
      expect(received.find((message) => message.method === "agent-relay/control/threadState/update")?.params).toMatchObject({
        threadId: "shared-thread",
        operation: "set",
        mode: "plan",
      });

      const fresh = await driver.start({ conversationId: "3", scopeKey: "3", workspaceName: "demo", workspacePath: "C:/work/fresh" });
      const threadStart = received.find((message) => message.method === "thread/start");
      expect(threadStart?.params).toEqual({
        cwd: "C:/work/fresh",
      });

      const explicitModeResult = await driver.send(fresh.sessionKey, "explicit plan mode", {
        collaborationMode: "plan",
        collaborationModeExplicit: true,
      });
      const explicitModeTurn = received.find((message) => message.method === "turn/start"
        && JSON.stringify(message.params).includes("explicit plan mode"));
      expect((explicitModeTurn?.params as Record<string, unknown>)?.collaborationMode).toEqual({
        mode: "plan",
        settings: {
          model: "gpt-thread-config",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      });
      expect(explicitModeResult.collaborationModeApplied).toBe(true);

      await driver.forkThread(second.sessionKey);
      const fork = received.find((message) => message.method === "thread/fork" && (message.params as Record<string, unknown>)?.ephemeral !== true);
      expect(fork?.params).toEqual({ threadId: "shared-thread", excludeTurns: true });
      await driver.release(first.sessionKey);
      await driver.release(second.sessionKey);
      await driver.release(fresh.sessionKey);
    } finally {
      server.stop(true);
    }
  });
});
