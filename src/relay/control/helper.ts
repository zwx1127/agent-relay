import { posix, win32 } from "node:path";

export function resolveRelayHelperPath(runtimeDir: string, platform = process.platform): string {
  const pathResolver = platform === "win32" ? win32.resolve : posix.resolve;
  const helperPath = pathResolver(runtimeDir, "..", "..", "bin", "agent-relay-helper");
  return platform === "win32" ? `${helperPath}.cmd` : helperPath;
}
