import { describe, expect, test } from "bun:test";
import {
  cleanTerminalOutput,
  renderTelegramText,
  renderCodexMarkdownForTelegram,
  splitForTelegram,
  splitHtmlForTelegram,
  splitRenderedForTelegram,
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

  test("renders explicit telegram text entities without HTML escaping", () => {
    const rendered = renderTelegramText([
      { text: "Status", entity: "bold" },
      "\nPath: ",
      { text: "/tmp/<ws>&", entity: "code" },
    ]);

    expect(rendered.text).toBe("Status\nPath: /tmp/<ws>&");
    expect(rendered.entities).toEqual([
      { type: "bold", offset: 0, length: 6 },
      { type: "code", offset: 13, length: 10 },
    ]);
  });

  test("renders codex markdown as telegram entities", () => {
    const rendered = renderCodexMarkdownForTelegram([
      "# Summary",
      "- **Changed** `src/app.ts`",
      "> quoted",
      "See [docs](https://example.com/docs).",
    ].join("\n"));

    expect(rendered.text).toContain("Summary");
    expect(rendered.text).toContain("• Changed src/app.ts");
    expect(rendered.text).toContain("quoted");
    expect(rendered.entities.map((entity) => entity.type)).toEqual(["bold", "bold", "code", "blockquote", "text_link"]);
  });

  test("renders fenced code blocks without fence marker spacing", () => {
    const rendered = renderCodexMarkdownForTelegram([
      "Before",
      "```ts",
      "const value = '<safe>';",
      "```",
      "After",
    ].join("\n"));

    expect(rendered.text).toBe("Before\nconst value = '<safe>';\nAfter");
    expect(rendered.entities).toContainEqual({ type: "pre", offset: 7, length: 23, language: "ts" });
  });

  test("splits rendered text and recalculates entity offsets", () => {
    const chunks = splitRenderedForTelegram({
      text: "abcdef",
      entities: [{ type: "bold", offset: 2, length: 3 }],
    }, 3);

    expect(chunks).toEqual([
      { text: "abc", entities: [{ type: "bold", offset: 2, length: 1 }] },
      { text: "def", entities: [{ type: "bold", offset: 0, length: 2 }] },
    ]);
  });
});
