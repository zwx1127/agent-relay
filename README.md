# agent-relay

Telegram-to-Codex CLI relay built with Bun, TypeScript, SQLite, and Bun's PTY support. It polls Telegram, authorizes messages by allowlist, binds each chat to a local workspace, and runs at most one Codex CLI session per `chat + workspace`.

## Requirements

- Bun 1.3 or newer.
- A Telegram bot token from BotFather.
- A local `codex` CLI binary available on `PATH`, or a custom `CODEX_BIN`.
- Linux or macOS. Bun PTY support is POSIX-only.

## Setup

```bash
bun install
```

Create a local `.env` file:

```bash
cp .env.example .env
```

Then edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces

# Optional: restrict the bot to one or more chats, comma-separated.
# TELEGRAM_ALLOWED_CHAT_IDS=-100123456

SQLITE_PATH=.data/agent-relay.sqlite
CODEX_BIN=codex
CODEX_SANDBOX=workspace-write
CODEX_APPROVAL=on-request
LOG_LEVEL=info
```

Shell environment variables still override values from `.env`.

## Run

```bash
bun run start
```

Development:

```bash
bun run dev
```

## Telegram Commands

- `/help` shows commands.
- `/workspaces` lists known workspaces.
- `/new <name>` creates a workspace under `WORKSPACE_ROOT` and runs `git init`.
- `/use <name>` switches the chat to an existing workspace.
- `/status` shows the current workspace and Codex session state.
- `/tail [n]` returns recent agent output, defaulting to 50 lines.
- `/exit` stops the current Codex PTY.
- `/send <text>` forwards text that starts with `/` to Codex.

Plain text is sent to the current workspace's Codex session. If that session is not running, the relay starts it automatically.

## Runtime Behavior

- Authorization requires `TELEGRAM_ALLOWED_USER_IDS`; if `TELEGRAM_ALLOWED_CHAT_IDS` is set, both user and chat must match.
- Workspace names are limited to letters, numbers, dots, underscores, and dashes.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- `/new <name>` creates the workspace directory and runs `git init`.
- Codex starts with:

```bash
codex --no-alt-screen -C <workspace> -s <CODEX_SANDBOX> -a <CODEX_APPROVAL>
```

- PTY output is stripped of ANSI/control sequences, stored in SQLite, debounced, and split into Telegram-sized messages.
- `/exit` sends Ctrl-C first, then kills the process if it is still alive after 5 seconds.

## Logging

Runtime logs are written to stdout as text lines. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

At `info` and above, logs include operational metadata such as chat ID, user ID, workspace, command name, text length, session key, and process exit status. They do not include the Telegram bot token, Telegram message text, or Codex output.

At `debug`, logs also include raw Telegram messages and Codex input/output chunks. Use it only in environments where those logs are protected.

## Project Structure

```text
src/
  agent.ts       Agent driver interface helpers
  codex.ts       Codex CLI PTY driver
  config.ts      Environment parsing and allowlist checks
  logger.ts      Text stdout logger and log level parsing
  main.ts        Runtime wiring
  router.ts      Telegram command and message routing
  store.ts       SQLite schema and persistence
  telegram.ts    Telegram long polling adapter
  text.ts        Output cleanup and message splitting
  workspace.ts   Workspace validation and creation
test/
  *.test.ts      Unit, routing, adapter, store, and PTY smoke tests
```

## Persistence

SQLite stores:

- workspace records
- chat-to-workspace bindings
- agent session status
- transcript events for user, agent, and system messages

The default database path is `.data/agent-relay.sqlite`.

## Checks

```bash
bun run typecheck
bun test
```
