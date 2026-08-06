import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Gateway lifecycle script", () => {
  test("exposes only the independent setup/start/stop/status/remove lifecycle", () => {
    const root = process.cwd();
    const result = process.platform === "win32"
      ? spawnSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "scripts", "gateway.ps1"),
        "help",
      ], { cwd: root, encoding: "utf8" })
      : spawnSync(join(root, "scripts", "gateway.sh"), ["help"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("setup|start|stop|status|remove");
    expect(result.stdout).not.toContain("clients-enable");
    expect(result.stdout).not.toContain("desktop-enable");
    expect(result.stdout).not.toContain("gateway-install");
  });
});
