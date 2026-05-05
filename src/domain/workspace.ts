import { lstatSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";

export const WORKSPACE_NAME_INVALID_PATTERN = /[\/\\\0-\x1F\x7F]/u;

export interface DiscoveredWorkspace {
  name: string;
  path: string;
}

export function validateWorkspaceName(name: string): void {
  if (name.length === 0) {
    throw new Error("Workspace name cannot be empty.");
  }
  if (name === "." || name === "..") {
    throw new Error("Workspace name cannot be . or ..");
  }
  if (WORKSPACE_NAME_INVALID_PATTERN.test(name)) {
    throw new Error("Workspace name cannot contain slashes, backslashes, NUL, or control characters.");
  }
}

export function resolveWorkspacePath(workspaceRoot: string, name: string): string {
  validateWorkspaceName(name);
  const root = resolve(workspaceRoot);
  const candidate = resolve(join(root, name));
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Workspace path must stay inside WORKSPACE_ROOT.");
  }
  return candidate;
}

export function workspaceDirectoryExists(workspaceRoot: string, name: string): boolean {
  const workspacePath = resolveWorkspacePath(workspaceRoot, name);
  return isRealDirectory(workspacePath);
}

export function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

export async function discoverWorkspaceDirectories(workspaceRoot: string): Promise<DiscoveredWorkspace[]> {
  const root = resolve(workspaceRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        validateWorkspaceName(entry.name);
        return [{ name: entry.name, path: resolveWorkspacePath(root, entry.name) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createWorkspace(workspaceRoot: string, name: string): Promise<string> {
  const workspacePath = resolveWorkspacePath(workspaceRoot, name);
  await mkdir(workspacePath, { recursive: true });
  const proc = Bun.spawn(["git", "init"], {
    cwd: workspacePath,
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
    throw new Error(`git init failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return workspacePath;
}
