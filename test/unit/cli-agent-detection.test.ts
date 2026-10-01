import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectAgent } from "../../src/cli/agent-detection.ts";
import { nativeAgentSpawnCommand } from "../../src/providers/agents/native-spawn.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeBinary(output: string, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "relay agent detection ")); roots.push(root);
  const binary = join(root, process.platform === "win32" ? "fake agent.cmd" : "fake agent");
  const log = join(root, "arguments.json");
  const script = join(root, "fixture.cjs");
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${exitCode};`);
  writeFileSync(binary, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}' "$@"\n`);
  chmodSync(binary, 0o700);
  return { root, binary, log };
}

describe("native backend executable detection", () => {
  test("runs only --version with a path containing spaces for all backends", async () => {
    for (const provider of ["codex", "claude", "dsh"] as const) {
      const fixture = fakeBinary(`${provider} 2.1.280\n`);
      const detection = await detectAgent(provider, fixture.binary, fixture.root);
      expect(detection).toMatchObject({ found: true, path: fixture.binary, version: "2.1.280" });
      expect(detection.compatible).toBe(provider !== "dsh");
      expect(JSON.parse(readFileSync(fixture.log, "utf8"))).toEqual(["--version"]);
    }
  });

  test("preserves Codex minimum version checks without assigning them to other agents", async () => {
    const fixture = fakeBinary("native 0.1.0\n");
    expect((await detectAgent("codex", fixture.binary, fixture.root)).compatible).toBe(false);
    expect((await detectAgent("claude", fixture.binary, fixture.root)).compatible).toBe(false);
    expect((await detectAgent("dsh", fixture.binary, fixture.root)).compatible).toBe(false);
  });

  test("reports unknown versions and hides failures instead of claiming compatibility", async () => {
    const unknown = fakeBinary("private output without version\n");
    expect(await detectAgent("claude", unknown.binary, unknown.root)).toEqual({ found: true, path: unknown.binary });
    const failed = fakeBinary("secret output\n", 1);
    expect(await detectAgent("dsh", failed.binary, failed.root)).toEqual({ found: false });
    expect(await detectAgent("dsh", join(failed.root, "missing executable"), failed.root)).toEqual({ found: false });
  });
});

describe("native executable spawn safety", () => {
  test("uses argument arrays on Unix and for Windows native executables", () => {
    const binary = "/native tools/a;echo bad";
    const args = ["--version", "literal && argument"];
    expect(nativeAgentSpawnCommand(binary, args, {}, "linux")).toEqual({ command: binary, args, resolvedBinary: binary });
    const executable = String.raw`C:\native tools\claude.exe`;
    expect(nativeAgentSpawnCommand(executable, args, {}, "win32", (path) => path === executable)).toEqual({ command: executable, args, resolvedBinary: executable });
  });

  test("resolves Windows npm shims and preserves spaces with delayed expansion disabled", () => {
    const shim = String.raw`C:\native tools\claude.cmd`;
    const env = { Path: String.raw`C:\native tools`, PATHEXT: ".EXE;.CMD", ComSpec: String.raw`C:\Windows\System32\cmd.exe` };
    const command = nativeAgentSpawnCommand("claude", ["--version"], env, "win32", (path) => path === shim);
    expect(command.resolvedBinary).toBe(shim);
    expect(command.command).toBe(env.ComSpec);
    expect(command.windowsVerbatimArguments).toBe(true);
    expect(command.args).toEqual(["/d", "/v:off", "/s", "/c", `call "${shim}" --version`]);
  });

  test("rejects expansion and control characters before entering Windows command shims", () => {
    const shim = String.raw`C:\native tools\dsh.cmd`;
    for (const arg of ["%INJECT%", 'unescaped"quote', "bad & argument", "pipe|argument", "paren(argument)", "caret^argument", "redirect>argument", "line\nbreak", "line\rbreak", "null\0byte"]) {
      expect(() => nativeAgentSpawnCommand(shim, [arg], {}, "win32", (path) => path === shim)).toThrow("cannot safely launch");
    }
    const percentPath = String.raw`C:\%TEMP%\dsh.cmd`;
    expect(() => nativeAgentSpawnCommand(percentPath, ["--version"], {}, "win32", () => true)).toThrow("cannot safely launch");
  });
});
