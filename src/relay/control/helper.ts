import { resolve } from "node:path";

export function resolveRelayHelperPath(runtimeDir: string, platform = process.platform): string {
  const helperPath = resolve(runtimeDir, "..", "..", "bin", "agent-relay-helper");
  return platform === "win32" ? `${helperPath}.cmd` : helperPath;
}
