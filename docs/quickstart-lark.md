# Lark/Feishu quickstart

This guide starts agent-relay with Lark or Feishu as the IM provider.

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

## 2. Create a self-built app

Create a self-built app in the Lark or Feishu developer console.

Enable bot messaging and subscribe to:

- message receive events
- card action events

agent-relay uses the official SDK long-connection mode, so it only needs outbound network access. It does not need a public HTTPS callback URL.

## 3. Choose the domain

- Use `LARK_DOMAIN=feishu` for apps created in the Feishu China developer console.
- Use `LARK_DOMAIN=lark` for Lark international.
- A custom HTTPS origin can be used for compatible deployments.

## 4. Find allowed IDs

- `ALLOWED_USER_IDS` should use sender `open_id` values.
- `ALLOWED_CONVERSATION_IDS` should use chat `chat_id` values.

For group deployments, set both values. This prevents unrelated users or chats from controlling the relay.

## 5. Configure `.env`

```dotenv
IM_PROVIDER=lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_DOMAIN=feishu
ALLOWED_USER_IDS=ou_xxx
ALLOWED_CONVERSATION_IDS=oc_xxx
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

## 6. Start the relay

```bash
bun install
bun run start
```

For a background process:

```bash
scripts/relay.sh start
scripts/relay.sh status
```

## 7. Use it from Lark or Feishu

1. Send `/relay` to the bot.
2. Select or create a workspace.
3. Send a normal message to Codex.
4. Use card buttons to answer Codex questions or approve actions.

In group chats, mention the bot in slash commands, text, and image captions.

See [Troubleshooting](troubleshooting.md) if startup, permissions, or card callbacks fail.
