import { describe, expect, test } from "bun:test";
import { inputRecord, optionalInputString, requiredInputString } from "../../src/relay/capabilities/input.ts";

describe("capability input parsing", () => {
  test("accepts plain object inputs and rejects other JSON shapes", () => {
    expect(inputRecord({ path: "screen.png" })).toEqual({ path: "screen.png" });
    expect(inputRecord([])).toBeUndefined();
    expect(inputRecord(null)).toBeUndefined();
    expect(inputRecord("screen.png")).toBeUndefined();
  });

  test("normalizes optional strings without changing validation messages", () => {
    expect(optionalInputString({ caption: "  hello  " }, "caption")).toBe("hello");
    expect(optionalInputString({ caption: "   " }, "caption")).toBeUndefined();
    expect(optionalInputString({}, "caption")).toBeUndefined();
    expect(() => optionalInputString({ caption: 1 }, "caption")).toThrow("caption must be a string");
  });

  test("requires non-empty strings", () => {
    expect(requiredInputString({ path: " report.txt " }, "path")).toBe("report.txt");
    expect(() => requiredInputString({}, "path")).toThrow("path is required");
    expect(() => requiredInputString({ path: " " }, "path")).toThrow("path is required");
  });
});
