import { describe, expect, test } from "bun:test";
import { cleanTerminalOutput, formatError, formatStatus, formatWorkspaces, htmlEscape, splitForTelegram } from "../src/text.ts";

describe("text utilities", () => {
  test("removes ansi and control sequences", () => {
    expect(cleanTerminalOutput("\x1b[31mred\x1b[0m\r\nok\x07")).toBe("red\nok");
  });

  test("removes OSC terminal control sequences", () => {
    expect(cleanTerminalOutput("\x1b[?2004h\x1b[6n\x1b]10;?\x1b\\\x1b]0;agent-relay\x07ready")).toBe("ready");
  });

  test("splits messages by max length", () => {
    const chunks = splitForTelegram("a".repeat(10), 4);
    expect(chunks).toEqual(["aaaa", "aaaa", "aa"]);
  });

  test("escapes html special characters", () => {
    expect(htmlEscape("<demo>&\"")).toBe("&lt;demo&gt;&amp;&quot;");
  });

  test("formats dynamic html safely", () => {
    expect(formatStatus({ workspaceName: "<ws>&", workspacePath: "/tmp/<ws>&", running: false })).toContain("&lt;ws&gt;&amp;");
    expect(formatWorkspaces([{ name: "<ws>&", selected: true }])).toContain("&lt;ws&gt;&amp;");
    expect(formatError("bad <value>&")).toBe("<b>Error:</b> bad &lt;value&gt;&amp;");
  });
});
