# Telegram quickstart

Use this guide when you want to control local Codex from Telegram.

## 1. Prepare local tools

Install or confirm:

- Bun 1.3 or newer.
- Git.
- Codex CLI available as `codex`.

```bash
bun --version
codex --version
```

## 2. Create a bot

1. Open BotFather in Telegram.
2. Create a bot.
3. Copy the bot token.
4. If you will use a group chat, keep the bot username handy.

## 3. Configure agent-relay

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

Edit `.env`:

```dotenv
IM_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=123:abc
ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

For a group bot, also set:

```dotenv
ALLOWED_CONVERSATION_IDS=-100123456
```

## 4. Start and use

```bash
bun run start
```

Then in Telegram:

1. Send `/relay` to the bot.
2. Select or create a workspace.
3. Send a normal message to Codex.
4. Use buttons to answer questions or approve actions.

In groups, mention the bot when sending text, images, or slash commands.

## Useful commands

- `/help`: show commands.
- `/review`: review workspace changes.
- `/plan <prompt>`: ask Codex to plan first.
- `/interrupt`: stop the active turn.
- `/resume`: continue a previous thread.

If setup fails, see [Troubleshooting](troubleshooting.md).
