import { describe, expect, test } from "bun:test";
import { prependPathEntry, removePathEntry } from "../../src/gateway/manage.ts";

describe("experimental seamless client environment", () => {
  test("prepends the Windows proxy directory once and removes it case-insensitively", () => {
    expect(prependPathEntry("C:\\Tools;D:\\Bin", "c:\\tools", "win32")).toBe("c:\\tools;D:\\Bin");
    expect(removePathEntry("C:\\Tools;D:\\Bin", "c:\\tools", "win32")).toBe("D:\\Bin");
  });

  test("preserves unrelated POSIX path entries", () => {
    expect(prependPathEntry("/usr/bin:/opt/bin", "/proxy", "darwin")).toBe("/proxy:/usr/bin:/opt/bin");
    expect(removePathEntry("/proxy:/usr/bin:/opt/bin", "/proxy", "darwin")).toBe("/usr/bin:/opt/bin");
  });
});
