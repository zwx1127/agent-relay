import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { AgentSendOptions } from "../../../ports/agent.ts";
import type { JsonObject } from "./protocol.ts";

// Native Messages image blocks, as documented by the Agent SDK streaming-input guide.
// Keep a conservative 5 MiB/image and 20 MiB/turn host limit before base64 expansion.
const IMAGE_LIMIT = 5 * 1024 * 1024;
const TURN_IMAGE_LIMIT = 20 * 1024 * 1024;

export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function nativeInput(text: string, options: AgentSendOptions): Promise<string | JsonObject[]> {
  const images: Array<{ path: string; caption?: string }> = [];
  const structuredPaths = new Set<string>();
  for (const attachment of options.attachments ?? []) {
    if (attachment.type !== "localImage") throw new Error("Claude Relay accepts local images only; remote URLs, audio, and other structured attachments are unsupported.");
    images.push({ path: attachment.path, caption: attachment.caption });
    structuredPaths.add(attachment.path);
  }
  for (const image of options.images ?? []) if (!structuredPaths.has(image.path)) images.push(image);
  if (!images.length) return text;
  if (images.length > 20) throw new Error("Attach at most 20 images to a Claude turn.");
  const content: JsonObject[] = [];
  if (text) content.push({ type: "text", text });
  let total = 0;
  for (const image of images) {
    // O_NOFOLLOW prevents symlinks from redirecting an already-authorized local attachment.
    const handle = await open(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > IMAGE_LIMIT) throw new Error("Claude image must be a regular file no larger than 5 MiB.");
      if (total + stat.size > TURN_IMAGE_LIMIT) throw new Error("Claude images exceed the 20 MiB per-turn limit.");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== stat.size) throw new Error("Claude image changed while being read; attach it again.");
      const data = bytes.subarray(0, length), mediaType = imageMime(data);
      if (!mediaType) throw new Error("Claude supports PNG, JPEG, GIF, and WebP images; this file does not have a supported image signature.");
      total += data.length;
      if (image.caption) content.push({ type: "text", text: image.caption });
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
    } finally { await handle.close(); }
  }
  return content;
}
