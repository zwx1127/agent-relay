import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKey } from "../src/agent.ts";
import type { AppConfig } from "../src/config.ts";
import { MessageRouter } from "../src/router.ts";
import { Store } from "../src/store.ts";
import type { AgentDriver, AgentSessionStatus, ChatId } from "../src/types.ts";

class FakeAdapter {
  sent: Array<{ chatId: ChatId; text: string }> = [];
  async sendMessage(chatId: ChatId, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

class FakeAgent implements AgentDriver {
  statuses = new Map<string, AgentSessionStatus>();
  sent: Array<{ key: string; text: string }> = [];
  stopped: string[] = [];

  async start(options: { chatId: ChatId; workspaceName: string; workspacePath: string }): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const status = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: 1,
    };
    this.statuses.set(key, status);
    return status;
  }

  async send(key: string, text: string): Promise<void> {
    this.sent.push({ key, text });
  }

  async stop(key: string): Promise<void> {
    this.stopped.push(key);
    this.statuses.delete(key);
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.statuses.get(key);
  }
}

let dirs: string[] = [];

function fixture(): { router: MessageRouter; store: Store; adapter: FakeAdapter; agent: FakeAgent; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-relay-router-root-"));
  const data = mkdtempSync(join(tmpdir(), "agent-relay-router-data-"));
  dirs.push(root, data);
  const store = new Store(join(data, "db.sqlite"));
  const adapter = new FakeAdapter();
  const agent = new FakeAgent();
  const config: AppConfig = {
    telegramBotToken: "token",
    telegramAllowedUserIds: new Set([7]),
    workspaceRoot: root,
    sqlitePath: join(data, "db.sqlite"),
    codexBin: "codex",
    codexSandbox: "workspace-write",
    codexApproval: "on-request",
  };
  return { router: new MessageRouter({ config, store, adapter, agent }), store, adapter, agent, root };
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("router", () => {
  test("rejects unauthorized users", async () => {
    const { router, adapter } = fixture();
    await router.handle({ id: "1", chatId: 1, userId: 99, text: "/help" });
    expect(adapter.sent.at(-1)?.text).toBe("Unauthorized.");
  });

  test("uses existing workspace and auto-starts session for text", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle({ id: "1", chatId: 1, userId: 7, text: "hello codex" });

    expect(agent.sent).toEqual([{ key: "1:demo", text: "hello codex" }]);
    expect(agent.getStatus("1:demo")?.running).toBe(true);
  });

  test("/send forwards command-like text", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");

    await router.handle({ id: "1", chatId: 1, userId: 7, text: "/send /status" });

    expect(agent.sent.at(-1)).toEqual({ key: "1:demo", text: "/status" });
  });

  test("/tail returns agent transcript", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    store.appendTranscript({ chatId: 1, workspaceName: "demo", role: "agent", text: "one\n", createdAt: 1 });

    await router.handle({ id: "1", chatId: 1, userId: 7, text: "/tail" });

    expect(adapter.sent.at(-1)?.text).toBe("one\n");
  });

  test("/exit stops current session", async () => {
    const { router, store, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindChat(1, "demo");
    await agent.start({ chatId: 1, workspaceName: "demo", workspacePath: path });

    await router.handle({ id: "1", chatId: 1, userId: 7, text: "/exit" });

    expect(agent.stopped).toEqual(["1:demo"]);
  });
});
