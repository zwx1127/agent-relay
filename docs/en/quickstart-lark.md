# Lark/Feishu quickstart

Use this guide when you want to control local Codex from Lark or Feishu.

## 1. Prepare local tools

Install or confirm:

- Bun 1.3 or newer.
- Git.
- Codex CLI available as `codex`.

```bash
bun --version
codex --version
```

## 2. Create a self-built app

Create a self-built app in the Lark or Feishu developer console.

Enable:

- Bot messaging.
- Message receive events.
- Card action events.
- The message reaction permission (`im:message.reactions:write_only` or `im:message`) if you want task status reactions.

agent-relay uses long-connection delivery, so it does not need a public callback URL.

## 3. Configure agent-relay

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

Edit `.env`:

```dotenv
IM_PROVIDER=lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_DOMAIN=feishu
ALLOWED_USER_IDS=ou_xxx
ALLOWED_CONVERSATION_IDS=oc_xxx
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

Use `LARK_DOMAIN=feishu` for Feishu China apps and `LARK_DOMAIN=lark` for Lark international apps.

## 4. Optional group chat setup

For group chats:

1. Add the bot to the group.
2. Use sender `open_id` values in `ALLOWED_USER_IDS`.
3. Use the group `chat_id` in `ALLOWED_CONVERSATION_IDS`.
4. Mention the bot in text, image/file captions, and slash commands. Keep the bot mention separated by spaces, for example `/relay @RelayBot` or `@RelayBot inspect this`.

Unmentioned group messages are ignored before authorization checks, so normal group traffic will not trigger the relay.

## 5. Start and use

```bash
bun run start
```

Then in Lark or Feishu:

1. Send `/relay` to the bot.
2. Select or create a workspace.
3. Send a normal message to Codex.
4. Use card buttons to answer questions or approve actions.

In groups, mention the bot when sending text, image/file captions, or slash commands. Keep `@BotName` as a separate token with spaces around it.

## 6. Thread and multi-workspace usage

In Lark or Feishu groups, each message thread is an independent relay scope. `ALLOWED_CONVERSATION_IDS` still uses the group `chat_id`, not the thread ID.

To run multiple workspaces in parallel:

1. Start a separate thread for each workspace or workstream.
2. Mention the bot in the thread and send `/relay`.
3. Select a workspace from Relay Home in that thread.
4. Send prompts in each thread. Replies, card buttons, tasks, and Codex output stay in the same thread.

Stopping a session from Relay Home stops only that thread's session and clears that thread's current workspace binding. Other threads in the same group keep their own sessions.

## Useful commands

- `/help`: show commands.
- `/review`: review workspace changes.
- `/plan <prompt>`: ask Codex to plan first.
- `/interrupt`: stop the active turn.
- `/resume`: continue a previous thread.

If setup fails, see [Troubleshooting](troubleshooting.md).
