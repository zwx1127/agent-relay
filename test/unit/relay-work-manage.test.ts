import { describe, expect, test } from "bun:test";
import { linuxShellInstall, loadGatewayManagementConfig, prependPathEntry, removeManagedShellBlock, removePathEntry } from "../../src/gateway/manage.ts";

describe("experimental relay work client environment", () => {
  test("loads Gateway settings without requiring Relay or IM configuration", () => {
    expect(loadGatewayManagementConfig({ EXPERIMENTAL_RELAY_WORK_ENABLED: "true", CODEX_BIN: "/bin/codex" }))
      .toEqual(expect.objectContaining({
        experimentalRelayWorkEnabled: true,
        experimentalRelayGatewayPort: 18765,
        codexBin: "/bin/codex",
        logLevel: "info",
      }));
  });

  test("prepends the Windows proxy directory once and removes it case-insensitively", () => {
    expect(prependPathEntry("C:\\Tools;D:\\Bin", "c:\\tools", "win32")).toBe("c:\\tools;D:\\Bin");
    expect(removePathEntry("C:\\Tools;D:\\Bin", "c:\\tools", "win32")).toBe("D:\\Bin");
  });

  test("preserves unrelated POSIX path entries", () => {
    expect(prependPathEntry("/usr/bin:/opt/bin", "/proxy", "darwin")).toBe("/proxy:/usr/bin:/opt/bin");
    expect(removePathEntry("/proxy:/usr/bin:/opt/bin", "/proxy", "darwin")).toBe("/usr/bin:/opt/bin");
  });

  test("selects only the current supported Linux shell", () => {
    expect(linuxShellInstall("/bin/bash", "/home/test", "/install")).toEqual({
      kind: "bash",
      configPath: "/home/test/.bashrc",
      envFilePath: "/install/client-env.sh",
    });
    expect(linuxShellInstall("/usr/bin/zsh", "/home/test", "/install").configPath).toBe("/home/test/.zshrc");
    expect(linuxShellInstall("/usr/bin/fish", "/home/test", "/install").configPath)
      .toBe("/home/test/.config/fish/conf.d/agent-relay-experimental-relay-work.fish");
    expect(() => linuxShellInstall("/bin/dash", "/home/test", "/install")).toThrow("Bash, Zsh, or Fish");
  });

  test("removes only the managed Linux shell fragment", () => {
    const value = [
      "export BEFORE=1",
      "# >>> agent-relay experimental relay work >>>",
      ". '/install/client-env.sh'",
      "# <<< agent-relay experimental relay work <<<",
      "export AFTER=1",
    ].join("\n");
    expect(removeManagedShellBlock(value)).toContain("export BEFORE=1");
    expect(removeManagedShellBlock(value)).toContain("export AFTER=1");
    expect(removeManagedShellBlock(value)).not.toContain("experimental relay work");
  });
});
