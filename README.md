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

Relay exposes one daily command:

- `/relay` opens the relay control console.

Telegram `/start` is kept as a first-use alias for `/relay`.

Everything else you type is sent directly to Codex in the current workspace, including slash-style text such as `/status`, `/help`, `/model`, and `/review`. This keeps the Telegram chat Codex-first and avoids collisions with Codex's own slash commands.

If no workspace is selected, user input is not forwarded. Relay opens the console so you can select or create a workspace first.

## Telegram Interaction

The relay console shows the selected workspace, Codex running/stopped state, recent output time, and recent relay error. Its inline buttons cover relay-specific actions:

- `Workspaces` opens the workspace list.
- `New workspace` asks for a workspace name with Telegram ForceReply, then creates and selects it.
- `Tail 50` sends recent Codex output.
- `Stop` opens a confirmation view before stopping the current Codex session.
- `Refresh` redraws the console.
- Workspace buttons switch the chat binding and edit the console into the updated status view.

System and console responses use Telegram HTML formatting. Dynamic values such as workspace names, paths, and error details are escaped before rendering.

Codex output and tail responses render common Markdown into Telegram text plus message entities, including headings, lists, task lists, blockquotes, emphasis, inline code, code blocks, and HTTP/HTTPS links. Unsupported Markdown is left readable as plain text.

If Telegram rejects a menu edit, the relay logs a warning and sends a new message instead. Telegram's `message is not modified` edit response is treated as harmless, including the HTTP 400 form returned when an edit would leave both text and buttons unchanged. Other edit failures still fall back to sending a new message.

## Runtime Behavior

- Authorization requires `TELEGRAM_ALLOWED_USER_IDS`; if `TELEGRAM_ALLOWED_CHAT_IDS` is set, both user and chat must match.
- On startup, pending Telegram updates are skipped before polling begins, so messages sent while the relay was offline are intentionally ignored.
- Long polling subscribes to Telegram `message` and `callback_query` updates.
- Workspace names are limited to letters, numbers, dots, underscores, and dashes.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- `New workspace` creates the workspace directory and runs `git init`.
- Codex starts with:

```bash
codex --no-alt-screen -C <workspace> -s <CODEX_SANDBOX> -a <CODEX_APPROVAL>
```

- PTY output is stripped of ANSI/control sequences, stored in SQLite, debounced, and split into Telegram-sized messages.
- Agent output is aggregated per session, flushed after a short quiet period or size/time limit, and usually edits one live Telegram message for the current response.
- Long Codex output is split into continuation messages with Telegram entity offsets recalculated for each chunk.
- The `Stop` inline button sends Ctrl-C first, then kills the process if it is still alive after 5 seconds. It requires a second confirmation tap.

## Logging

Runtime logs are written to stdout as text lines. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

At `info` and above, logs include operational metadata such as chat ID, user ID, workspace, command name, text length, session key, and process exit status. They do not include the Telegram bot token, Telegram message text, or Codex output.

At `debug`, logs also include raw Telegram messages and Codex input/output chunks. Use it only in environments where those logs are protected.

Telegram Bot API HTTP errors include Telegram's `description` field when the response body provides one. This makes 400 errors such as malformed HTML, non-editable messages, or other Bot API validation failures visible in `telegram.api_http_error` logs.

## Project Structure

```text
src/
  agent.ts       Agent driver interface helpers
  codex.ts       Codex CLI PTY driver
  config.ts      Environment parsing and allowlist checks
  logger.ts      Text stdout logger and log level parsing
  main.ts        Runtime wiring
  router.ts      Telegram console and message routing
  store.ts       SQLite schema and persistence
  telegram.ts    Telegram long polling adapter and Bot API calls
  text.ts        Output cleanup, message splitting, and Telegram text rendering helpers
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
- pending ForceReply prompts for workspace creation

The default database path is `.data/agent-relay.sqlite`.

## Checks

```bash
bun run typecheck
bun test
```
