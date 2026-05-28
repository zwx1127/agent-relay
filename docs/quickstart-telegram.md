# Telegram quickstart

This guide starts agent-relay with Telegram as the IM provider.

## 1. Install local prerequisites

- Bun 1.3 or newer.
- Git.
- A local `codex` CLI on `PATH`, or a full path set with `CODEX_BIN`.
- A Codex CLI version that supports `codex app-server --listen stdio://`.

Check the local tools:

```bash
bun --version
codex --version
```

## 2. Create a Telegram bot

1. Open BotFather in Telegram.
2. Create a bot and copy the bot token.
3. If you will use group chats, note the bot username.

## 3. Find allowed IDs

Set `ALLOWED_USER_IDS` to the Telegram numeric user IDs that may control the relay.

For group deployments, also set `ALLOWED_CONVERSATION_IDS` to the group chat ID so unrelated chats cannot use the bot.

## 4. Configure `.env`

```dotenv
IM_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=123:abc
ALLOWED_USER_IDS=123456
ALLOWED_CONVERSATION_IDS=-100123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

`ALLOWED_CONVERSATION_IDS` is optional for private-chat use, but recommended for groups or shared bots.

## 5. Start the relay

```bash
bun install
bun run start
```

For a background process:

```bash
scripts/relay.sh start
scripts/relay.sh status
```

## 6. Use it from Telegram

1. Send `/relay` to the bot.
2. Select or create a workspace.
3. Send a normal message to Codex.
4. Use inline buttons to answer Codex questions or approve actions.

In groups, mention the bot in slash commands, text, and image captions.

## Common next steps

- Use `/help` to list supported commands.
- Use `/review` to review uncommitted workspace changes.
- Use `/plan <prompt>` to run a prompt in Plan mode.
- Use `/interrupt` if an active turn should stop.

See [Troubleshooting](troubleshooting.md) if startup or bot delivery fails.
