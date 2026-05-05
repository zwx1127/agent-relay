# agent-relay

`agent-relay` connects an IM provider to a local CLI agent provider. The current providers are Telegram for IM and Codex app-server for the agent. It lets approved users select a workspace under `WORKSPACE_ROOT`, send prompts, answer agent questions, approve requested actions, and manage agent threads remotely.

The project is built with Bun, TypeScript, SQLite, a provider-neutral router, and the `codex app-server --listen stdio://` protocol for the default agent provider.

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
ALLOWED_USER_IDS=123456
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
| `IM_PROVIDER` | no | `telegram` | IM provider. Only `telegram` is implemented today. |
| `AGENT_PROVIDER` | no | `codex` | Agent provider. Only `codex` is implemented today. |
| `ALLOWED_USER_IDS` | yes | | Comma-separated provider user IDs allowed to use the relay. Stored as strings. |
| `ALLOWED_CONVERSATION_IDS` | no | any conversation | Optional comma-separated provider conversation IDs. When set, both user and conversation must be allowed. |
| `TELEGRAM_BOT_TOKEN` | yes | | Bot token from BotFather. |
| `WORKSPACE_ROOT` | yes | | Parent directory containing selectable cwd directories. |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | no | `30` | Telegram long-poll timeout. |
| `TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS` | no | `3` | Retry attempts for non-polling Telegram API calls. |
| `TELEGRAM_RETRY_INITIAL_DELAY_MS` | no | `500` | Initial retry backoff for transient Telegram API failures. |
| `TELEGRAM_RETRY_MAX_DELAY_MS` | no | `10000` | Maximum Telegram retry backoff. |
| `MEDIA_MAX_BYTES` | no | `20971520` | Maximum inbound/outbound image size in bytes. |
| `SQLITE_PATH` | no | `.data/agent-relay.sqlite` | SQLite database path. Parent directories are created automatically. |
| `CODEX_BIN` | no | `codex` | Codex CLI executable. |
| `CODEX_SANDBOX` | no | `workspace-write` | Sandbox policy passed to Codex thread start, resume, and fork calls. |
| `CODEX_APPROVAL` | no | `on-request` | Approval policy passed to Codex thread start, resume, and fork calls. |
| `CODEX_DEVELOPER_INSTRUCTIONS_FILE` | no | | File loaded into Codex developer instructions. |
| `CODEX_DEVELOPER_INSTRUCTIONS` | no | | Inline developer instructions appended after file instructions. |
| `CODEX_MODEL_INSTRUCTIONS_FILE` | no | | File loaded into Codex base/model instructions. |
| `RELAY_CONTROL_ENABLED` | no | `false` | Enables the local agent-to-relay capability API on `127.0.0.1`. |
| `RELAY_CONTROL_PORT` | no | `0` | Local capability API port. `0` asks the OS to choose an available port. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, or `error`. |

When both `CODEX_DEVELOPER_INSTRUCTIONS_FILE` and `CODEX_DEVELOPER_INSTRUCTIONS` are set, file contents are sent first, then a blank line, then the inline text. `CODEX_MODEL_INSTRUCTIONS_FILE` is sent as Codex base instructions. The relay does not inject `AGENTS.md`; Codex discovers it normally from the selected cwd.

## Provider Architecture

The relay is organized by domain. The relay controller depends on `ImAdapter`, `AgentDriver`, and `RelayStore` ports rather than concrete Telegram, Codex, or SQLite classes. `src/providers/im/factory.ts` and `src/providers/agents/factory.ts` are the runtime provider factories. Adding Feishu/Lark or Claude Code should be done by implementing those ports, registering the provider in the factory, and adding provider-specific config validation.

The relay controller keeps the user-facing workflow together, while dedicated collaborators handle high-churn routing and streaming behavior:

- `SlashCommandRouter` dispatches relay-owned slash commands and leaves unsupported commands available for the agent.
- `CallbackRouter` dispatches inline keyboard callback payloads.
- `TaskCoordinator` owns prompt queue state, task reactions, and sending work to the agent.
- `OutputStreamer` owns live assistant output buffering, Telegram message edits, and paged output callbacks.

Conversation, user, and message IDs are treated as provider IDs and persisted as strings. This is a breaking schema change from older SQLite databases that used Telegram numeric `chat_id`; delete or recreate `.data/agent-relay.sqlite` when upgrading from the pre-provider schema.

Extension points:

