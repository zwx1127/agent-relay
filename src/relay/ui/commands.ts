import type { AgentReviewTarget } from "../../ports/agent.ts";

export function commandName(text: string): string | undefined {
  const [command = ""] = text.split(/\s+/);
  return command.split("@")[0] || undefined;
}

export function commandArgs(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
}

export function parseReviewTarget(args: string): AgentReviewTarget {
  if (!args) return { type: "uncommittedChanges" };
  const [kind = "", second = "", ...rest] = args.split(/\s+/);
  if (kind === "branch" && second) return { type: "baseBranch", branch: second };
  if (kind === "commit" && second) return { type: "commit", sha: second, title: rest.join(" ") || null };
  return { type: "custom", instructions: args };
}
