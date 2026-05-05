import { isAbsolute, relative, resolve } from "node:path";
import type { InboundMediaFile } from "../../ports/messaging.ts";

export function bestPhoto(photos: InboundMediaFile[]): InboundMediaFile | undefined {
  return [...photos].sort((a, b) => {
    const aSize = a.fileSize ?? a.width * a.height;
    const bSize = b.fileSize ?? b.width * b.height;
    return bSize - aSize;
  })[0];
}

export function pathContains(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncateTelegramCaption(text: string): string {
  return text.length <= 1024 ? text : `${text.slice(0, 1021)}...`;
}
