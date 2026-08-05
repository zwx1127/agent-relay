import { describe, expect, test } from "bun:test";
import {
  assertNoUserRemoteOption,
  isCodexAppServerProxyInvocation,
  isGatewayCliInvocation,
  isNonGatewayAgentInvocation,
  rewriteCodexRemoteArgs,
} from "../../src/gateway/codex-launcher.ts";

describe("experimental seamless Codex launcher", () => {
  test("proxies only the desktop app-server server invocation", () => {
    expect(isCodexAppServerProxyInvocation(["app-server", "--analytics-default-enabled"])).toBe(true);
    expect(isCodexAppServerProxyInvocation(["-c", "model=\"gpt-test\"", "app-server", "--listen", "stdio://"])).toBe(true);
    expect(isCodexAppServerProxyInvocation(["app-server", "daemon", "start"])).toBe(false);
    expect(isCodexAppServerProxyInvocation(["app-server", "--config", "model=\"gpt-test\"", "daemon", "start"])).toBe(false);
    expect(isCodexAppServerProxyInvocation(["app-server", "generate-ts"])).toBe(false);
    expect(isCodexAppServerProxyInvocation(["--version"])).toBe(false);
  });

  test("routes interactive CLI entrypoints through Gateway without requiring --remote", () => {
    expect(isGatewayCliInvocation([])).toBe(true);
    expect(isGatewayCliInvocation(["-C", "/repo", "fix the tests"])).toBe(true);
    expect(isGatewayCliInvocation(["resume", "--last"])).toBe(true);
    expect(isGatewayCliInvocation(["-c", "model=\"gpt-test\"", "fork", "--last"])).toBe(true);
    expect(isGatewayCliInvocation(["exec", "fix the tests"])).toBe(false);
    expect(isGatewayCliInvocation(["e", "fix the tests"])).toBe(false);
    expect(isGatewayCliInvocation(["login"])).toBe(false);
    expect(isGatewayCliInvocation(["--version"])).toBe(false);
    expect(isGatewayCliInvocation(["--help"])).toBe(false);
  });

  test("injects the one configured Gateway endpoint", () => {
    expect(rewriteCodexRemoteArgs(["-C", "/repo"], "ws://127.0.0.1:18765"))
      .toEqual(["--remote", "ws://127.0.0.1:18765", "-C", "/repo"]);
    expect(rewriteCodexRemoteArgs(["resume", "--last"], "ws://127.0.0.1:18765"))
      .toEqual(["resume", "--remote", "ws://127.0.0.1:18765", "--last"]);
    expect(rewriteCodexRemoteArgs(["-c", "model=\"gpt-test\"", "fork", "--last"], "ws://127.0.0.1:18765"))
      .toEqual(["-c", "model=\"gpt-test\"", "fork", "--remote", "ws://127.0.0.1:18765", "--last"]);
  });

  test("removes the public remote mode instead of allowing another endpoint", () => {
    expect(() => assertNoUserRemoteOption(["--remote", "ws://127.0.0.1:18765"])).toThrow("--remote client mode is not available");
    expect(() => assertNoUserRemoteOption(["resume", "--remote=ws://127.0.0.1:9999"])).toThrow("--remote client mode is not available");
    expect(() => assertNoUserRemoteOption(["--remote-auth-token-env", "TOKEN"])).toThrow("--remote client mode is not available");
    expect(() => rewriteCodexRemoteArgs(["--remote", "ws://127.0.0.1:9999"], "ws://127.0.0.1:18765"))
      .toThrow("--remote client mode is not available");
  });

  test("blocks agent processes that cannot connect to the shared Gateway", () => {
    expect(isNonGatewayAgentInvocation(["exec", "fix the tests"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["e", "fix the tests"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["review", "--uncommitted"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["mcp-server"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["remote-control", "start"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["exec-server"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["app-server", "daemon", "start"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["app-server", "--config", "model=\"gpt-test\"", "daemon", "start"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["app-server", "proxy"])).toBe(true);
    expect(isNonGatewayAgentInvocation(["exec", "--help"])).toBe(false);
    expect(isNonGatewayAgentInvocation(["app-server", "generate-ts"])).toBe(false);
    expect(isNonGatewayAgentInvocation(["login"])).toBe(false);
  });
});
