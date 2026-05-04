# agent-relay

Telegram-to-Codex relay built with Bun, TypeScript, SQLite, and Codex app-server. It polls Telegram, authorizes messages by allowlist, binds each chat to a selected cwd under `WORKSPACE_ROOT`, and runs at most one structured Codex thread per `chat + cwd`.

## Requirements

- Bun 1.3 or newer.
- A Telegram bot token from BotFather.
- A local `codex` CLI binary available on `PATH`, or a custom `CODEX_BIN`.
- A Codex CLI version with `codex app-server --listen stdio://` support.

## Setup

```bash
bun install
```

Create a local `.env` file from the tracked template:

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

TELEGRAM_POLL_TIMEOUT_SECONDS=30
TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS=3
TELEGRAM_RETRY_INITIAL_DELAY_MS=500
TELEGRAM_RETRY_MAX_DELAY_MS=10000

SQLITE_PATH=.data/agent-relay.sqlite
CODEX_BIN=codex
CODEX_SANDBOX=workspace-write
CODEX_APPROVAL=on-request
# Optional Codex instruction injection.
# CODEX_DEVELOPER_INSTRUCTIONS="Extra developer instructions"
# CODEX_DEVELOPER_INSTRUCTIONS_FILE=/absolute/path/to/developer-instructions.md
# CODEX_MODEL_INSTRUCTIONS_FILE=/absolute/path/to/model-instructions.md
LOG_LEVEL=info
```

Shell environment variables override values from `.env`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | | Telegram bot token from BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | | Comma-separated Telegram user IDs allowed to use the relay. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | no | any chat | Optional comma-separated chat IDs; when set, both user and chat must match. |
| `WORKSPACE_ROOT` | yes | | Parent directory containing selectable workspaces. Workspace deletion removes directories under this root. |
| `SQLITE_PATH` | no | `.data/agent-relay.sqlite` | SQLite database path. |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | no | `30` | Telegram long-poll timeout. |
| `TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS` | no | `3` | Retry attempts for transient Telegram API failures. |
| `TELEGRAM_RETRY_INITIAL_DELAY_MS` | no | `500` | Initial Telegram retry backoff. |
| `TELEGRAM_RETRY_MAX_DELAY_MS` | no | `10000` | Maximum Telegram retry backoff. |
| `CODEX_BIN` | no | `codex` | Codex CLI binary. |
| `CODEX_SANDBOX` | no | `workspace-write` | Sandbox policy passed to Codex app-server thread creation. |
| `CODEX_APPROVAL` | no | `on-request` | Approval policy passed to Codex app-server thread creation. |
| `CODEX_DEVELOPER_INSTRUCTIONS_FILE` | no | | File loaded into Codex developer instructions. |
| `CODEX_DEVELOPER_INSTRUCTIONS` | no | | Inline developer instructions appended after file instructions. |
| `CODEX_MODEL_INSTRUCTIONS_FILE` | no | | File loaded into Codex base/model instructions. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error`. |

When both `CODEX_DEVELOPER_INSTRUCTIONS_FILE` and `CODEX_DEVELOPER_INSTRUCTIONS` are set, relay sends Codex the file contents, a blank line, then the inline text. `CODEX_MODEL_INSTRUCTIONS_FILE` is read and sent as Codex base/model instructions. `AGENTS.md` is not injected by relay; Codex discovers it normally from the selected cwd.

## Run

```bash
bun run start
```

Development:

```bash
bun run dev
```

## Telegram Flow

The Telegram interaction is workspace-first. Relay supports these Telegram-side instructions:

| Instruction | When | Behavior |
| --- | --- | --- |
| `/relay` | Always | Opens Relay Home. This is the only slash command reserved by relay. |
| Any ordinary message | No cwd selected | Opens Relay Home so you can choose or create a cwd. |
| Any ordinary message | cwd selected and Codex is idle | Sends the text to Codex as a new `turn/start` input. |
| Any ordinary message | cwd selected and Codex is active | Sends the text to Codex as `turn/steer` input for the active turn. |
| Reply to a Relay form | While a form is pending | Answers the pending workspace or Codex question instead of forwarding the text to Codex. |

Slash-style text other than `/relay` is not handled by relay after a cwd is selected. It is forwarded to Codex exactly like any other prompt.

