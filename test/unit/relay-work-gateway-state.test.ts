import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "../../src/domain/logger.ts";
import { ensureRelayGateway, readGatewayState, RELAY_GATEWAY_PROTOCOL_VERSION } from "../../src/gateway/state.ts";
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
});
