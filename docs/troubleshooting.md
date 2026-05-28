# Troubleshooting

Use this checklist before opening an issue. Redact credentials, IDs, private paths, prompts, and assistant output from logs.

## The relay does not start

Run:

```bash
bun run typecheck
bun test
bun run start
```

Check:

- `.env` exists and uses the provider you intended.
- `WORKSPACE_ROOT` is an absolute path.
- `ALLOWED_USER_IDS` is set.
- Provider-specific credentials are set.
- The process can write to `.data/` and `logs/` when using `scripts/relay.sh`.

## Codex was not found

Run:

```bash
codex --version
codex app-server --listen stdio://
```

If `codex` is not on `PATH`, set:

```dotenv
CODEX_BIN=/absolute/path/to/codex
```

On Windows, npm-style shims such as `codex.cmd` are supported. If needed, set `CODEX_BIN` to the full `codex.cmd` or `codex.exe` path. Do not include escaped quotes in the value.

## Telegram messages are ignored

Check:

- The sender's Telegram user ID is in `ALLOWED_USER_IDS`.
- If `ALLOWED_CONVERSATION_IDS` is set, the chat ID is included.
- In group chats, text, images, and slash commands mention the bot.
- The bot token belongs to the bot you are messaging.

Telegram startup skips pending updates, so messages sent while the relay was offline are ignored.

## Lark or Feishu messages are ignored

Check:

- `LARK_DOMAIN` matches the developer console: `feishu` or `lark`.
- `ALLOWED_USER_IDS` uses sender `open_id` values.
- `ALLOWED_CONVERSATION_IDS` uses chat `chat_id` values.
- The app has bot messaging enabled.
- The app subscribes to message receive and card action events.
- In group chats, text, image captions, and slash commands mention the bot.

## Buttons or approvals stop working

Try `/relay` to open a fresh Relay Home. If a Codex question or approval expired, answer from the newest card or interrupt the active turn with `/interrupt`.

For Lark/Feishu, confirm that card action events are subscribed and that the app can receive long-connection events.

## Workspace selection fails

Check:

- `WORKSPACE_ROOT` exists and is an absolute path.
- Workspace names do not contain path separators or traversal.
- Workspaces are first-level real directories under `WORKSPACE_ROOT`.
- Symlinked workspaces are not treated as valid workspace directories.

## Images fail

Check:

- A workspace is selected.
- The image is below `MEDIA_MAX_BYTES`.
- File/document attachments are intentionally unsupported, even when the MIME type is an image.
- Relay media under `.agent-relay/media` is not committed or published.

## What to include in a bug report

- OS and shell.
- Bun version.
- Codex CLI version, if available.
- Whether `codex` is available on `PATH`.
- IM provider: Telegram or Lark/Feishu.
- Relevant configuration variable names, with values redacted.
- Redacted logs around the failure.
