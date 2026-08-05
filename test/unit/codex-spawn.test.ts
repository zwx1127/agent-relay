import { describe, expect, test } from "bun:test";
import { codexAppServerSpawnCommand, codexAppServerWebSocketSpawnCommand, codexVersionSpawnCommand, formatCodexSpawnError, isCodexVersionSupported, parseCodexVersion } from "../../src/providers/agents/codex/spawn.ts";

describe("codex app-server spawn command", () => {
  test("keeps direct spawn behavior on non-Windows platforms", () => {
    expect(codexAppServerSpawnCommand("codex", {}, "linux")).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      resolvedCodexBin: "codex",
    });
    expect(codexAppServerSpawnCommand("codex", {}, "linux").windowsVerbatimArguments).toBeUndefined();
  });

  test("builds the experimental loopback WebSocket app-server command", () => {
    expect(codexAppServerWebSocketSpawnCommand("codex", "ws://127.0.0.1:18765", {}, "linux")).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "ws://127.0.0.1:18765"],
      resolvedCodexBin: "codex",
    });
  });

  test("uses the same resolved binary for version preflight", () => {
    const shim = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.cmd`;
    const command = codexVersionSpawnCommand(shim, { ComSpec: "cmd.exe" }, "win32", (path) => path === shim);

    expect(command).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", String.raw`call "C:\Users\Admin\AppData\Roaming\npm\codex.cmd" --version`],
      resolvedCodexBin: shim,
      windowsVerbatimArguments: true,
    });
  });

  test("parses Codex versions and enforces the 0.145.0 floor", () => {
    expect(parseCodexVersion("codex-cli 0.145.0")).toBe("0.145.0");
    expect(parseCodexVersion("codex 1.2.3-beta.1")).toBe("1.2.3");
    expect(parseCodexVersion("unknown")).toBeUndefined();
    expect(isCodexVersionSupported("0.144.99")).toBe(false);
    expect(isCodexVersionSupported("0.145.0")).toBe(true);
    expect(isCodexVersionSupported("1.0.0")).toBe(true);
  });

  test("resolves a Windows cmd shim from PATH and launches it through cmd.exe", () => {
    const shim = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.cmd`;
    const command = codexAppServerSpawnCommand("codex", {
      Path: String.raw`C:\Windows\System32;C:\Users\Admin\AppData\Roaming\npm`,
      PATHEXT: ".EXE;.CMD",
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    }, "win32", (path) => path === shim);

    expect(command).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: ["/d", "/s", "/c", String.raw`call "C:\Users\Admin\AppData\Roaming\npm\codex.cmd" app-server --listen stdio://`],
      resolvedCodexBin: shim,
      windowsVerbatimArguments: true,
    });
    expect(command.args[3]).not.toContain(String.raw`\"`);
    expect(command.args[3]).toStartWith("call ");
  });

  test("normalizes quoted Windows cmd shim paths before building the cmd command", () => {
    const shim = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.cmd`;
    const command = codexAppServerSpawnCommand(`"${shim}"`, {}, "win32", (path) => path === shim);

    expect(command).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", String.raw`call "C:\Users\Admin\AppData\Roaming\npm\codex.cmd" app-server --listen stdio://`],
      resolvedCodexBin: shim,
      windowsVerbatimArguments: true,
    });
    expect(command.args[3]).not.toContain(String.raw`\"`);
  });

  test("normalizes backslash-escaped quoted Windows cmd shim paths", () => {
    const shim = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.cmd`;
    const command = codexAppServerSpawnCommand(String.raw`\"C:\Users\Admin\AppData\Roaming\npm\codex.cmd\"`, {}, "win32", (path) => path === shim);

    expect(command).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", String.raw`call "C:\Users\Admin\AppData\Roaming\npm\codex.cmd" app-server --listen stdio://`],
      resolvedCodexBin: shim,
      windowsVerbatimArguments: true,
    });
    expect(command.args[3]).not.toContain(String.raw`\"`);
  });

  test("launches a Windows exe directly", () => {
    const exe = String.raw`C:\Tools\codex.exe`;
    const command = codexAppServerSpawnCommand(exe, {}, "win32", (path) => path === exe);

    expect(command).toEqual({
      command: exe,
      args: ["app-server", "--listen", "stdio://"],
      resolvedCodexBin: exe,
    });
    expect(command.windowsVerbatimArguments).toBeUndefined();
  });

  test("normalizes PowerShell npm shims to sibling cmd shims when available", () => {
    const ps1 = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.ps1`;
    const cmd = String.raw`C:\Users\Admin\AppData\Roaming\npm\codex.cmd`;
    const command = codexAppServerSpawnCommand(ps1, {}, "win32", (path) => path === ps1 || path === cmd);

    expect(command.command).toBe("cmd.exe");
    expect(command.resolvedCodexBin).toBe(cmd);
    expect(command.args[3]).toBe(String.raw`call "C:\Users\Admin\AppData\Roaming\npm\codex.cmd" app-server --listen stdio://`);
    expect(command.windowsVerbatimArguments).toBe(true);
  });

  test("formats missing Codex diagnostics with Windows inspection hints", () => {
    const error = new Error("spawn codex ENOENT") as Error & { code: string; path: string };
    error.code = "ENOENT";
    error.path = "codex";

    const formatted = formatCodexSpawnError(error, "codex");

    expect(formatted.message).toContain("Failed to start Codex app-server");
    expect(formatted.message).toContain("where.exe codex");
    expect(formatted.message).toContain("Get-Command codex");
  });
});
