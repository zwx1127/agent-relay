import { describe, expect, test } from "bun:test";
import { cleanTerminalOutput, splitForTelegram } from "../src/text.ts";

describe("text utilities", () => {
  test("removes ansi and control sequences", () => {
    expect(cleanTerminalOutput("\x1b[31mred\x1b[0m\r\nok\x07")).toBe("red\nok");
  });

  test("splits messages by max length", () => {
    const chunks = splitForTelegram("a".repeat(10), 4);
    expect(chunks).toEqual(["aaaa", "aaaa", "aa"]);
  });
});
