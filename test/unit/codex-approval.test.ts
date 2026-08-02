import { describe, expect, test } from "bun:test";
import { approvalChoices, approvalResponse } from "../../src/relay/ui/prompt-state.ts";

describe("Codex approval decisions", () => {
  test("only renders command decisions advertised by app-server", () => {
    const execAmendment = { command: ["bun", "test"] };
    expect(approvalChoices("command", {
      availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: execAmendment } }, "decline"],
      proposedExecpolicyAmendment: execAmendment,
    })).toEqual([
      { action: "once", label: "Approve once" },
      { action: "exec", label: "Approve command rule" },
      { action: "decline", label: "Deny" },
    ]);
  });

  test("preserves exact exec and network amendment wire shapes", () => {
    const execAmendment = { command: ["bun", "test"] };
    const networkAmendment = { host: "registry.npmjs.org", action: "allow" };
    const params = {
      proposedExecpolicyAmendment: execAmendment,
      proposedNetworkPolicyAmendments: [networkAmendment],
    };

    expect(approvalResponse("command", "exec", params)).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execAmendment } },
    });
    expect(approvalResponse("command", "net0", params)).toEqual({
      decision: { applyNetworkPolicyAmendment: { network_policy_amendment: networkAmendment } },
    });
  });

  test("permission approval returns the requested profile with turn or session scope", () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    expect(approvalResponse("permissions", "turn", { permissions })).toEqual({ permissions, scope: "turn" });
    expect(approvalResponse("permissions", "session", { permissions })).toEqual({ permissions, scope: "session" });
  });
});
