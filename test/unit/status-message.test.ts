import { describe, expect, test } from "bun:test";
import { formatDetailsMessage, formatTokenContextUsage } from "../../src/relay/ui/status-message.ts";
import type { StatusView } from "../../src/relay/ui/status-view.ts";

describe("relay home status message", () => {
  test("formats token and context usage as numbers", () => {
    expect(formatTokenContextUsage({
      tokenUsage: {
        last: { inputTokens: 30, totalTokens: 7 },
        total: { totalTokens: 420 },
      },
      contextWindow: 100,
    })).toBe("context 30/100 (30%, 70 left); total 420; last 7");
  });

  test("does not calculate context percentage from cumulative tokens", () => {
    expect(formatTokenContextUsage({
      tokenUsage: {
        last: { inputTokens: 30, totalTokens: 7 },
        total: { totalTokens: 420 },
      },
      contextWindow: 100,
    })).not.toContain("420%");
  });

  test("formats partial token and context usage", () => {
    expect(formatTokenContextUsage({ tokenUsage: { total: { totalTokens: 42 } } })).toBe("total 42");
    expect(formatTokenContextUsage({ contextWindow: 100 })).toBe("context 100");
    expect(formatTokenContextUsage({
      tokenUsage: {
        last: { totalTokens: 7 },
        total: { totalTokens: 42 },
      },
      contextWindow: 100,
    })).toBe("context 100; total 42; last 7");
    expect(formatTokenContextUsage({})).toBe("unknown");
  });

  test("does not calculate context percentage for invalid context windows", () => {
    expect(formatTokenContextUsage({
      tokenUsage: {
        last: { totalTokens: 7 },
        total: { totalTokens: 42 },
      },
      contextWindow: 0,
    })).toBe("total 42; last 7");
  });

  test("details view combines token and context usage into one line", () => {
    const rendered = formatDetailsMessage({
      workspaceName: "demo",
      workspacePath: "/tmp/demo",
      running: true,
      tokenUsage: {
        last: { inputTokens: 30, totalTokens: 7 },
        total: { totalTokens: 420 },
      },
      contextWindow: 100,
    } satisfies StatusView);

    expect(rendered.text).toContain("Usage: context 30/100 (30%, 70 left); total 420; last 7");
    expect(rendered.text).not.toContain("Context:");
    expect(rendered.text).not.toContain("Token usage:");
    expect(rendered.text).not.toContain("▰");
    expect(rendered.text).not.toContain("▱");
  });
});
