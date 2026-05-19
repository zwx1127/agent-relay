import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries, readTrackedTextFile } from "../../src/relay/workspace-files.ts";

describe("workspace files", () => {
  test("builds directory entries from tracked files", () => {
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

  test("rejects untracked, binary, oversized, and symlinked files", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-relay-workspace-files-"));
    try {
      writeFileSync(join(root, "tracked.txt"), "hello");
      writeFileSync(join(root, "untracked.txt"), "secret");
      writeFileSync(join(root, "binary.dat"), new Uint8Array([1, 0, 2]));
      writeFileSync(join(root, "large.txt"), "x".repeat(256 * 1024 + 1));
      symlinkSync(join(root, "tracked.txt"), join(root, "link.txt"));

      await expect(readTrackedTextFile(root, "tracked.txt", ["tracked.txt"])).resolves.toBe("hello");
      await expect(readTrackedTextFile(root, "untracked.txt", ["tracked.txt"])).rejects.toThrow("not tracked");
      await expect(readTrackedTextFile(root, "binary.dat", ["binary.dat"])).rejects.toThrow("binary");
      await expect(readTrackedTextFile(root, "large.txt", ["large.txt"])).rejects.toThrow("too large");
      await expect(readTrackedTextFile(root, "link.txt", ["link.txt"])).rejects.toThrow("regular file");
      await expect(readTrackedTextFile(root, "../tracked.txt", ["../tracked.txt"])).rejects.toThrow("Invalid file path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
