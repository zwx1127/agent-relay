import { describe, expect, test } from "bun:test";
import { formatUnknownError, parseLogLevel, TextLogger } from "../../src/domain/logger.ts";

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

  test("redacts Telegram bot tokens from string and error fields", () => {
    const lines: string[] = [];
    const error = new Error("unknown certificate verification error for https://api.telegram.org/bot123456:SECRET/sendMessage");
    error.stack = "Error: failed at https://api.telegram.org/file/bot123456:SECRET/photos/image.jpg";
    const logger = new TextLogger("debug", (line) => lines.push(line), () => new Date("2026-05-02T08:00:00.000Z"));

    logger.error("failed", {
      url: "https://api.telegram.org/bot123456:SECRET/sendMessage",
      error,
    });

    expect(lines[0]).not.toContain("123456:SECRET");
    expect(lines[0]).toContain("https://api.telegram.org/bot<redacted>/sendMessage");
    expect(lines[0]).toContain("https://api.telegram.org/file/bot<redacted>/photos/image.jpg");
  });

  test("formats unknown errors without exposing Telegram bot tokens", () => {
    const error = new Error("unknown certificate verification error") as Error & { code: string; path: string };
    error.code = "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR";
    error.path = "https://api.telegram.org/bot123456:SECRET/sendMessage";

    const formatted = formatUnknownError(error);

    expect(formatted).not.toContain("123456:SECRET");
    expect(formatted).toContain("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR");
    expect(formatted).toContain("https://api.telegram.org/bot<redacted>/sendMessage");
  });

  test("parses valid log levels and rejects invalid values", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(() => parseLogLevel("trace")).toThrow("LOG_LEVEL");
  });
});
