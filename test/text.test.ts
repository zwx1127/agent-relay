import { describe, expect, test } from "bun:test";
import {
  cleanTerminalOutput,
  formatAgentMarkdownForTelegramHtml,
  formatError,
  formatStatus,
  formatWorkspaces,
  htmlEscape,
  splitForTelegram,
  splitHtmlForTelegram,
} from "../src/text.ts";

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

  test("splits html messages without leaving open tags", () => {
    const chunks = splitHtmlForTelegram(`<pre>${"a".repeat(10)}</pre>`, 13);
    expect(chunks).toEqual(["<pre>aa</pre>", "<pre>aa</pre>", "<pre>aa</pre>", "<pre>aa</pre>", "<pre>aa</pre>"]);
  });

  test("escapes html special characters", () => {
    expect(htmlEscape("<demo>&\"")).toBe("&lt;demo&gt;&amp;&quot;");
  });

  test("formats dynamic html safely", () => {
    expect(formatStatus({ workspaceName: "<ws>&", workspacePath: "/tmp/<ws>&", running: false })).toContain("&lt;ws&gt;&amp;");
    expect(formatWorkspaces([{ name: "<ws>&", selected: true }])).toContain("&lt;ws&gt;&amp;");
    expect(formatError("bad <value>&")).toBe("<b>Error:</b> bad &lt;value&gt;&amp;");
  });

  test("formats common codex markdown as telegram html", () => {
    const formatted = formatAgentMarkdownForTelegramHtml([
      "# Summary",
      "- **Changed** `src/app.ts`",
      "See [docs](https://example.com/docs).",
      "```ts",
      "const value = '<safe>';",
      "```",
    ].join("\n"));

    expect(formatted).toContain("<b>Summary</b>");
    expect(formatted).toContain("• <b>Changed</b> <code>src/app.ts</code>");
    expect(formatted).toContain('<a href="https://example.com/docs">docs</a>');
    expect(formatted).toContain("<pre>const value = '&lt;safe&gt;';</pre>");
  });

  test("escapes raw html in agent markdown", () => {
    expect(formatAgentMarkdownForTelegramHtml("Use <script>alert('&')</script>")).toBe("Use &lt;script&gt;alert('&amp;')&lt;/script&gt;");
  });
});
