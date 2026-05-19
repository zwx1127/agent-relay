import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries, listVisibleWorkspaceFiles, readVisibleTextFile } from "../../src/relay/workspace-files.ts";

describe("workspace files", () => {
  test("builds directory entries from visible files", () => {
    expect(directoryEntries([
      "README.md",
      "src/index.ts",
      "src/lib/util.ts",
      "test/app.test.ts",
    ], "")).toEqual([
      { kind: "directory", name: "src", path: "src" },
      { kind: "directory", name: "test", path: "test" },
      { kind: "file", name: "README.md", path: "README.md" },
    ]);
    expect(directoryEntries([
      "README.md",
      "src/index.ts",
      "src/lib/util.ts",
    ], "src")).toEqual([
      { kind: "directory", name: "lib", path: "src/lib" },
      { kind: "file", name: "index.ts", path: "src/index.ts" },
    ]);
  });

  test("lists files filtered by gitignore rules without requiring git", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-workspace-files-"));
    try {
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, ".git", "config"), "internal");
      writeFileSync(join(root, ".gitignore"), "ignored.txt\ndist/\n*.log\n*.tmp\n!important.log\n");
      writeFileSync(join(root, "README.md"), "hello");
      writeFileSync(join(root, "ignored.txt"), "hidden");
      writeFileSync(join(root, "debug.log"), "hidden");
      writeFileSync(join(root, "important.log"), "visible");
      writeFileSync(join(root, "dist", "app.js"), "hidden");
      writeFileSync(join(root, "src", ".gitignore"), "!important.tmp\n");
      writeFileSync(join(root, "src", "keep.ts"), "visible");
      writeFileSync(join(root, "src", "drop.tmp"), "hidden");
      writeFileSync(join(root, "src", "important.tmp"), "visible");

      await expect(listVisibleWorkspaceFiles(root)).resolves.toEqual([
        ".gitignore",
        "important.log",
        "README.md",
        "src/.gitignore",
        "src/important.tmp",
        "src/keep.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects ignored, binary, oversized, and symlinked files", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-workspace-files-"));
    try {
      writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(root, "visible.txt"), "hello");
      writeFileSync(join(root, "ignored.txt"), "secret");
      writeFileSync(join(root, "binary.dat"), new Uint8Array([1, 0, 2]));
      writeFileSync(join(root, "large.txt"), "x".repeat(256 * 1024 + 1));
      symlinkSync(join(root, "visible.txt"), join(root, "link.txt"));
      const visibleFiles = await listVisibleWorkspaceFiles(root);

      await expect(readVisibleTextFile(root, "visible.txt", visibleFiles)).resolves.toBe("hello");
      await expect(readVisibleTextFile(root, "ignored.txt", visibleFiles)).rejects.toThrow("ignored or unavailable");
      await expect(readVisibleTextFile(root, "binary.dat", visibleFiles)).rejects.toThrow("binary");
      await expect(readVisibleTextFile(root, "large.txt", visibleFiles)).rejects.toThrow("too large");
      await expect(readVisibleTextFile(root, "link.txt", visibleFiles)).rejects.toThrow("regular file");
      await expect(readVisibleTextFile(root, "../visible.txt", ["../visible.txt"])).rejects.toThrow("Invalid file path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
