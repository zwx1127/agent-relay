import { mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";

export const WORKSPACE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function validateWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new Error("Workspace name may only contain letters, numbers, dots, underscores, and dashes.");
  }
  if (name === "." || name === "..") {
    throw new Error("Workspace name cannot be . or ..");
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
