import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "../../src/domain/logger.ts";
import { ensureRelayGateway, readGatewayState, RELAY_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/state.ts";
import { gatewayUrlForRelay, readRelayWorkControl, writeRelayWorkControl } from "../../src/gateway/control.ts";
import { relayTestConfig } from "../support/relay-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("experimental relay work Gateway state", () => {
  test("accepts only the versioned loopback state shape", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-gateway-state-"));
    roots.push(root);
    const path = join(root, "gateway.json");
    writeFileSync(path, JSON.stringify({
      experimental: true,
      protocolVersion: RELAY_GATEWAY_PROTOCOL_VERSION,
      pid: process.pid,
      appServerPid: process.pid,
      url: "ws://127.0.0.1:18765",
      startedAt: 1,
    }));
    expect(readGatewayState(path)?.url).toBe("ws://127.0.0.1:18765");
    writeFileSync(path, JSON.stringify({ experimental: true, protocolVersion: 999, url: "ws://0.0.0.0:18765" }));
    expect(readGatewayState(path)).toBeUndefined();
  });

  test("does not create state or processes while the master gate is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-gateway-disabled-"));
    roots.push(root);
    const path = join(root, "gateway.json");
    const config = relayTestConfig(root, "info", {
      experimentalRelayWorkEnabled: false,
      experimentalRelayGatewayStatePath: path,
    });
    await expect(ensureRelayGateway(config, noopLogger)).rejects.toThrow("disabled");
    expect(existsSync(path)).toBe(false);
  });

  test("keeps explicit local mode separate from an unexpected Gateway exit", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-gateway-control-"));
    roots.push(root);
    const controlPath = join(root, "control.json");
    const statePath = join(root, "gateway.json");
    writeRelayWorkControl("local", statePath, controlPath);
    expect(readRelayWorkControl(controlPath)?.mode).toBe("local");
    expect(() => gatewayUrlForRelay(controlPath)).toThrow("Gateway is stopped");

    writeRelayWorkControl("gateway", statePath, controlPath);
    expect(readRelayWorkControl(controlPath)?.mode).toBe("gateway");
    expect(() => gatewayUrlForRelay(controlPath)).toThrow("unexpected exit");
    expect(readRelayWorkControl(controlPath)?.mode).toBe("gateway");
  });

  test("resolves a live Gateway only while durable mode is gateway", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-gateway-live-control-"));
    roots.push(root);
    const controlPath = join(root, "control.json");
    const statePath = join(root, "gateway.json");
    writeFileSync(statePath, JSON.stringify({
      experimental: true,
      protocolVersion: RELAY_GATEWAY_PROTOCOL_VERSION,
      pid: process.pid,
      appServerPid: process.pid,
      url: "ws://127.0.0.1:18765",
      startedAt: Date.now(),
    }));
    writeRelayWorkControl("gateway", statePath, controlPath);
    expect(gatewayUrlForRelay(controlPath)).toBe("ws://127.0.0.1:18765");
  });
});
