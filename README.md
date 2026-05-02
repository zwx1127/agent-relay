# agent-relay

Telegram-to-Codex relay built with Bun, TypeScript, SQLite, and Codex app-server. It polls Telegram, authorizes messages by allowlist, binds each chat to a local workspace, and runs at most one structured Codex thread per `chat + workspace`.

## Requirements

- Bun 1.3 or newer.
- A Telegram bot token from BotFather.
- A local `codex` CLI binary available on `PATH`, or a custom `CODEX_BIN`.
- A Codex CLI version with `codex app-server --listen stdio://` support.

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
- `New workspace` asks for a workspace name with Telegram ForceReply, then selects an existing directory under `WORKSPACE_ROOT` or creates and selects a new one.
- `Stop` opens a confirmation view before stopping the current Codex session.
- `Refresh` redraws the console.
- Workspace buttons switch the chat binding and edit the console into the updated status view.

System and console responses use Telegram HTML formatting. Dynamic values such as workspace names, paths, and error details are escaped before rendering.

Codex assistant replies render common Markdown into Telegram text plus message entities, including headings, lists, task lists, blockquotes, emphasis, inline code, code blocks, and HTTP/HTTPS links. Unsupported Markdown is left readable as plain text.

Raw Codex terminal output is intentionally hidden from Telegram. Command stdout/stderr, terminal interaction events, app-server startup logs, TUI frames, status bars, and other low-level protocol noise are kept out of the chat. Operational debugging should use service logs instead of an in-chat raw tail.

When Codex asks the user a structured question via `request_user_input`, relay maps it to Telegram UI:

- Questions with options are sent with inline keyboard buttons.
- Free-text, secret, and `Other` answers use Telegram ForceReply.
- Multi-question requests wait until all answers are collected before replying to Codex.
- Expired prompt replies are marked expired and are not forwarded as normal Codex prompts.

Codex approval requests for commands, file changes, and permissions are shown as short Telegram messages with `Approve` and `Deny` buttons. The underlying command output is not sent to Telegram.

If Telegram rejects a menu edit, the relay logs a warning and sends a new message instead. Telegram's `message is not modified` edit response is treated as harmless, including the HTTP 400 form returned when an edit would leave both text and buttons unchanged. Other edit failures still fall back to sending a new message.

## Runtime Behavior

- Authorization requires `TELEGRAM_ALLOWED_USER_IDS`; if `TELEGRAM_ALLOWED_CHAT_IDS` is set, both user and chat must match.
- On startup, pending Telegram updates are skipped before polling begins, so messages sent while the relay was offline are intentionally ignored.
- Long polling subscribes to Telegram `message` and `callback_query` updates.
- Workspace names cannot be empty, `.`, `..`, or contain slashes, backslashes, NUL, or control characters.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- `Workspaces` discovers existing first-level directories under `WORKSPACE_ROOT`; symlinked directories are ignored.
- `New workspace` creates the workspace directory and runs `git init` only when the directory does not already exist.
- Codex starts one app-server process:

```bash
codex app-server --listen stdio://
```

- Each `chat + workspace` starts or resumes a Codex thread with the workspace `cwd`, `CODEX_SANDBOX`, and `CODEX_APPROVAL`.
- User messages start a new turn with `turn/start`; messages sent while a turn is active are sent with `turn/steer`.
- Assistant message deltas from `item/agentMessage/delta` are stored in SQLite, debounced, and rendered into Telegram-sized output pages.
- Agent output is aggregated per visible interaction segment, flushed after a short quiet period, size/time limit, or `turn/completed`, and usually edits one live Telegram message for the current response.
- User input, Codex approval prompts, and Codex question prompts close the current output segment before later assistant output is shown.
- Long Codex output is rendered as a paged Telegram message with Previous/Next buttons instead of flooding the chat with continuation messages.
- The `Stop` inline button sends `turn/interrupt` for the active turn. It requires a second confirmation tap.

## Logging

Runtime logs are written to stdout as text lines. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

At `info` and above, logs include operational metadata such as chat ID, user ID, workspace, command name, text length, session key, and process exit status. They do not include the Telegram bot token, Telegram message text, or Codex output.

At `debug`, logs also include raw Telegram messages and Codex input text. Use it only in environments where those logs are protected.

Telegram Bot API HTTP errors include Telegram's `description` field when the response body provides one. This makes 400 errors such as malformed HTML, non-editable messages, or other Bot API validation failures visible in `telegram.api_http_error` logs.

## Project Structure

```text
src/
  agent.ts       Agent driver interface helpers
  codex.ts       Codex app-server JSON-RPC driver
  config.ts      Environment parsing and allowlist checks
  logger.ts      Text stdout logger and log level parsing
  main.ts        Runtime wiring
  router.ts      Telegram console and message routing
  store.ts       SQLite schema and persistence
  telegram.ts    Telegram long polling adapter and Bot API calls
  text.ts        Output cleanup, message splitting, and Telegram text rendering helpers
  workspace.ts   Workspace validation, discovery, and creation
test/
  *.test.ts      Unit, routing, adapter, store, app-server protocol, and smoke tests
```

## Persistence

SQLite stores:

- workspace records
- chat-to-workspace bindings
- agent session status and Codex thread IDs
- transcript events for user, agent, and system messages
- pending ForceReply prompts for workspace creation and Codex questions
- pending Codex approval metadata

The default database path is `.data/agent-relay.sqlite`.

## Checks

```bash
bun run typecheck
bun test
```
