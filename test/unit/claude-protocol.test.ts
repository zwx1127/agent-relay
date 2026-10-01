import { describe, expect, test } from "bun:test";
import { commandsFrom, elicitationSchema, isSessionId, isSupportedClaudeVersion, parseClaudeVersion, questionAnswer, questionsFrom, safeMessage, validateElicitationContent } from "../../src/providers/agents/claude/protocol.ts";

describe("Claude native protocol helpers", () => {
  test("parses the official version output and fences unsupported protocol versions", () => {
    expect(parseClaudeVersion("2.1.285 (Claude Code)\n")).toBe("2.1.285");
    expect(parseClaudeVersion("unknown build")).toBeUndefined();
    expect(isSupportedClaudeVersion("2.1.280")).toBe(true);
    expect(isSupportedClaudeVersion("2.1.285")).toBe(true);
    expect(isSupportedClaudeVersion("2.1.279")).toBe(false);
    expect(isSupportedClaudeVersion("3.0.0")).toBe(false);
  });
  test("keeps native command aliases and arguments without accepting shell syntax", () => {
    expect(commandsFrom([{ name: "code-review", description: "Review", aliases: ["review"], argumentHint: "[pr#]" }]))
      .toEqual([{ command: "code-review", description: "Review [pr#]", availability: "supported" }, { command: "review", description: "Review [pr#]", availability: "supported" }]);
    expect(commandsFrom(["$(curl bad)", "space name", "plugin:scan"])).toHaveLength(1);
    expect(isSessionId("--help")).toBe(false);
  });
  test("maps question IDs back to native question-text keys and preserves multi-select", () => {
    const input = { questions: [
      { header: "Format", question: "Format?", multiSelect: false, options: [{ label: "Summary", description: "Short" }] },
      { header: "Sections", question: "Sections?", multiSelect: true, options: [{ label: "Intro" }, { label: "End" }] },
    ] };
    expect(questionsFrom(input)[1]?.multiSelect).toBe(true);
    expect(questionAnswer(input, { answers: { "question-0": { answers: ["Custom format"] }, "question-1": { answers: ["Intro", "End"] } } }))
      .toEqual({ ...input, answers: { "Format?": "Custom format", "Sections?": ["Intro", "End"] } });
    expect(() => questionAnswer(input, { answers: { "question-0": { answers: ["a", "b"] } } })).toThrow("one answer");
    expect(() => questionsFrom({ questions: [{ question: "Same", options: [] }, { question: "Same", options: [] }] })).toThrow("duplicate");
  });
  test("redacts diagnostics containing auth links and tokens", () => {
    const value = safeMessage(new Error("failed https://login.example/callback?token=secret Bearer abc sk-ant-secret api_key=private"));
    expect(value).not.toContain("secret"); expect(value).not.toContain("private"); expect(value).not.toContain("abc");
    expect(value).toContain("failed");
  });
  test("accepts only renderable native forms and validates required fields on response", () => {
    expect(elicitationSchema({ type: "object", properties: { secret: { $ref: "#/secret" } } })).toBeUndefined();
    const schema = elicitationSchema({ type: "object", properties: { name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 1, maximum: 4 } }, required: ["name"] })!;
    expect(() => validateElicitationContent(schema, { count: 1 })).toThrow("Missing required");
    expect(() => validateElicitationContent(schema, { name: "a", count: 2 })).toThrow("Invalid");
    expect(() => validateElicitationContent(schema, { name: "ok", count: 5 })).toThrow("Invalid");
    expect(validateElicitationContent(schema, { name: "ok", count: 4 })).toEqual({ name: "ok", count: 4 });
  });
});
