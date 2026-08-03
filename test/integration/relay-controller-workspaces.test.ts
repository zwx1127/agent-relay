import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../support/fakes.ts";
import { callbackMessage, cleanupRelayFixtures, relayFixture as fixture, textMessage } from "../support/relay-fixture.ts";

afterEach(cleanupRelayFixtures);

describe("relay controller workspace UI", () => {
  test("backlog callback is no longer supported", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    store.createTask({ conversationId: "1", workspaceName: "demo", text: "queued work", status: "queued" });

    await router.handle(callbackMessage("ar:queue"));

    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
  });

  test("/relay sends a fresh Relay Home message every time", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    const firstMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(textMessage("/relay"));
    const secondMessageId = adapter.sent.at(-1)?.messageId;

    expect(secondMessageId).not.toBe(firstMessageId);
    expect(store.getConsoleMessageId(1)).toBe(String(secondMessageId));
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.edited).toHaveLength(0);
  });

  test("Relay Home refresh callback edits the current home message", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    await router.handle(textMessage("/relay"));
    const currentMessageId = adapter.sent.at(-1)?.messageId;

    await router.handle(callbackMessage("ar:s", 7, "cb-refresh", currentMessageId));

    expect(store.getConsoleMessageId(1)).toBe(String(currentMessageId));
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.edited.at(-1)?.options.messageId).toBe(currentMessageId);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-refresh", text: undefined });
  });

  test("callback logs include source card and current control card ids", async () => {
    const { router, adapter, logLines, root } = fixture();
    mkdirSync(join(root, "demo"));

    await router.handle(textMessage("/relay"));
    const currentMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces", currentMessageId));

    const logs = logLines.join("\n");
    expect(logs).toContain("router.callback_received");
    expect(logs).toContain('callback_query_id="cb-workspaces"');
    expect(logs).toContain(`message_id=${currentMessageId}`);
    expect(logs).toContain(`console_message_id="${currentMessageId}"`);
    expect(logs).toContain("current_control_card=true");
  });

  test("Relay Home refresh fallback stores the new home message id", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    const currentMessageId = adapter.sent.at(-1)?.messageId;
    adapter.failEditMessage = new Error("card update timed out");

    await router.handle(callbackMessage("ar:s", 7, "cb-refresh", currentMessageId));

    const fallbackMessageId = adapter.sent.at(-1)?.messageId;
    expect(fallbackMessageId).not.toBe(currentMessageId);
    expect(store.getConsoleMessageId(1)).toBe(String(fallbackMessageId));
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-refresh", text: undefined });
  });

  test("Relay Home status mode rolls back when rendering fails", async () => {
    const { router, adapter, store } = fixture();

    await router.handle(textMessage("/relay"));
    const currentMessageId = adapter.sent.at(-1)?.messageId;
    adapter.failEditMessage = new Error("edit failed");
    adapter.failSendMessage = new Error("send failed");

    await router.handle(callbackMessage("ar:status", 7, "cb-details", currentMessageId));

    expect(store.getHomeStatusMode(1)).toBe("compact");
    expect(store.getConsoleMessageId(1)).toBe(String(currentMessageId));
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-details", text: "send failed" });
  });

  test("workspace callback switches binding, auto-starts, and edits status", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    store.upsertWorkspace({ name: "first", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "second", path: second, createdAt: 1 });
    store.bindConversation(1, "first");
    store.markSessionStarted("codex:1:second", 1, "second", 1, "old-second-thread");

    await router.handle(callbackMessage("ar:w"));
    expect(adapter.edited.at(-1)?.text).toContain("✅ first");
    expect(adapter.edited.at(-1)?.text).toContain("⬜ second");
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "second")?.at(1);
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2", adapter.edited.at(-1)?.options.messageId));

    expect(store.getBinding(1)?.workspaceName).toBe("second");
    expect(agent.getStatus("codex:1:second")?.running).toBe(true);
    expect(agent.getStatus("codex:1:second")?.threadId).toBe("thread-1");
    expect(store.getSession("codex:1:second")?.thread_id).toBe("thread-1");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: second");
    expect(adapter.edited.at(-1)?.options.entities?.some((entity) => entity.type === "code")).toBe(true);
    expect(adapter.edited.at(-1)?.options.messageId).toBe(42);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb2", text: undefined });
  });

  test("workspace selection does not switch binding when original card edit fails", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    store.upsertWorkspace({ name: "first", path: first, createdAt: 1 });
    store.upsertWorkspace({ name: "second", path: second, createdAt: 1 });
    store.bindConversation(1, "first");

    await router.handle(callbackMessage("ar:w"));
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "second")?.at(1);
    adapter.failEditMessage = new Error("edit failed");

    await router.handle(callbackMessage(button!.callback_data, 7, "cb-workspace-edit-failed", adapter.edited.at(-1)?.options.messageId));

    expect(store.getBinding(1)?.workspaceName).toBe("first");
    expect(agent.getStatus("codex:1:second")).toBeUndefined();
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-workspace-edit-failed", text: "edit failed" });
  });

  test("workspaces callback discovers existing directories and uses short buttons", async () => {
    const { router, store, adapter, root } = fixture();
    const normal = join(root, "demo");
    const longName = `客户 repo ${"a".repeat(60)}`;
    const longPath = join(root, longName);
    mkdirSync(normal);
    mkdirSync(longPath);
    store.upsertWorkspace({ name: "demo", path: normal, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));

    expect(adapter.edited.at(-1)?.text).toContain(longName);
    expect(adapter.edited.at(-1)?.text).toContain("⬜ demo");
    expect(adapter.edited.at(-1)?.text).toContain(`⬜ ${longName}`);
    expect(store.getWorkspace(longName)?.path).toBe(longPath);
    const demoRow = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "demo");
    expect(demoRow?.map((button) => button.text)).toEqual(["demo", "Select", "Delete"]);
    expect(demoRow?.at(0)?.callback_data.startsWith("ar:wi:0:")).toBe(true);
    expect(demoRow?.at(1)?.callback_data.startsWith("ar:uh:")).toBe(true);
    expect(demoRow?.at(2)?.callback_data.startsWith("ar:wd?:")).toBe(true);
    const callbackData = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.callback_data);
    const createButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:n"));
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");
    const refreshButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:w");
    const footer = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.at(-1)?.map((button) => button.text);
    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(backButton?.text).toBe("Back");
    expect(createButton?.text).toBe("New");
    expect(refreshButton?.text).toBe("Refresh");
    expect(footer).toEqual(["Back", "New", "Refresh"]);
    expect(callbackData?.filter((data) => data.startsWith("ar:uh:"))).toHaveLength(2);
    expect(callbackData?.filter((data) => data.startsWith("ar:wi:0:"))).toHaveLength(2);
    expect(callbackData?.every((data) => new TextEncoder().encode(data).length <= 64)).toBe(true);
  });

  test("workspace fallback card becomes the current control card", async () => {
    const { router, store, adapter, root } = fixture();
    mkdirSync(join(root, "demo"));

    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;
    adapter.failEditMessage = new Error("card update timed out");

    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces-fallback", homeMessageId));

    const fallbackMessageId = adapter.sent.at(-1)?.messageId;
    expect(fallbackMessageId).not.toBe(homeMessageId);
    expect(store.getConsoleMessageId(1)).toBe(String(fallbackMessageId));
    expect(adapter.sent.at(-1)?.text).toContain("Workspaces");
    expect(adapter.sent.at(-1)?.text).not.toContain("Stale Relay Home");

    adapter.failEditMessage = undefined;
    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces-refresh", fallbackMessageId));

    expect(adapter.edited.at(-1)?.options.messageId).toBe(fallbackMessageId);
    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(adapter.edited.at(-1)?.text).not.toContain("Stale Relay Home");
  });

  test("Relay control callbacks are serialized per conversation", async () => {
    const { router, adapter, root } = fixture();
    mkdirSync(join(root, "demo"));
    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;
    const releaseFirstEdit = deferred<void>();
    adapter.editMessageWaits.push(releaseFirstEdit.promise);

    const first = router.handle(callbackMessage("ar:w", 7, "cb-workspaces", homeMessageId));
    await waitUntil(() => adapter.editStarted.length === 1);
    const second = router.handle(callbackMessage("ar:s", 7, "cb-refresh", homeMessageId));
    await sleep(10);

    expect(adapter.editStarted).toHaveLength(1);
    expect(adapter.answered).toEqual([]);

    releaseFirstEdit.resolve();
    await Promise.all([first, second]);

    expect(adapter.editStarted).toHaveLength(2);
    expect(adapter.edited[0]?.text).toContain("Workspaces");
    expect(adapter.edited[1]?.text).toContain("Relay Home");
    expect(adapter.answered.map((answer) => answer.callbackQueryId)).toEqual(["cb-workspaces", "cb-refresh"]);
  });

  test("Relay control queues do not block different conversations", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay", 7, undefined, "1"));
    const firstHomeMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(textMessage("/relay", 7, undefined, "2"));
    const secondHomeMessageId = adapter.sent.at(-1)?.messageId;
    const releaseFirstEdit = deferred<void>();
    adapter.editMessageWaits.push(releaseFirstEdit.promise);

    const first = router.handle(callbackMessage("ar:s", 7, "cb-first", firstHomeMessageId, "1"));
    await waitUntil(() => adapter.editStarted.length === 1);
    const second = router.handle(callbackMessage("ar:s", 7, "cb-second", secondHomeMessageId, "2"));
    await waitUntil(() => adapter.edited.some((edit) => edit.conversationId === "2"));

    expect(adapter.editStarted.map((edit) => edit.conversationId)).toEqual(["1", "2"]);
    releaseFirstEdit.resolve();
    await Promise.all([first, second]);
  });

  test("new workspace reply refreshes source workspace list without opening Relay Home", async () => {
    const { router, store, adapter, agent, root } = fixture();
    mkdirSync(join(root, "existing"));

    await router.handle(callbackMessage("ar:w"));
    const workspacesMessageId = adapter.edited.at(-1)?.options.messageId;
    const createButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "New");

    await router.handle(callbackMessage(createButton!.callback_data, 7, "cb-new", workspacesMessageId));
    const promptId = adapter.sent.at(-1)!.messageId;
    await router.handle(textMessage("demo", 7, promptId));

    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(agent.getStatus("codex:1:demo")?.running).toBe(true);
    expect(adapter.sent.at(-1)?.text).toContain("created and selected");
    expect(adapter.sent.at(-1)?.text).not.toContain("Relay Home");
    expect(adapter.edited.at(-1)?.options.messageId).toBe(workspacesMessageId);
    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(adapter.edited.at(-1)?.text).toContain("✅ demo");
    expect(adapter.edited.at(-1)?.text).not.toContain("Stale Relay Home");
    expect(existsSync(join(root, "demo", ".git"))).toBe(true);
  });

  test("workspace name button opens gitignore-filtered files and text preview", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(join(path, "src"), { recursive: true });
    writeFileSync(join(path, ".gitignore"), "secret.txt\n");
    writeFileSync(join(path, "README.md"), "# Demo\n\nProject summary from README.\n\nMore details.");
    writeFileSync(join(path, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(path, "secret.txt"), "ignored");
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));
    const filesButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wi:0:"));
    expect(filesButton?.text).toBe("demo");

    await router.handle(callbackMessage(filesButton!.callback_data, 7, "cb-files", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Files");
    expect(adapter.edited.at(-1)?.text).toContain("Workspace: demo");
    expect(adapter.edited.at(-1)?.text).toContain("Path: /");
    expect(adapter.edited.at(-1)?.text).toContain("[dir] src/");
    expect(adapter.edited.at(-1)?.text).toContain("[file] README.md");
    expect(adapter.edited.at(-1)?.text).not.toContain("secret.txt");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.at(-1)?.map((button) => button.text)).toEqual(["Back", "Select", "Delete"]);

    const readmeButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "README.md");
    await router.handle(callbackMessage(readmeButton!.callback_data, 7, "cb-file", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("File");
    expect(adapter.edited.at(-1)?.text).toContain("demo");
    expect(adapter.edited.at(-1)?.text).toContain("Path: /README.md");
    expect(adapter.edited.at(-1)?.text).toContain("Project summary from README.");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Back"]);

    const backToDirButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Back");
    await router.handle(callbackMessage(backToDirButton!.callback_data, 7, "cb-file-back", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Files");

    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:wl:0");
    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-files-back", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Workspaces");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text === "demo")?.map((button) => button.text)).toEqual(["demo", "Select", "Delete"]);
  });

  test("workspace files browse non-git workspaces", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    writeFileSync(join(path, "note.txt"), "plain workspace");
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));
    const filesButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wi:0:"));

    await router.handle(callbackMessage(filesButton!.callback_data, 7, "cb-files", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Files");
    expect(adapter.edited.at(-1)?.text).toContain("[file] note.txt");
  });

  test("workspace file preview pages long text and returns to directory", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    writeFileSync(join(path, "long.txt"), Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n"));
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });

    await router.handle(callbackMessage("ar:w"));
    const filesButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wi:0:"));
    await router.handle(callbackMessage(filesButton!.callback_data, 7, "cb-files", adapter.edited.at(-1)?.options.messageId));
    const longButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "long.txt");

    await router.handle(callbackMessage(longButton!.callback_data, 7, "cb-long", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Page 1/");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.at(0)?.map((button) => button.text)).toEqual(["First", "Prev", "Next", "Last"]);

    const nextButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Next");
    await router.handle(callbackMessage(nextButton!.callback_data, 7, "cb-next-file-page", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Page 2/");
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.text === "Back");
    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-long-back", adapter.edited.at(-1)?.options.messageId));
    expect(adapter.edited.at(-1)?.text).toContain("Files");
    expect(adapter.edited.at(-1)?.text).toContain("[file] long.txt");
  });

  test("workspace management back returns to Relay Home", async () => {
    const { router, adapter } = fixture();
    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;

    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces", homeMessageId));
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");
    expect(backButton?.text).toBe("Back");

    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-back", adapter.edited.at(-1)?.options.messageId));

    expect(adapter.edited.at(-1)?.text).toContain("Relay Home");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: none");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Workspaces", "Details", "Refresh"]);
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-back", text: undefined });
  });

  test("workspace delete requires confirmation and removes directory and binding", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:w"));
    const deleteButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd?:"));
    expect(deleteButton?.text).toBe("Delete");

    await router.handle(callbackMessage(deleteButton!.callback_data, 7, "cb-delete?", adapter.edited.at(-1)?.options.messageId));
    expect(existsSync(path)).toBe(true);
    expect(adapter.edited.at(-1)?.text).toContain("Delete workspace?");
    expect(adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().map((button) => button.text)).toEqual(["Delete", "Back"]);

    const confirmButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd!:"));
    await router.handle(callbackMessage(confirmButton!.callback_data, 7, "cb-delete!", adapter.edited.at(-1)?.options.messageId));

    expect(existsSync(path)).toBe(false);
    expect(store.getWorkspace("demo")).toBeUndefined();
    expect(store.getBinding(1)).toBeUndefined();
    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(adapter.edited.at(-1)?.text).toContain("No workspace directories found.");
  });

  test("workspace delete confirmation back returns to Relay Home", async () => {
    const { router, store, adapter, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");

    await router.handle(textMessage("/relay"));
    const homeMessageId = adapter.sent.at(-1)?.messageId;
    await router.handle(callbackMessage("ar:w", 7, "cb-workspaces", homeMessageId));
    const deleteButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data.startsWith("ar:wd?:"));
    await router.handle(callbackMessage(deleteButton!.callback_data, 7, "cb-delete?", adapter.edited.at(-1)?.options.messageId));
    const backButton = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.flat().find((button) => button.callback_data === "ar:home");

    await router.handle(callbackMessage(backButton!.callback_data, 7, "cb-back", adapter.edited.at(-1)?.options.messageId));

    expect(existsSync(path)).toBe(true);
    expect(store.getBinding(1)?.workspaceName).toBe("demo");
    expect(adapter.edited.at(-1)?.text).toContain("Relay Home");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: demo");
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb-back", text: undefined });
  });

  test("/cd without a workspace is rejected as an unknown command", async () => {
    const { router, store, adapter, agent, root } = fixture();

    await router.handle(textMessage("/cd demo"));

    expect(store.getBinding(1)).toBeUndefined();
    expect(agent.getStatus("codex:1:demo")).toBeUndefined();
    expect(adapter.sent.at(-1)?.text).toBe("Unknown command: /cd. Send /help to see supported commands.");
    expect(existsSync(join(root, "demo"))).toBe(false);
  });

  test("hashed workspace callback selects long unicode names", async () => {
    const { router, store, adapter, root } = fixture();
    const workspaceName = `客户 repo ${"a".repeat(60)}`;
    mkdirSync(join(root, workspaceName));

    await router.handle(callbackMessage("ar:w"));
    const button = adapter.edited.at(-1)?.options.replyMarkup?.inline_keyboard.find((row) => row.at(0)?.text.startsWith("客户 repo"))?.at(1);
    expect(button?.callback_data).toMatch(/^ar:uh:/);

    await router.handle(callbackMessage(button!.callback_data, 7, "cb2"));

    expect(store.getBinding(1)?.workspaceName).toBe(workspaceName);
    expect(adapter.edited.at(-1)?.text).toContain("客户 repo");
  });

  test("stop callback stops current workspace and clears selection", async () => {
    const { router, store, adapter, agent, root } = fixture();
    const path = join(root, "demo");
    mkdirSync(path);
    store.upsertWorkspace({ name: "demo", path, createdAt: 1 });
    store.bindConversation(1, "demo");
    await agent.start({ conversationId: "1", workspaceName: "demo", workspacePath: path });

    await router.handle(callbackMessage("ar:stop"));

    expect(agent.stopped).toEqual(["codex:1:demo"]);
    expect(store.getBinding(1)).toBeUndefined();
    expect(store.getCollaborationMode("codex:1:demo")).toBe("default");
    expect(adapter.edited.at(-1)?.text).toContain("workspace: none");
    expect(adapter.answered.at(-1)).toEqual({ callbackQueryId: "cb1", text: undefined });
  });

  test("unknown callback answers and renders formatted error", async () => {
    const { router, adapter } = fixture();
    await router.handle(callbackMessage("ar:nope"));

    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unknown callback." }]);
    expect(adapter.edited.at(-1)?.text).toContain("Error: Unknown callback.");
    expect(adapter.edited.at(-1)?.options.entities?.[0]?.type).toBe("bold");
  });

  test("callback error notices are best effort when Telegram send fails", async () => {
    const { router, adapter, logLines } = fixture();
    adapter.failEditMessage = new Error("edit failed");
    adapter.failSendMessage = new Error("unknown certificate verification error");

    await expect(router.handle(callbackMessage("ar:nope"))).resolves.toBeUndefined();

    expect(adapter.answered).toEqual([{ callbackQueryId: "cb1", text: "Unknown callback." }]);
    expect(logLines.join("\n")).toContain("router.callback_failed");
    expect(logLines.join("\n")).toContain("router.callback_error_notice_failed");
  });

});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await sleep(1);
  }
}
