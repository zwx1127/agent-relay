import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export type RelayMediaKind = "incoming" | "outgoing";
export type RelayFileKind = "incoming" | "outgoing";

const RELAY_DIR = ".agent-relay";
const MEDIA_DIR = "media";
const FILES_DIR = "files";
const RELAY_GITIGNORE = "*\n";

export async function ensureRelayMediaRoot(workspacePath: string): Promise<string> {
  const relayRoot = resolve(workspacePath, RELAY_DIR);
  await ensureDirectory(relayRoot, `${RELAY_DIR} exists but is not a directory.`);
  await writeFile(join(relayRoot, ".gitignore"), RELAY_GITIGNORE, "utf8");
  await ensureDirectory(join(relayRoot, MEDIA_DIR));
  await ensureDirectory(join(relayRoot, MEDIA_DIR, "incoming"));
  await ensureDirectory(join(relayRoot, MEDIA_DIR, "outgoing"));
  return relayRoot;
}

export async function ensureRelayFilesRoot(workspacePath: string): Promise<string> {
  const relayRoot = await ensureRelayRoot(workspacePath);
  await ensureDirectory(join(relayRoot, FILES_DIR));
  await ensureDirectory(join(relayRoot, FILES_DIR, "incoming"));
  await ensureDirectory(join(relayRoot, FILES_DIR, "outgoing"));
  return relayRoot;
}

export async function saveRelayMedia(
  workspacePath: string,
  kind: RelayMediaKind,
  bytes: ArrayBuffer | Uint8Array,
  options: { extension?: string; messageId?: string | number; createdAt?: Date } = {},
): Promise<string> {
  const relayRoot = await ensureRelayMediaRoot(workspacePath);
  const day = utcDay(options.createdAt ?? new Date());
  const dir = join(relayRoot, MEDIA_DIR, kind, day);
  await ensureDirectory(dir);
  const extension = normalizeExtension(options.extension ?? "") || ".jpg";
  const messagePart = options.messageId ? `m${options.messageId}-` : "";
  const filename = `${Date.now()}-${messagePart}${randomBytes(6).toString("hex")}${extension}`;
  const path = join(dir, filename);
  await writeFile(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return path;
}

export async function saveRelayFile(
  workspacePath: string,
  kind: RelayFileKind,
  bytes: ArrayBuffer | Uint8Array,
  options: { filename?: string; messageId?: string | number; createdAt?: Date } = {},
): Promise<string> {
  const relayRoot = await ensureRelayFilesRoot(workspacePath);
  const day = utcDay(options.createdAt ?? new Date());
  const dir = join(relayRoot, FILES_DIR, kind, day);
  await ensureDirectory(dir);
  const messagePart = options.messageId ? `m${options.messageId}-` : "";
  const filename = `${Date.now()}-${messagePart}${randomBytes(6).toString("hex")}-${safeFilename(options.filename ?? "file.bin")}`;
  const path = join(dir, filename);
  await writeFile(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return path;
}

export async function saveGeneratedImage(workspacePath: string, data: string): Promise<string> {
  const parsed = parseImageData(data);
  return await saveRelayMedia(workspacePath, "outgoing", parsed.bytes, { extension: parsed.extension });
}

export async function imageBlobFromPath(path: string): Promise<Blob> {
  const bytes = await readFile(path);
  return new Blob([bytes], { type: mimeTypeForPath(path) });
}

export async function fileBlobFromPath(path: string, mimeType?: string): Promise<Blob> {
  const bytes = await readFile(path);
  return new Blob([bytes], { type: mimeType ?? "application/octet-stream" });
}

export function safeFilename(name: string): string {
  const normalized = basename(name).trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  const collapsed = normalized.replace(/\s+/g, " ").replace(/^\.+/, "");
  return collapsed.slice(0, 160) || "file.bin";
}

export function extensionFromTelegramPath(path: string | undefined): string {
  const extension = normalizeExtension(path ? extname(basename(path)) : "");
  return extension || ".jpg";
}

export function mimeTypeForPath(path: string): string {
  switch (normalizeExtension(extname(path))) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

async function ensureDirectory(path: string, notDirectoryMessage = "Path exists but is not a directory."): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(notDirectoryMessage);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
  }
}

async function ensureRelayRoot(workspacePath: string): Promise<string> {
  const relayRoot = resolve(workspacePath, RELAY_DIR);
  await ensureDirectory(relayRoot, `${RELAY_DIR} exists but is not a directory.`);
  await writeFile(join(relayRoot, ".gitignore"), RELAY_GITIGNORE, "utf8");
  return relayRoot;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  if (lower === ".jpeg") return ".jpg";
  return [".jpg", ".png", ".webp", ".gif"].includes(lower) ? lower : "";
}

function parseImageData(data: string): { bytes: Uint8Array; extension: string } {
  const match = data.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    return {
      bytes: Buffer.from(match[2]!, "base64"),
      extension: extensionForMime(match[1]!),
    };
  }
  return { bytes: Buffer.from(data, "base64"), extension: ".png" };
}

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/png":
    default:
      return ".png";
  }
}
