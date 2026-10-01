import { describe, expect, test } from "bun:test";
import { redactNativeDiagnostic } from "../../src/providers/agents/native-redaction.ts";

describe("native diagnostic credential redaction", () => {
  test("redacts labeled Bearer, quoted JSON, prefixed environment secrets and cookie headers", () => {
    for (const diagnostic of [
      "authorization=Bearer fixture_secret",
      '{"token":"fixture_secret"}',
      'ANTHROPIC_API_KEY=fixture_secret',
      "DEEPSEEK_API_KEY='fixture_secret'",
      '{"access_token": "fixture_secret"}',
      "Cookie: session=fixture_secret; csrf=another_secret",
      "Authorization: Bearer fixture_secret",
      'request failed: https://localhost/?token=fixture_secret',
      'apiKey="fixture_secret"',
    ]) {
      const output = redactNativeDiagnostic(new Error(diagnostic));
      expect(output).not.toContain("fixture_secret");
      expect(output).not.toContain("another_secret");
    }
  });
  test("preserves non-sensitive native error meaning", () => {
    expect(redactNativeDiagnostic("Model not found; use /model to select another model.")).toBe("Model not found; use /model to select another model.");
  });
});