Telegram inline controls are limited to Relay Home workspace/status/refresh/stop, workspace management, Codex approval decisions, and long-output paging.

## Telegram Interaction

Relay Home is a compact session view. Relay stores the latest home message id for each chat; `/relay` edits that message when possible and sends a replacement only when Telegram rejects the edit. Callbacks from replaced Home messages are treated as stale so older buttons do not accidentally operate on current state.

Relay Home defaults to a compact view with the selected cwd, Codex state, waiting state, and recent relay error. The Status button toggles a per-chat detailed mode with cwd path, thread, model, reasoning, approval/sandbox policy, token/context usage, prompt counts, recent output time, and recent relay error. Dynamic values such as cwd names and paths are rendered as Telegram code entities instead of HTML.

Example home view:

```text
Relay Home

🟢 Running
cwd: agent-relay
Waiting: no
```

Inline action buttons:

- `📂` opens workspace management. You can select an existing cwd, create one with `➕` and ForceReply, or delete one with `➖` after confirmation. Workspace selection buttons keep cwd names visible for clarity and pad short names so list labels visually align in Telegram; action buttons are emoji-only. Deleting physically removes the directory under `WORKSPACE_ROOT`.
- `ℹ️` toggles the current chat between compact and detailed Relay Home modes.
- `🔄` redraws Relay Home.
- `🛑` stops the current cwd's Codex session and clears the cwd selection.
- `✅` and `❌` answer approval prompts.
- `⏮️`, `◀️`, `▶️`, and `⏭️` navigate long assistant output pages.

Codex user-input questions are sent as ForceReply prompts. Codex approval requests keep inline `✅` and `❌` buttons.
Prompt state is shown with a bot reaction on the triggering user message: `🫡` queued, `✍` processing, `🤔` waiting for input or approval, `😎` completed, and `😱` failed or cancelled.

System, home, approval, question, and assistant responses are sent as Telegram text plus message entities instead of HTML parse mode. Dynamic values such as cwd names, paths, and errors are rendered as plain text or code entities, avoiding HTML parse failures while preserving readable formatting.

Codex assistant replies render common Markdown into Telegram text plus message entities, including headings, lists, task lists, blockquotes, emphasis, inline code, code blocks, and HTTP/HTTPS links. Unsupported Markdown is left readable as plain text.

Assistant replies are sent as Telegram replies to the user message that triggered the Codex turn or steering input. During streaming, relay edits one live assistant message for the current visible segment.

Raw Codex terminal output is intentionally hidden from Telegram. Command stdout/stderr, terminal interaction events, app-server startup logs, TUI frames, status bars, and other low-level protocol noise are kept out of the chat. Operational debugging should use service logs instead of an in-chat raw tail.

When Codex asks the user a structured question via `request_user_input`, relay maps it to Telegram UI:

- Questions with options, free-text questions, and secret questions use Telegram ForceReply.
- Multi-question requests are shown sequentially, one question at a time, and relay waits until all answers are collected before replying to Codex.
- Expired prompt replies are marked expired and are not forwarded as normal Codex prompts.

Codex approval requests for commands, file changes, and permissions are shown as concise Telegram messages with `✅` and `❌` buttons. The underlying command output is not sent to Telegram, and the approval card is edited to show the decision while preserving the original request details after a tap.

If Telegram rejects a menu edit, the relay logs a warning and sends a new message instead. Telegram's `message is not modified` edit response is treated as harmless and is not logged as an error, including the HTTP 400 form returned when an edit would leave both text and buttons unchanged. Other edit failures still fall back to sending a new message.

## Runtime Behavior

