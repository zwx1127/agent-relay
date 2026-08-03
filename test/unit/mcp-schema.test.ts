import { describe, expect, test } from "bun:test";
import { mcpEnumValues, mcpInputHint, parseMcpFieldValue } from "../../src/relay/prompt-flows/mcp-schema.ts";

describe("MCP schema parsing", () => {
  test("reads scalar and array enum values", () => {
    expect(mcpEnumValues({ enum: ["fast", "safe"] })).toEqual(["fast", "safe"]);
    expect(mcpEnumValues({ type: "array", items: { enum: ["a", "b"] } })).toEqual(["a", "b"]);
    expect(mcpInputHint({ type: "array", items: { enum: ["a", "b"] } })).toBe("Enter comma-separated values: a, b");
  });

  test("parses bounded numbers, booleans, and enum arrays", () => {
    expect(parseMcpFieldValue("3", { type: "integer", minimum: 1, maximum: 4 }, true)).toEqual({ value: 3 });
    expect(parseMcpFieldValue("3.5", { type: "integer" }, true)).toBe("Enter a whole number.");
    expect(parseMcpFieldValue("yes", { type: "boolean" }, true)).toEqual({ value: true });
    expect(parseMcpFieldValue("a, b", { type: "array", items: { enum: ["a", "b"] } }, true)).toEqual({ value: ["a", "b"] });
    expect(parseMcpFieldValue("a, c", { type: "array", items: { enum: ["a", "b"] } }, true)).toBe("Allowed values: a, b.");
  });

  test("preserves defaults, optional skips, and string format validation", () => {
    expect(parseMcpFieldValue("", { type: "string", default: "Ada" }, true)).toEqual({ value: "Ada" });
    expect(parseMcpFieldValue("skip", { type: "string" }, false)).toEqual({ value: undefined });
    expect(parseMcpFieldValue("not-an-email", { type: "string", format: "email" }, true)).toBe("Enter a valid email address.");
    expect(parseMcpFieldValue("2026-08-03", { type: "string", format: "date" }, true)).toEqual({ value: "2026-08-03" });
  });
});
