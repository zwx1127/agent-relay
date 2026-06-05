#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  const definition = helperCommands[command ?? ""];
  if (!definition) throw new Error(usage());
  const parsed = definition.parse(args);
  const url = requiredEnv("AGENT_RELAY_CONTROL_URL");
  const token = requiredEnv("AGENT_RELAY_CONTROL_TOKEN");
  const response = await fetch(`${url.replace(/\/+$/, "")}/v1/capabilities/${encodeURIComponent(definition.capability)}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(parsed),
  });
  const payload = await response.json().catch(() => undefined) as { ok?: boolean; message?: string; error?: string } | undefined;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `agent-relay returned HTTP ${response.status}`);
  }
  console.log(payload.message || "sent");
}

const helperCommands: Record<string, { capability: string; parse(args: string[]): unknown; usage: string }> = {
  "send-image": {
    capability: "send_image",
    parse: (args) => parsePathCapabilityArgs("send-image", args),
    usage: "agent-relay-helper send-image <path> [--cwd <cwd>] [--session-key <key>] [--caption <text>]",
  },
  "send-file": {
    capability: "send_file",
    parse: (args) => parsePathCapabilityArgs("send-file", args),
    usage: "agent-relay-helper send-file <path> [--cwd <cwd>] [--session-key <key>] [--caption <text>]",
  },
  "mention-agent": {
    capability: "mention_agent",
    parse: parseMentionAgentArgs,
    usage: "agent-relay-helper mention-agent <peer-id> <message> [--cwd <cwd>] [--session-key <key>]",
  },
};

function usage(): string {
  return `usage: ${Object.values(helperCommands).map((definition) => definition.usage).join(" | ")}`;
}

function parsePathCapabilityArgs(command: string, args: string[]): { path: string; cwd?: string; sessionKey?: string; caption?: string } {
  const path = args.shift();
  if (!path || path.startsWith("--")) throw new Error(`${command} requires a path`);
  const result: { path: string; cwd?: string; sessionKey?: string; caption?: string } = { path };
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag || !value) throw new Error(`missing value for ${flag ?? "argument"}`);
    switch (flag) {
      case "--cwd":
        result.cwd = value;
        break;
      case "--session-key":
        result.sessionKey = value;
        break;
      case "--caption":
        result.caption = value;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return result;
}

function parseMentionAgentArgs(args: string[]): { peerId: string; message: string; cwd?: string; sessionKey?: string } {
  const peerId = args.shift();
  const message = args.shift();
  if (!peerId || peerId.startsWith("--")) throw new Error("mention-agent requires a peer id");
  if (!message || message.startsWith("--")) throw new Error("mention-agent requires a message");
  const result: { peerId: string; message: string; cwd?: string; sessionKey?: string } = { peerId, message };
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag || !value) throw new Error(`missing value for ${flag ?? "argument"}`);
    switch (flag) {
      case "--cwd":
        result.cwd = value;
        break;
      case "--session-key":
        result.sessionKey = value;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return result;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
