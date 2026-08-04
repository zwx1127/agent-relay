import { describe, expect, test } from "bun:test";
import type { AgentThreadGoal } from "../../src/ports/agent.ts";
import { activityControlActions } from "../../src/relay/activity-controls.ts";
import { activityControlKeyboard } from "../../src/relay/ui/keyboards.ts";

const baseGoal: AgentThreadGoal = {
  threadId: "thread-1",
  objective: "Ship it",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe("activity controls", () => {
  test("a cancellable turn always exposes Interrupt independently of Goal status", () => {
    const expected = {
      active: ["interrupt", "edit", "clear"],
      paused: ["interrupt", "resume", "edit", "clear"],
      blocked: ["interrupt", "resume", "edit", "clear"],
      usageLimited: ["interrupt", "resume", "edit", "clear"],
      budgetLimited: ["interrupt", "edit", "clear"],
      complete: ["interrupt", "edit", "clear"],
    } as const;

    for (const [status, actions] of Object.entries(expected)) {
      expect(activityControlActions({ ...baseGoal, status: status as AgentThreadGoal["status"] }, true)).toEqual([...actions]);
    }
  });

  test("idle controls remain Goal-state-specific", () => {
    expect(activityControlActions({ ...baseGoal, status: "active" }, false)).toEqual(["pause", "edit", "clear"]);
    expect(activityControlActions({ ...baseGoal, status: "paused" }, false)).toEqual(["resume", "edit", "clear"]);
    expect(activityControlActions({ ...baseGoal, status: "complete" }, false)).toEqual(["edit", "clear"]);
    expect(activityControlActions(null, false)).toEqual([]);
  });

  test("Interrupt renders on its own row before Goal controls", () => {
    const keyboard = activityControlKeyboard("token", ["interrupt", "resume", "edit", "clear"]);
    expect(keyboard.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["Interrupt"],
      ["Resume", "Edit", "Clear"],
    ]);
  });
});
