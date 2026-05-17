import { describe, expect, test } from "bun:test";
import { composeCodexDeveloperInstructions } from "../../src/providers/agents/factory.ts";

describe("agent factory", () => {
  test("composes relay interaction guidance with user and control instructions", () => {
    const instructions = composeCodexDeveloperInstructions("user instructions", "control instructions");

    expect(instructions).toContain("user instructions");
    expect(instructions).toContain("request_user_input");
    expect(instructions).toContain("Do not rely on plain assistant text");
    expect(instructions).toContain("control instructions");
  });
});
