# agent-relay

`agent-relay` connects a Telegram bot to the local Codex app-server. It lets approved Telegram users select a workspace under `WORKSPACE_ROOT`, send prompts to Codex, answer Codex questions, approve requested actions, and manage Codex threads from Telegram.

The project is built with Bun, TypeScript, SQLite, and the `codex app-server --listen stdio://` protocol.

## Requirements

- Bun 1.3 or newer.
- Git, used when creating a new workspace directory.
- A Telegram bot token from BotFather.
- A local `codex` CLI binary on `PATH`, or a custom `CODEX_BIN`.
- A Codex CLI version that supports `codex app-server --listen stdio://`.

## Quick Start

Install dependencies:

```bash
bun install
```

Create and edit a local environment file:

```bash
cp .env.example .env
```

Minimum required configuration:

```dotenv
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

Start the relay:

```bash
bun run start
```

For development with file watching:

```bash
bun run dev
```

The relay loads `.env` first, then overlays shell environment variables, so exported variables take precedence over values in the file.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | | Bot token from BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | | Comma-separated Telegram user IDs allowed to use the bot. |
| `WORKSPACE_ROOT` | yes | | Parent directory containing selectable cwd directories. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | no | any chat | Optional comma-separated chat IDs. When set, both user and chat must be allowed. |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | no | `30` | Telegram long-poll timeout. |
| `TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS` | no | `3` | Retry attempts for non-polling Telegram API calls. |
| `TELEGRAM_RETRY_INITIAL_DELAY_MS` | no | `500` | Initial retry backoff for transient Telegram API failures. |
| `TELEGRAM_RETRY_MAX_DELAY_MS` | no | `10000` | Maximum Telegram retry backoff. |
| `TELEGRAM_IMAGE_MAX_BYTES` | no | `20971520` | Maximum Telegram photo download size in bytes. |
| `SQLITE_PATH` | no | `.data/agent-relay.sqlite` | SQLite database path. Parent directories are created automatically. |
| `CODEX_BIN` | no | `codex` | Codex CLI executable. |
| `CODEX_SANDBOX` | no | `workspace-write` | Sandbox policy passed to Codex thread start, resume, and fork calls. |
| `CODEX_APPROVAL` | no | `on-request` | Approval policy passed to Codex thread start, resume, and fork calls. |
| `CODEX_DEVELOPER_INSTRUCTIONS_FILE` | no | | File loaded into Codex developer instructions. |
| `CODEX_DEVELOPER_INSTRUCTIONS` | no | | Inline developer instructions appended after file instructions. |
| `CODEX_MODEL_INSTRUCTIONS_FILE` | no | | File loaded into Codex base/model instructions. |
| `RELAY_CONTROL_ENABLED` | no | `false` | Enables the local Codex-to-relay capability API on `127.0.0.1`. |
| `RELAY_CONTROL_PORT` | no | `0` | Local capability API port. `0` asks the OS to choose an available port. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, or `error`. |

When both `CODEX_DEVELOPER_INSTRUCTIONS_FILE` and `CODEX_DEVELOPER_INSTRUCTIONS` are set, file contents are sent first, then a blank line, then the inline text. `CODEX_MODEL_INSTRUCTIONS_FILE` is sent as Codex base instructions. The relay does not inject `AGENTS.md`; Codex discovers it normally from the selected cwd.

## Telegram Usage

Send `/relay` to open Relay Home. Relay Home shows the selected cwd, Codex status, waiting state, and recent errors. The detail toggle shows thread, model, approval/sandbox policy, token usage, context usage, prompt counts, and recent output timing.

Relay Home actions:

- Workspace: select an existing first-level directory under `WORKSPACE_ROOT`, create a new cwd through ForceReply, or delete a cwd after confirmation.
- Status: toggle compact and detailed status views for the chat.
- Refresh: redraw the current Relay Home message.
- Stop: interrupt the current cwd session and clear the chat's cwd selection.

After a cwd is selected, ordinary Telegram messages are sent to Codex. Telegram photo messages are downloaded into the selected cwd and sent to Codex as image inputs; photo captions become the prompt, and photos without captions use a default inspection prompt. Telegram file/document attachments are not supported. If Codex is idle, the message starts a new turn. If a Codex turn is active, the message is sent as steering input for that turn. If no cwd is selected, ordinary text or photos open Relay Home instead.

Relay-handled slash commands after a cwd is selected:

| Command | Behavior |
| --- | --- |
| `/review` | Starts an inline Codex review of uncommitted changes. |
| `/review branch <name>` | Reviews against a base branch. |
| `/review commit <sha> [title]` | Reviews a commit. |
| `/review <instructions>` | Starts a custom review. |
| `/compact` | Starts Codex thread compaction. |
| `/init` | Asks Codex to create `AGENTS.md` if it does not already exist. |
| `/new`, `/clear` | Starts a fresh Codex thread while keeping the cwd selected. |
| `/resume [search]` | Lists recent Codex threads for the cwd and resumes the selected one. |
| `/fork` | Forks the current thread and switches the chat to the fork. |
| `/rename <name>` | Renames the current thread. Without a name, the relay asks via ForceReply. |
| `/plan` | Toggles Plan mode for the current `chat + cwd`. |
| `/plan <prompt>` | Runs the prompt in Plan mode and then offers Implement or Continue buttons. |
| `/stop` | Asks Codex to clean background terminals for the current thread. |

`/relay` is the only Relay command that works without a cwd. Unsupported slash text, including `/help`, `/status`, `/model`, and `/start`, is forwarded to Codex when a cwd is selected.

Codex questions are shown as ForceReply prompts. Multi-question requests are sent one question at a time. Approval requests are shown with approve/deny inline buttons. New prompts are paused while Codex is waiting for an answer or approval.

Assistant output is rendered as Telegram text entities rather than HTML parse mode. Common Markdown is supported, including headings, lists, task lists, blockquotes, emphasis, inline code, code blocks, and HTTP/HTTPS links. Long output is stored and shown as paged Telegram messages.

## Image Support

Telegram photo messages are supported after a cwd is selected. The relay downloads the largest Telegram photo variant, stores it in the selected workspace, and sends the local image path to Codex as a `localImage` input. Photo captions are used as the Codex prompt; photos without captions use `Please inspect the attached image(s).`

Telegram file/document attachments are intentionally not supported, even when the document MIME type is an image. Codex image outputs are sent back with Telegram `sendPhoto`; the relay does not use `sendDocument` as a fallback.

Stored media lives under `.agent-relay/media/incoming` and `.agent-relay/media/outgoing` inside the selected workspace. The relay automatically writes `.agent-relay/.gitignore` with `*`, so downloaded and generated images do not appear in that workspace's Git status. `TELEGRAM_IMAGE_MAX_BYTES` limits photo downloads before they are sent to Codex.

## Relay Capabilities

When `RELAY_CONTROL_ENABLED=true`, agent-relay starts a local control API bound to `127.0.0.1` and injects a helper plus short capability instructions into Codex. The API is protected with a random bearer token that is generated on relay startup and passed only to the Codex child process.

The first capability is `send_image`, intended for remote H5/web UI debugging. Codex can render a page with Playwright, save a screenshot inside the selected workspace, and send it back to the Telegram chat:

```bash
"$AGENT_RELAY_HELPER" send-image /absolute/path/to/screen.png --cwd "$PWD" --caption "current home screen"
```

The helper calls `POST /v1/capabilities/send_image` with `{ path, cwd, sessionKey, caption }`. The relay validates that the image is a regular PNG/JPG/WEBP/GIF inside the selected workspace, enforces `TELEGRAM_IMAGE_MAX_BYTES`, copies it to `.agent-relay/media/outgoing`, and sends it with Telegram `sendPhoto`.

## Runtime Notes

- Authorization requires `TELEGRAM_ALLOWED_USER_IDS`; if `TELEGRAM_ALLOWED_CHAT_IDS` is set, both the user and chat must match.
- On startup, pending Telegram updates are skipped so messages sent while the relay was offline are intentionally ignored.
- Telegram polling subscribes to `message` and `callback_query` updates.
- Transient Telegram failures are retried with exponential backoff.
- Workspace names cannot be empty, `.`, `..`, or contain slashes, backslashes, NUL, or control characters.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- Workspace discovery uses real first-level directories and ignores symlinked directories.
- Creating a missing workspace makes the directory and runs `git init`.
- Deleting a workspace physically removes that directory under `WORKSPACE_ROOT` and clears chat bindings that pointed at it.
- Telegram photos and Codex-generated images are stored under `.agent-relay/media` inside the selected workspace. The relay writes `.agent-relay/.gitignore` with `*` so media does not appear in the workspace's Git status.
- The relay starts one Codex app-server process and creates or resumes one Codex thread per `chat + cwd`.
- SQLite stores workspaces, chat bindings, Codex thread IDs, Plan mode state, Relay Home UI state, prompt/task state, transcript events, approval metadata, and paged assistant output.
- Runtime logs go to stdout. `debug` logs include raw Telegram messages, Codex input text, and Codex output chunks.

## Project Structure

```text
src/
  agent.ts       Session key helpers
  config.ts      .env loading, validation, and allowlist checks
  logger.ts      Text stdout logger
  main.ts        Runtime wiring
  types.ts       Shared Telegram, Codex, router, and persistence types
  workspace.ts   Workspace validation, discovery, creation, and path safety
  codex/         Codex app-server driver and JSON-RPC protocol handling
  rendering/     Telegram text entities, Markdown rendering, and splitting
  router/        Message routing, Relay Home, workspace flow, commands, and callbacks
  storage/       SQLite schema, migrations, and persistence methods
  telegram/      Telegram Bot API adapter, polling, retries, and outbound formatting
test/
  *.test.ts      Unit, router, adapter, store, app-server protocol, and smoke tests
```

## Development

Run type checks:

```bash
bun run typecheck
```

Run tests:

```bash
bun test
```