- Authorization requires `TELEGRAM_ALLOWED_USER_IDS`; if `TELEGRAM_ALLOWED_CHAT_IDS` is set, both user and chat must match.
- On startup, pending Telegram updates are skipped before polling begins, so messages sent while the relay was offline are intentionally ignored.
- Long polling subscribes to Telegram `message` and `callback_query` updates. Normal `getUpdates` calls return and immediately start the next request; transient Telegram failures are retried with exponential backoff.
- cwd names cannot be empty, `.`, `..`, or contain slashes, backslashes, NUL, or control characters.
- cwd names are resolved under `WORKSPACE_ROOT`; path traversal and absolute names are rejected.
- `📂` discovers existing first-level directories under `WORKSPACE_ROOT`; symlinked directories are ignored.
- The new-cwd form creates the directory and runs `git init` only when the directory does not already exist.
- Selecting or creating a cwd immediately starts the Codex thread for that `chat + cwd`. If the session is already running, relay reuses it. If SQLite has a stored Codex `thread_id`, relay resumes it first.
- Deleting a cwd from Workspace management requires a confirmation tap, stops the current chat's session for that cwd, removes the directory, and clears chat bindings that pointed at it.
- Codex starts one app-server process:

```bash
codex app-server --listen stdio://
```

- Each `chat + cwd` starts or resumes a Codex thread with that directory as `cwd`, plus `CODEX_SANDBOX` and `CODEX_APPROVAL`.
- User messages are serialized per `chat + cwd`. When Codex is idle, ordinary text starts a Codex turn with `turn/start`. When a turn is active, ordinary text is sent as `turn/steer`, matching the interactive Codex habit of adding context to the current session. If Codex reports that the locally cached active turn is no longer steerable, relay clears that stale turn id and retries the same input once with `turn/start`.
- Prompt task state is stored in SQLite so active, blocked, completed, and failed turns can be tracked. Prompt status is reflected with Telegram reactions when the original user message id is available. No Telegram controls are exposed for task queues.
- While Codex is waiting for a user-input answer or approval decision, ordinary chat text is not forwarded as a new instruction. The relay prompts the user to reply to the question message or use the approval buttons.
- Assistant output is visually linked back to the triggering Telegram message via reply metadata.
- Assistant message deltas from `item/agentMessage/delta` are stored in SQLite, debounced, and rendered into Telegram-sized output pages.
- Agent output is aggregated per visible interaction segment, flushed after a short quiet period, size/time limit, or `turn/completed`, and usually edits one live Telegram message for the current response.
- User input, Codex approval prompts, and Codex question prompts close the current output segment before later assistant output is shown.
- Long Codex output is rendered as a paged Telegram message with emoji-only navigation buttons instead of flooding the chat with continuation messages. While streaming, the live message follows the newest page; after `turn/completed`, it returns to page 1 for easier reading from the top.
- The `🛑` inline button sends `turn/interrupt` for the current cwd session and clears the chat's cwd selection.

## Logging

Runtime logs are written to stdout as text lines. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

At `info` and above, logs include operational metadata such as chat ID, user ID, workspace, command name, text length, session key, and process exit status. They do not include the Telegram bot token, Telegram message text, or Codex output.

At `debug`, logs also include raw Telegram messages, Codex input text, and Codex output chunks. Use it only in environments where those logs are protected.

Telegram Bot API HTTP errors include Telegram's `description` field when the response body provides one. This makes 400 errors such as malformed HTML, non-editable messages, or other Bot API validation failures visible in `telegram.api_http_error` logs.

## Project Structure

```text
src/
  agent.ts       Agent session-key helpers
  config.ts      Environment parsing and allowlist checks
  logger.ts      Text stdout logger and log level parsing
  main.ts        Runtime wiring
  types.ts       Shared app, Telegram, Codex, and persistence types
  workspace.ts   Workspace validation, discovery, and creation
  codex/         Codex app-server driver and protocol handling
  rendering/     Telegram text entities, Markdown rendering, and splitting
  router/        Telegram message routing, session parsing, callbacks, and UI flow
  storage/       SQLite schema, migrations, and persistence methods
  telegram/      Telegram Bot API adapter, polling, retries, and outbound formatting
test/
  *.test.ts      Unit, routing, adapter, store, app-server protocol, and smoke tests
```

## Persistence

SQLite stores:

- cwd records
- chat-to-cwd bindings
- agent session status and Codex thread IDs
- latest Relay Home message IDs and per-chat compact/detailed status mode
- prompt task state
- transcript events for user, agent, and system messages
- pending ForceReply prompts for cwd creation and Codex questions
- pending Codex approval metadata
- paged assistant output for Telegram navigation

The default database path is `.data/agent-relay.sqlite`.

## Checks

```bash
bun run typecheck
bun test
```
