import { existsSync } from "node:fs";
import { codexSpawnCommand } from "./codex/spawn.ts";

export interface NativeAgentSpawnCommand {
  command: string;
  args: string[];
  resolvedBinary: string;
  windowsVerbatimArguments?: boolean;
}

/** argv-only execution, with the same Windows npm-shim resolution as Codex. */
export function nativeAgentSpawnCommand(
  binary: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): NativeAgentSpawnCommand {
  const command = codexSpawnCommand(binary, args, env, platform, exists);
  if (command.windowsVerbatimArguments) {
    // cmd's CALL does another expansion pass. Refuse characters that cannot be
    // safely transported through an npm shim instead of interpreting them.
    if ([command.resolvedCodexBin, ...args].some((value) => /[%"^&()<>|\u0000-\u001f\u007f]/.test(value))) {
      throw new Error("Windows command shims cannot safely launch with shell metacharacters or control characters. Use a native executable path instead.");
    }
    command.args.splice(1, 0, "/v:off");
  }
  return {
    command: command.command,
    args: command.args,
    resolvedBinary: command.resolvedCodexBin,
    ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}
