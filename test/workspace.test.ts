import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath, validateWorkspaceName } from "../src/workspace.ts";

describe("workspace", () => {
  test("accepts conservative names", () => {
    expect(() => validateWorkspaceName("repo_1.test-name")).not.toThrow();
  });

  test("rejects traversal and slashes", () => {
    expect(() => validateWorkspaceName("../repo")).toThrow();
    expect(() => validateWorkspaceName("a/b")).toThrow();
    expect(() => validateWorkspaceName("..")).toThrow();
  });

  test("resolves inside root", () => {
    const root = join(tmpdir(), "agent-relay-workspaces");
    expect(resolveWorkspacePath(root, "demo")).toBe(join(root, "demo"));
  });
});
