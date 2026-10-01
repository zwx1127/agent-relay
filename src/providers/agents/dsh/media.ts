import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentSendOptions } from "../../../ports/agent.ts";
import { record, array, integer } from "./protocol.ts";

const MAX_RELAY_IMAGE_BYTES = 32 * 1024 * 1024;
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type MediaType = typeof MEDIA_TYPES[number];
export interface ImageLimits { maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number; mediaTypes: string[] }
export function imageLimits(value: unknown): ImageLimits | undefined {
  const limits = record(value);
  const perImage = integer(limits?.maxImageBytes), count = integer(limits?.maxImagesPerMessage), total = integer(limits?.maxMessageImageBytes);
  if (!perImage || !count || !total) return undefined;
  return { maxImageBytes: Math.min(perImage, MAX_RELAY_IMAGE_BYTES), maxImagesPerMessage: count,
    maxMessageImageBytes: Math.min(total, MAX_RELAY_IMAGE_BYTES), mediaTypes: array(limits?.mediaTypes).filter((v): v is string => typeof v === "string") };
}
function mediaType(bytes: Buffer): MediaType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8,12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("DSH image exceeds the advertised size limit or is not a regular file.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > stat.size || offset > limit) throw new Error("DSH image changed while being read or exceeds the size limit.");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
/** Convert only caller-provided images; arbitrary remote URLs are never fetched. */
export async function promptContent(text: string, options: AgentSendOptions | undefined, cwd: string, limits: ImageLimits | undefined): Promise<Record<string, unknown>[]> {
  const attachments = [...(options?.attachments ?? [])];
  const structuredPaths = new Set(attachments.flatMap(item => item.type === "localImage" ? [item.path] : []));
  for (const image of options?.images ?? []) if (!structuredPaths.has(image.path)) attachments.push({ type: "localImage", ...image });
  if (attachments.some(item => item.type !== "localImage" && item.type !== "image")) throw new Error("DSH Relay accepts text and raster images; this attachment type is unsupported.");
  if (attachments.length && !limits) throw new Error("This DSH session did not advertise image attachment support.");
  if (limits && attachments.length > limits.maxImagesPerMessage) throw new Error("Too many images for this DSH session.");
  const content: Record<string, unknown>[] = text.length ? [{ type: "text", text }] : [];
  let total = 0;
  for (const item of attachments) {
    let bytes: Buffer; let name: string | undefined; let declared: string | undefined;
    if (item.type === "localImage") {
      bytes = await readBounded(resolve(cwd, item.path), limits!.maxImageBytes); name = basename(item.path);
      if (item.caption) content.push({ type: "text", text: item.caption });
    } else if (item.type === "image") {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(item.url);
      if (!match || match[2]!.length > Math.ceil(limits!.maxImageBytes / 3) * 4) throw new Error("DSH requires an uploaded local image or bounded base64 raster data; remote image URLs are not fetched.");
      declared = match[1]; bytes = Buffer.from(match[2]!, "base64");
      if (bytes.toString("base64") !== match[2]) throw new Error("DSH image data is not canonical base64.");
    } else throw new Error("Unsupported DSH attachment.");
    const type = mediaType(bytes);
    if (!type || (declared && type !== declared) || !limits!.mediaTypes.includes(type)) throw new Error("DSH image format is invalid or not supported by this session.");
    total += bytes.length;
    if (bytes.length > limits!.maxImageBytes || total > limits!.maxMessageImageBytes) throw new Error("DSH images exceed the advertised byte limits.");
    content.push({ type: "image", mediaType: type, data: bytes.toString("base64"), ...(name ? { name } : {}) });
  }
  return content;
}
export function validatedImageOutput(value: unknown): { data: string; mimeType: string } | undefined {
  const result = record(value), attachment = record(result?.attachment);
  if (typeof result?.data !== "string" || result.data.length > Math.ceil(MAX_RELAY_IMAGE_BYTES / 3) * 4 || typeof attachment?.mediaType !== "string") return undefined;
  const bytes = Buffer.from(result.data, "base64");
  if (bytes.toString("base64") !== result.data || mediaType(bytes) !== attachment.mediaType) return undefined;
  return { data: result.data, mimeType: attachment.mediaType };
}
