import { describe, expect, test } from "bun:test";
import { resolveRelayHelperPath } from "../../src/relay/control/helper.ts";
import { mentionAgentCapabilityInstructions, relayCapabilityInstructions, sendFileCapabilityInstructions, sendImageCapabilityInstructions } from "../../src/relay/control/skills.ts";

describe("relay control helper", () => {
  test("uses a cmd helper wrapper on Windows", () => {
    expect(resolveRelayHelperPath(String.raw`D:\Code\agent-relay\src\runtime`, "win32")).toBe(String.raw`D:\Code\agent-relay\bin\agent-relay-helper.cmd`);
  });

  test("uses the shebang helper on non-Windows platforms", () => {
    expect(resolveRelayHelperPath(String.raw`D:\Code\agent-relay\src\runtime`, "linux")).toBe(String.raw`D:\Code\agent-relay\bin\agent-relay-helper`);
    expect(resolveRelayHelperPath(String.raw`D:\Code\agent-relay\src\runtime`, "darwin")).toBe(String.raw`D:\Code\agent-relay\bin\agent-relay-helper`);
  });

  test("renders PowerShell helper commands on Windows", () => {
    const instructions = sendImageCapabilityInstructions(String.raw`D:\Code\agent-relay\bin\agent-relay-helper.cmd`, "win32");

    expect(instructions).toContain("```powershell");
    expect(instructions).toContain('& "$env:AGENT_RELAY_HELPER" send-image <screenshot-path>');
    expect(instructions).toContain(String.raw`agent-relay-helper.cmd`);
  });

  test("renders bash helper commands on non-Windows platforms", () => {
    const instructions = sendFileCapabilityInstructions("/repo/bin/agent-relay-helper", "linux");

    expect(instructions).toContain("```bash");
    expect(instructions).toContain('"$AGENT_RELAY_HELPER" send-file <file-path>');
  });

  test("fallback capability instructions inherit the target platform", () => {
    const instructions = relayCapabilityInstructions(String.raw`D:\Code\agent-relay\bin\agent-relay-helper.cmd`, undefined, "win32");

    expect(instructions).toContain('& "$env:AGENT_RELAY_HELPER" send-image');
    expect(instructions).toContain('& "$env:AGENT_RELAY_HELPER" send-file');
  });

  test("mention-agent instructions use the target platform", () => {
    const instructions = mentionAgentCapabilityInstructions(String.raw`D:\Code\agent-relay\bin\agent-relay-helper.cmd`, "Main", ["peer"], "win32");

    expect(instructions).toContain('& "$env:AGENT_RELAY_HELPER" mention-agent <peer-id>');
    expect(instructions).toContain("Configured peer agent ids: peer.");
  });
});
