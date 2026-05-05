import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceDirectories, resolveWorkspacePath, validateWorkspaceName, workspaceDirectoryExists } from "../../src/domain/workspace.ts";

describe("workspace", () => {
  test("accepts conservative and unicode names", () => {
    expect(() => validateWorkspaceName("repo_1.test-name")).not.toThrow();
    expect(() => validateWorkspaceName("客户 repo:1")).not.toThrow();
  });

  test("rejects traversal, separators, and control characters", () => {
    expect(() => validateWorkspaceName("")).toThrow();
    expect(() => validateWorkspaceName("../repo")).toThrow();
    expect(() => validateWorkspaceName("a/b")).toThrow();
    expect(() => validateWorkspaceName("a\\b")).toThrow();
    expect(() => validateWorkspaceName("..")).toThrow();
    expect(() => validateWorkspaceName("bad\nname")).toThrow();
  });

  test("resolves inside root", () => {
    const root = join(tmpdir(), "agent-relay-workspaces");
    expect(resolveWorkspacePath(root, "demo")).toBe(join(root, "demo"));
  });

  test("checks only real workspace directories", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-workspaces-"));
    try {
      mkdirSync(join(root, "demo"));
      writeFileSync(join(root, "file"), "");
      symlinkSync(join(root, "demo"), join(root, "linked"));

      expect(workspaceDirectoryExists(root, "demo")).toBe(true);
      expect(workspaceDirectoryExists(root, "file")).toBe(false);
      expect(workspaceDirectoryExists(root, "linked")).toBe(false);
      expect(workspaceDirectoryExists(root, "missing")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discovers valid first-level workspace directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-workspaces-"));
    try {
      mkdirSync(join(root, "demo"));
      mkdirSync(join(root, "客户 repo"));
      mkdirSync(join(root, "bad\nname"));
      mkdirSync(join(root, "demo", "nested"));
      writeFileSync(join(root, "file"), "");
      symlinkSync(join(root, "demo"), join(root, "linked"));

      await expect(discoverWorkspaceDirectories(root)).resolves.toEqual([
        { name: "demo", path: join(root, "demo") },
        { name: "客户 repo", path: join(root, "客户 repo") },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
