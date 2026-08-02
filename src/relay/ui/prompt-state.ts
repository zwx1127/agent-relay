import type { AgentApprovalKind } from "../../ports/agent.ts";

export function parsePromptPayload(payloadJson: string | undefined): Record<string, unknown> | undefined {
  if (!payloadJson) return undefined;
  try {
    const payload = JSON.parse(payloadJson);
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function asPromptRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function isExpired(prompt: { expiresAt?: number }): boolean {
  return typeof prompt.expiresAt === "number" && prompt.expiresAt < Date.now();
}

export function approvalChoices(kind: AgentApprovalKind, params: unknown): Array<{ action: string; label: string }> {
  if (kind === "legacy_command" || kind === "legacy_patch") return [
    { action: "once", label: "Approve" },
    { action: "decline", label: "Deny" },
  ];
  if (kind === "permissions") return [
    { action: "turn", label: "Allow this turn" },
    { action: "session", label: "Allow this session" },
    { action: "decline", label: "Deny" },
  ];
  const record = asPromptRecord(params);
  const available = Array.isArray(record?.availableDecisions) ? record.availableDecisions : undefined;
  const supports = (decision: string): boolean => !available || available.some((value) => value === decision);
  const choices: Array<{ action: string; label: string }> = [];
  if (supports("accept")) choices.push({ action: "once", label: "Approve once" });
  if (supports("acceptForSession")) choices.push({ action: "session", label: "Approve session" });
  if (record?.proposedExecpolicyAmendment && (!available || available.some((value) => Boolean(asPromptRecord(value)?.acceptWithExecpolicyAmendment)))) {
    choices.push({ action: "exec", label: "Approve command rule" });
  }
  const network = Array.isArray(record?.proposedNetworkPolicyAmendments) ? record.proposedNetworkPolicyAmendments : [];
  for (let index = 0; index < network.length; index += 1) {
    if (!available || available.some((value) => Boolean(asPromptRecord(value)?.applyNetworkPolicyAmendment))) {
      choices.push({ action: `net${index}`, label: `Approve network rule ${index + 1}` });
    }
  }
  if (supports("decline")) choices.push({ action: "decline", label: "Deny" });
  if (supports("cancel")) choices.push({ action: "cancel", label: "Cancel" });
  return choices.length > 0 ? choices : [{ action: "decline", label: "Deny" }];
}

export function approvalResponse(kind: AgentApprovalKind, decision: string | boolean, params: unknown): unknown {
  const action = typeof decision === "boolean" ? (decision ? "once" : "decline") : decision;
  if (kind === "legacy_command" || kind === "legacy_patch") {
    return { decision: action === "once" || action === "session" ? "approved" : "denied" };
  }
  if (kind === "permissions") {
    const record = params && typeof params === "object" ? params as { permissions?: unknown } : {};
    if (action === "turn" || action === "session") return { permissions: record.permissions ?? {}, scope: action };
    return { permissions: {}, scope: "turn" };
  }
  const record = asPromptRecord(params);
  if (action === "once") return { decision: "accept" };
  if (action === "session") return { decision: "acceptForSession" };
  if (action === "exec" && record?.proposedExecpolicyAmendment) {
    return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: record.proposedExecpolicyAmendment } } };
  }
  if (action.startsWith("net")) {
    const index = Number(action.slice(3));
    const amendment = Array.isArray(record?.proposedNetworkPolicyAmendments) ? record.proposedNetworkPolicyAmendments[index] : undefined;
    if (amendment) return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } };
  }
  return { decision: action === "cancel" ? "cancel" : "decline" };
}
