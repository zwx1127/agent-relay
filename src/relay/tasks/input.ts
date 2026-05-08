import type { AgentImageInput, AgentTaskInput } from "../../ports/agent.ts";
import type { RelayTask } from "../types.ts";

export function taskInputFromTask(task: RelayTask): AgentTaskInput {
  if (task.inputJson) {
    try {
      const parsed = JSON.parse(task.inputJson) as Partial<AgentTaskInput>;
      if (typeof parsed.text === "string") {
        return {
          text: parsed.text,
          images: Array.isArray(parsed.images)
            ? parsed.images
              .filter((image): image is AgentImageInput => Boolean(image) && typeof image === "object" && typeof (image as AgentImageInput).path === "string")
              .map((image) => ({ path: image.path, ...(image.caption ? { caption: image.caption } : {}) }))
            : undefined,
        };
      }
    } catch {
      return { text: task.text };
    }
  }
  return { text: task.text };
}

export function transcriptTextForInput(input: AgentTaskInput): string {
  const imageText = input.images?.length ? `\n[${input.images.length} image${input.images.length === 1 ? "" : "s"} attached]\n` : "\n";
  return `${input.text}${imageText}`;
}

export function reactionForTaskStatus(status: RelayTask["status"]): string {
  switch (status) {
    case "waiting":
    case "queued":
      return "🫡";
    case "running":
      return "✍";
    case "blocked":
      return "🤔";
    case "done":
      return "😎";
    case "interrupted":
      return "🤨";
    case "failed":
    case "cancelled":
      return "😱";
  }
}
