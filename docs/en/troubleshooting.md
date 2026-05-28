# Troubleshooting

This page covers the most common setup problems. Do not share bot tokens, app secrets, private paths, prompts, or assistant output in public issues.

## The relay does not start

Check:

- `.env` exists.
- `WORKSPACE_ROOT` is an absolute path.
- `ALLOWED_USER_IDS` is set.
- Provider credentials are set.
- `codex --version` works.

Run:

```bash
bun run typecheck
bun test
bun run start
```

## Codex is not found

If `codex` is not on `PATH`, set a full path:

```dotenv
CODEX_BIN=/absolute/path/to/codex
```

On Windows, `codex.cmd` and `codex.exe` are supported. Use the full path if automatic lookup fails.

## Telegram messages are ignored

Check:

- The sender user ID is in `ALLOWED_USER_IDS`.
- If `ALLOWED_CONVERSATION_IDS` is set, the chat ID is included.
- In groups, the message mentions the bot.
- In groups, `TELEGRAM_BOT_USERNAME` is set if automatic username discovery failed.
- The token belongs to the bot you are messaging.

Messages sent while the relay was offline are skipped on startup.

## Lark or Feishu messages are ignored

Check:

- `LARK_DOMAIN` matches your app: `feishu` or `lark`.
- `ALLOWED_USER_IDS` uses sender `open_id` values.
- `ALLOWED_CONVERSATION_IDS` uses chat `chat_id` values.
- Bot messaging, message receive events, and card action events are enabled.
- In groups, the message mentions the bot.

## Group chat messages are ignored

Check:

- The bot is actually a member of the group.
- The message mentions the bot directly.
- Both the user and the group are allowed when `ALLOWED_CONVERSATION_IDS` is set.
- Slash commands, image captions, and normal text all include the bot mention.
- For multi-agent groups, each bot has its own relay process and its own credentials.

## Buttons stop working

Open a fresh Relay Home with `/relay`.

If Codex is waiting on an old question or approval, answer from the newest card or use `/interrupt`.

## Workspace actions fail

Check:

- `WORKSPACE_ROOT` exists.
- Workspace names are simple directory names.
- Workspaces are real first-level directories under `WORKSPACE_ROOT`.

## Images fail

Check:

- A workspace is selected.
- The image is under `MEDIA_MAX_BYTES`.
- The upload is a real image message, not a document attachment.

## Opening an issue

Include:

- OS and shell.
- Bun version.
- Codex CLI version.
- IM provider: Telegram or Lark/Feishu.
- Redacted `.env` variable names.
- Redacted logs around the failure.
