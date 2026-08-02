import type { AgentImageInput, AgentInputAttachment, AgentTaskInput } from "../../ports/agent.ts";
import type { RelayTask } from "../types.ts";

export function taskInputFromTask(task: RelayTask): AgentTaskInput {
  if (task.inputJson) {
    try {
      const parsed = JSON.parse(task.inputJson) as Partial<AgentTaskInput>;
      if (typeof parsed.text === "string") {
        return {
          text: parsed.text,
          attachments: Array.isArray(parsed.attachments)
            ? parsed.attachments.map(parseAttachment).filter((attachment): attachment is AgentInputAttachment => Boolean(attachment))
            : undefined,
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
  const counts = new Map<string, number>();
  for (const attachment of input.attachments ?? []) {
    const label = attachment.type === "localImage" || attachment.type === "image"
      ? "image"
      : attachment.type === "localAudio" || attachment.type === "audio"
        ? "audio"
        : attachment.type === "skill"
          ? "skill"
          : "file";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const legacyImageCount = input.images?.length ?? 0;
  if (legacyImageCount > 0) counts.set("image", (counts.get("image") ?? 0) + legacyImageCount);
  const summary = [...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(", ");
  return `${input.text}\n${summary ? `[${summary} attached]\n` : ""}`;
}

function parseAttachment(value: unknown): AgentInputAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "image":
      return typeof record.url === "string" && record.url ? { type: "image", url: record.url, ...(isImageDetail(record.detail) ? { detail: record.detail } : {}) } : undefined;
    case "localImage":
      return typeof record.path === "string" && record.path ? { type: "localImage", path: record.path, ...(typeof record.caption === "string" ? { caption: record.caption } : {}), ...(isImageDetail(record.detail) ? { detail: record.detail } : {}) } : undefined;
    case "audio":
      return typeof record.url === "string" && record.url ? { type: "audio", url: record.url } : undefined;
    case "localAudio":
      return typeof record.path === "string" && record.path ? { type: "localAudio", path: record.path, ...(typeof record.caption === "string" ? { caption: record.caption } : {}), ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}) } : undefined;
    case "skill":
    case "mention":
      return typeof record.name === "string" && record.name && typeof record.path === "string" && record.path
        ? { type: record.type, name: record.name, path: record.path }
        : undefined;
    default:
      return undefined;
  }
}

function isImageDetail(value: unknown): value is "auto" | "low" | "high" | "original" {
  return value === "auto" || value === "low" || value === "high" || value === "original";
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
