import { describe, expect, test } from "bun:test";
import { createAgentDriver, composeCodexDeveloperInstructions } from "../../src/providers/agents/factory.ts";
import { relayTestConfig } from "../support/relay-fixture.ts";

const callbacks = { onOutput: () => undefined, onExit: () => undefined };

describe("native agent factory", () => {
  test("constructs the selected backend without launching or inheriting Codex instructions", () => {
    for (const provider of ["codex", "claude", "dsh"] as const) {
      const agent = createAgentDriver(relayTestConfig("/tmp", "info", { agentProvider: provider, codexDeveloperInstructions: "Codex only" }), callbacks);
      expect(agent.providerId).toBe(provider);
      expect(agent.getStatus(`${provider}:1:workspace`)).toBeUndefined();
    }
    expect(composeCodexDeveloperInstructions("User rules", "Helper rules")).toContain("request_user_input");
  });

  test("programmatic configs cannot bypass Codex-only Gateway or DSH helper guards", () => {
    for (const provider of ["claude", "dsh"] as const) {
      expect(() => createAgentDriver(relayTestConfig("/tmp", "info", { agentProvider: provider, experimentalRelayWorkEnabled: true }), callbacks)).toThrow("Gateway");
      expect(() => createAgentDriver(relayTestConfig("/tmp", "info", { agentProvider: provider }), { ...callbacks, gatewayUrl: "ws://127.0.0.1:1" })).toThrow("Gateway");
    }
    expect(() => createAgentDriver(relayTestConfig("/tmp", "info", { agentProvider: "dsh", relayControlEnabled: true }), callbacks)).toThrow("helper");
  });
});
