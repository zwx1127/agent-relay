import { describe, expect, test } from "bun:test";
import { parseLogLevel, TextLogger } from "../../src/domain/logger.ts";

describe("logger", () => {
  test("filters messages below the configured level", () => {
    const lines: string[] = [];
    const logger = new TextLogger("info", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));

    logger.debug("debug_event", { value: "hidden" });
    logger.info("info_event", { value: "shown" });

    expect(lines).toEqual(['2026-05-02T08:00:00.000Z INFO info_event value="shown"']);
  });

  test("serializes error stack only when debug is enabled", () => {
    const infoLines: string[] = [];
    const debugLines: string[] = [];
    const error = new Error("boom");
    const now = () => new Date("2026-05-02T08:00:00.000Z");

    new TextLogger("info", (line) => infoLines.push(line), now).error("failed", { error });
    new TextLogger("debug", (line) => debugLines.push(line), now).error("failed", { error });

    expect(infoLines[0]).toContain('error="boom"');
    expect(infoLines[0]).not.toContain("error_stack=");
    expect(debugLines[0]).toContain('error="boom"');
    expect(debugLines[0]).toContain("error_stack=");
  });

  test("parses valid log levels and rejects invalid values", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(() => parseLogLevel("trace")).toThrow("LOG_LEVEL");
  });
});
