import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeInput } from "../../src/providers/agents/claude/input.ts";
import { promptContent } from "../../src/providers/agents/dsh/media.ts";
import { DshDriver } from "../../src/providers/agents/dsh/driver.ts";
import type { AgentOutputEvent, AgentSendOptions } from "../../src/ports/agent.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const limits = { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, mediaTypes: ["image/png"] };
function files() {
  const root = mkdtempSync(join(tmpdir(), "native-image-boundary-")); directories.push(root);
  const first = join(root, "first.png"), second = join(root, "second.png");
  writeFileSync(first, png); writeFileSync(second, png);
  return { root, first, second };
}

describe("native image lifecycle and compatibility", () => {
  test("both providers preserve legacy images with empty attachments and deduplicate overlap", async () => {
    const { root, first, second } = files();
    const cases: Array<{ options: AgentSendOptions; count: number }> = [
      { options: { attachments: [], images: [{ path: first }] }, count: 1 },
      { options: { attachments: [{ type: "localImage", path: first }], images: [{ path: first }] }, count: 1 },
      { options: { attachments: [{ type: "localImage", path: first }], images: [{ path: second }] }, count: 2 },
    ];
    for (const { options, count } of cases) {
      const claude = await nativeInput("Image", options);
      expect(Array.isArray(claude) && claude.filter(block => block.type === "image").length).toBe(count);
      expect((await promptContent("Image", options, root, limits)).filter(block => block.type === "image")).toHaveLength(count);
    }
  });

  test("local image intake rejects symlinks before reading a replacement target", async () => {
    if (process.platform === "win32") return;
    const { root, first } = files(); const link = join(root, "link.png"); symlinkSync(first, link);
    await expect(nativeInput("Image", { images: [{ path: link }] })).rejects.toThrow();
    await expect(promptContent("Image", { images: [{ path: link }] }, root, limits)).rejects.toThrow();
  });

  test("an old DSH image fetch cannot release following text into a replacement session", async () => {
    const events: AgentOutputEvent[] = [];
    const driver = new DshDriver({ dshBin: "not-started" }, event => { events.push(event); }, () => undefined);
    let release!: (value: unknown) => void;
    const attachment = new Promise(resolve => { release = resolve; });
    const key = "dsh:1:demo";
    const old = { status: { sessionKey: key, threadId: "old", running: true }, ready: true, cursor: 0 };
    const internals = driver as unknown as {
      sessions: Map<string, unknown>;
      transport: { call(): Promise<unknown> };
      durableEvent(session: unknown, event: unknown, publish: boolean): Promise<void>;
    };
    internals.sessions.set(key, old);
    internals.transport = { call: () => attachment };
    const delivery = internals.durableEvent(old, { seq: 1, type: "assistant/message", data: { message: { content: [
      { type: "image", attachment: { attachmentId: "old-image" } }, { type: "text", text: "STALE_OLD_SESSION_TEXT" },
    ] } } }, true);
    await Promise.resolve();
    internals.sessions.set(key, { status: { sessionKey: key, threadId: "new", running: true } });
    release({ attachment: { mediaType: "image/png" }, data: png.toString("base64") });
    await delivery;
    expect(events).toEqual([]);
  });
});