- IM providers implement `ImAdapter` under `src/providers/im/<provider>/` and are selected from `src/providers/im/factory.ts`.
- Agent providers implement `AgentDriver` under `src/providers/agents/<provider>/` and are selected from `src/providers/agents/factory.ts`.
- Persistence implementations implement `RelayStore`; SQLite is the default implementation.
- Agent-visible relay features live under `src/relay/capabilities/`, register `CapabilityDefinition` entries through `CapabilityRegistry`, and expose helper subcommands from `bin/agent-relay-helper`.

## Breaking Changes

This provider refactor intentionally changes runtime configuration and the SQLite schema:

- Rename `TELEGRAM_ALLOWED_USER_IDS` to `ALLOWED_USER_IDS`.
- Rename `TELEGRAM_ALLOWED_CHAT_IDS` to `ALLOWED_CONVERSATION_IDS`.
- Rename `TELEGRAM_IMAGE_MAX_BYTES` to `MEDIA_MAX_BYTES`.
- Rename `MESSAGING_PROVIDER` to `IM_PROVIDER`.
- Session keys now include the agent provider, for example `codex:<conversation-id>:<workspace>`.
- Existing SQLite databases using the old numeric `chat_id` schema are not migrated automatically. Stop the relay and remove or recreate `.data/agent-relay.sqlite` before starting the new version.

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

Stored media lives under `.agent-relay/media/incoming` and `.agent-relay/media/outgoing` inside the selected workspace. The relay automatically writes `.agent-relay/.gitignore` with `*`, so downloaded and generated images do not appear in that workspace's Git status. `MEDIA_MAX_BYTES` limits photo downloads before they are sent to Codex.

## Relay Capabilities

When `RELAY_CONTROL_ENABLED=true`, agent-relay starts a local control API bound to `127.0.0.1` and injects a helper plus registered capability instructions into the agent. The API is protected with a random bearer token that is generated on relay startup and passed only to the agent child process.

The first capability is `send_image`, intended for remote H5/web UI debugging. Codex can render a page with Playwright, save a screenshot inside the selected workspace, and send it back to the Telegram chat:

```bash
"$AGENT_RELAY_HELPER" send-image /absolute/path/to/screen.png --cwd "$PWD" --caption "current home screen"
```

The helper calls `POST /v1/capabilities/send_image` with `{ path, cwd, sessionKey, caption }`. The relay validates that the image is a regular PNG/JPG/WEBP/GIF inside the selected workspace, enforces `MEDIA_MAX_BYTES`, copies it to `.agent-relay/media/outgoing`, and sends it through the IM adapter.

## Runtime Notes

- Authorization requires `ALLOWED_USER_IDS`; if `ALLOWED_CONVERSATION_IDS` is set, both the user and conversation must match.
- On startup, pending Telegram updates are skipped so messages sent while the relay was offline are intentionally ignored.
- Telegram polling subscribes to `message` and `callback_query` updates.
- Transient Telegram failures are retried with exponential backoff.
- Workspace names cannot be empty, `.`, `..`, or contain slashes, backslashes, NUL, or control characters.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- Workspace discovery uses real first-level directories and ignores symlinked directories.
- Creating a missing workspace makes the directory and runs `git init`.
- Deleting a workspace physically removes that directory under `WORKSPACE_ROOT` and clears chat bindings that pointed at it.
- Telegram photos and Codex-generated images are stored under `.agent-relay/media` inside the selected workspace. The relay writes `.agent-relay/.gitignore` with `*` so media does not appear in the workspace's Git status.
- The relay starts one agent provider process and creates or resumes one agent thread per `conversation + cwd`.
- SQLite stores workspaces, chat bindings, Codex thread IDs, Plan mode state, Relay Home UI state, prompt/task state, transcript events, approval metadata, paged assistant output, and schema migration metadata.
- Runtime logs go to stdout. `debug` logs include raw Telegram messages, Codex input text, and Codex output chunks.

## Project Structure

```text
src/
  main.ts        Bun entrypoint that delegates to runtime/bootstrap
  runtime/       Runtime bootstrap plus .env loading, validation, and allowlist checks
  domain/        Provider-neutral IDs, session keys, logger, and workspace safety
  ports/         Provider-neutral AgentDriver and ImAdapter contracts
  providers/     Codex agent provider, Telegram IM provider, and provider factories
  relay/         Controller, command/callback routers, task coordination, output streaming, capabilities, media, and relay UI state
  storage/       RelayStore port, SQLite implementation, row types, schema migrations, and persistence mappers
  presentation/  Telegram text entities, Markdown rendering, UI text, and splitting
test/
  unit/          Focused unit tests for config, logger, workspace, routing, and rendering
  integration/   Router, adapter, store, control API, app-server protocol, and smoke tests
  support/       Shared fake adapter/agent test utilities
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

Run the full local check:

```bash
bun run check
```
