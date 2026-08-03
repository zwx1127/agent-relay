import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodexSpawnCommand } from "./spawn.ts";

export function runCommandForOutput(command: CodexSpawnCommand, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.command, command.args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        ...(command.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex --version timed out."));
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`Codex --version exited with code ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}
