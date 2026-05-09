# agent-relay

`agent-relay` connects an IM provider to a local CLI agent provider. The current implementations are Telegram and Lark for IM and Codex app-server for the agent. It lets approved users select a workspace under `WORKSPACE_ROOT`, send prompts, answer agent questions, approve requested actions, and manage agent threads remotely.

The project is built with Bun, TypeScript, SQLite, a provider-neutral router, and the `codex app-server --listen stdio://` protocol for the default agent provider.

## Features

- Remote Telegram or Lark control for local Codex app-server sessions.
- Per-conversation workspace selection under a configured `WORKSPACE_ROOT`.
- Inline handling for Codex questions, approvals, Plan mode flows, thread resume, fork, rename, and compaction.
- IM image input and Codex-generated image output support with workspace-local media storage.
- Provider-oriented architecture for adding more IM, agent, and persistence backends.
- Optional localhost relay capability API for agent-triggered image sending.

## Requirements

- Bun 1.3 or newer.
- Git, used when creating a new workspace directory.
- A Telegram bot token from BotFather, or a Lark self-built app with app id and app secret.
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
IM_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=123:abc
ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

For Lark:

```dotenv
IM_PROVIDER=lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
ALLOWED_USER_IDS=ou_xxx
ALLOWED_CONVERSATION_IDS=oc_xxx
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

`ALLOWED_USER_IDS` is required. `ALLOWED_CONVERSATION_IDS` is optional and should be set when the relay must be restricted to specific chats or groups. Provider IDs are stored as strings. Keep `.env` local and never commit real bot tokens or allowlist IDs.

Start the relay:

```bash
bun run start
```

Run the relay in the background with the project management script:

```bash
scripts/relay.sh start
scripts/relay.sh status
scripts/relay.sh stop
scripts/relay.sh restart
scripts/relay.sh clean-data
```

The script writes the process id to `.data/agent-relay.pid` and appends logs to `logs/agent-relay.log`. `restart` stops the relay, removes `.data/` and `logs/`, then starts a fresh process. `clean-data` removes `.data/` and `logs/`, and refuses to run while the relay process is still active.

agent-relay can be used to develop itself: select this repository as the workspace, ask Codex to make changes, and use `scripts/relay.sh restart` when the running relay should restart with clean `.data/` and `logs/`.

For development with file watching:

```bash
bun run dev
```

The relay loads `.env` first, then overlays shell environment variables, so exported variables take precedence over values in the file.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `IM_PROVIDER` | no | `telegram` | IM provider. Supported values: `telegram`, `lark`. |
| `AGENT_PROVIDER` | no | `codex` | Agent provider. Only `codex` is implemented today. |
| `ALLOWED_USER_IDS` | yes | | Comma-separated provider user IDs allowed to use the relay. Stored as strings. |
| `ALLOWED_CONVERSATION_IDS` | no | any conversation | Optional comma-separated provider conversation IDs. When set, both user and conversation must be allowed. |
| `TELEGRAM_BOT_TOKEN` | when `IM_PROVIDER=telegram` | | Bot token from BotFather. |
| `LARK_APP_ID` | when `IM_PROVIDER=lark` | | Lark self-built app id. |
| `LARK_APP_SECRET` | when `IM_PROVIDER=lark` | | Lark self-built app secret. |
| `LARK_DOMAIN` | no | `lark` | Open platform domain for Lark provider. Use `lark` or a custom HTTPS origin. |
| `WORKSPACE_ROOT` | yes | | Parent directory containing selectable workspace directories. |
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

When both `CODEX_DEVELOPER_INSTRUCTIONS_FILE` and `CODEX_DEVELOPER_INSTRUCTIONS` are set, file contents are sent first, then a blank line, then the inline text. `CODEX_MODEL_INSTRUCTIONS_FILE` is sent as Codex base instructions. The relay does not inject `AGENTS.md`; Codex discovers it normally from the selected workspace.

## Telegram Usage

Send `/relay` to open Relay Home. Relay Home shows the selected workspace, Codex status, waiting state, and recent errors. The detail toggle shows waiting state, prompt counts, thread, model, combined numeric token/context usage, approval/sandbox policy, and recent output timing. Relay Home uses English inline buttons; successful actions update the message in place without extra Telegram callback notices, while errors and expired actions still show explicit feedback.

Relay Home actions:

- `Workspaces`: open the workspace management view. It lists first-level directories under `WORKSPACE_ROOT`, keeps `Back`, `New`, and `Refresh` actions fixed at the bottom, and supports selecting a workspace or deleting one after confirmation. `Back` returns to Relay Home. `New` asks for a workspace name with an input placeholder, then sends a short confirmation and refreshes the workspace list in place.
- `Details` / `Compact`: toggle compact and detailed status views for the conversation.
- `Refresh`: redraw the current Relay Home message.
- `Stop`: interrupt the current workspace session and clear the conversation's workspace selection.

After a workspace is selected, ordinary Telegram messages are sent to Codex. Telegram photo messages are downloaded into the selected workspace and sent to Codex as image inputs; photo captions become the prompt, and photos without captions use a default inspection prompt. Telegram file/document attachments are not supported. If Codex is idle, the message starts a new turn. If a Codex turn is active, the message is sent as steering input for that turn. If no workspace is selected, ordinary text or photos open Relay Home instead.

Relay-handled slash commands after a workspace is selected:

| Command | Behavior |
| --- | --- |
| `/review` | Starts an inline Codex review of uncommitted changes. |
| `/review branch <name>` | Reviews against a base branch. |
| `/review commit <sha> [title]` | Reviews a commit. |
| `/review <instructions>` | Starts a custom review. |
| `/compact` | Starts Codex thread compaction. |
| `/init` | Asks Codex to create `AGENTS.md` if it does not already exist. |
| `/new`, `/clear` | Starts a fresh Codex thread while keeping the workspace selected. |
| `/resume [search]` | Lists recent Codex threads for the workspace and resumes the selected one. |
| `/fork` | Forks the current thread and switches the conversation to the fork. |
| `/rename <name>` | Renames the current thread. Without a name, the relay asks via ForceReply. |
| `/plan` | Toggles Plan mode for the current `conversation + workspace`. |
| `/plan <prompt>` | Runs the prompt in Plan mode and then offers Implement or Continue buttons. Implement exits Plan mode and starts normal coding. |
| `/goal` | Shows the current Codex thread goal. |
| `/goal <objective>` | Sets the current Codex thread goal, asking before replacing an existing goal. |
| `/goal pause`, `/goal resume`, `/goal clear` | Pauses, resumes, or clears the current Codex thread goal. |
| `/interrupt` | Interrupts the active Codex turn, similar to pressing Esc in Codex CLI. The current workspace, session, and thread remain selected. |
| `/interrupt all` | Interrupts the active Codex turn and marks queued prompts interrupted for the current workspace. |
| `/ps` | Lists background terminals started by Codex for the current thread. |
| `/stop` | Asks Codex to clean background terminals for the current thread. It does not stop unrelated system processes. |

`/goal` uses Codex app-server thread goal APIs (`thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`) and requires a Codex CLI version that supports those methods. It can run while a Codex turn is active, matching the interactive Codex CLI behavior. The reserved subcommands `pause`, `resume`, and `clear` are treated as goal actions rather than objective text.

`/relay` is the only Relay command that works without a selected workspace. Unsupported slash text, including `/help`, `/status`, `/model`, and `/start`, is forwarded to Codex when a workspace is selected.

When Telegram reactions are available, relay-owned prompt messages use status reactions: `🫡` for waiting or queued, `✍` for running, `🤔` for blocked on Codex input or approval, `😎` for done, `🤨` for interrupted, and `😱` for failed or cancelled.

Codex questions with predefined options are shown with inline buttons. In Plan mode, selecting an option opens a confirmation step where you can submit, add a note, or change the selection; questions that support Other provide a free-text ForceReply answer. Free-text and secret questions are shown as ForceReply prompts. Multi-question requests are sent one question at a time, and answered option cards only show the selected answer. Approval requests are shown with approve/deny inline buttons. New prompts are paused while Codex is waiting for an answer or approval.

Assistant output is rendered as Telegram text entities rather than HTML parse mode. Common Markdown is supported, including headings, lists, task lists, blockquotes, emphasis, inline code, code blocks, and HTTP/HTTPS links. Long output is stored and shown as paged Telegram messages.

## Lark Usage

Set `IM_PROVIDER=lark` and configure `LARK_APP_ID` plus `LARK_APP_SECRET` for a self-built app. The provider uses the official SDK long-connection mode, so the relay only needs outbound network access and does not need a public HTTPS callback URL.

In the Lark developer console, enable bot messaging and subscribe to message receive and card action events. At minimum, the relay expects message receive events for text and images plus card button callbacks for Relay Home, approvals, Codex questions, pagination, and workspace actions. Grant the app the IM message send and media resource permissions required by your tenant.

Allowlist IDs are provider-native strings. Use sender `open_id` values in `ALLOWED_USER_IDS`; use chat `chat_id` values in `ALLOWED_CONVERSATION_IDS`. Lark interactive actions are shown as message cards. Reply prompts use normal Lark message replies and the existing pending prompt flow.

## Image Support

IM image messages are supported after a workspace is selected. The relay downloads the best available image resource, stores it in the selected workspace, and sends the local image path to Codex as a `localImage` input. Captions are used as the Codex prompt when the provider supplies one; images without captions use `Please inspect the attached image(s).`

File/document attachments are intentionally not supported, even when the document MIME type is an image. Codex image outputs are sent back through the IM adapter's image upload path; Telegram still does not use `sendDocument` as a fallback.

Stored media lives under `.agent-relay/media/incoming` and `.agent-relay/media/outgoing` inside the selected workspace. The relay automatically writes `.agent-relay/.gitignore` with `*`, so downloaded and generated images do not appear in that workspace's Git status. `MEDIA_MAX_BYTES` limits photo downloads before they are sent to Codex.

## Relay Capabilities

When `RELAY_CONTROL_ENABLED=true`, agent-relay starts a local control API bound to `127.0.0.1` and injects a helper plus registered capability instructions into the agent. The API is protected with a random bearer token that is generated on relay startup and passed only to the agent child process.

The registered capability is `send_image`, intended for remote H5/web UI debugging. Codex can render a page with Playwright, save a screenshot inside the selected workspace, and send it back to the active IM chat:

```bash
"$AGENT_RELAY_HELPER" send-image /absolute/path/to/screen.png --cwd "$PWD" --caption "current home screen"
```

The helper calls `POST /v1/capabilities/send_image` with `{ path, cwd, sessionKey, caption }`. The relay validates that the image is a regular PNG/JPG/WEBP/GIF inside the selected workspace, enforces `MEDIA_MAX_BYTES`, copies it to `.agent-relay/media/outgoing`, and sends it through the IM adapter.

## Runtime Notes

- Authorization requires `ALLOWED_USER_IDS`; if `ALLOWED_CONVERSATION_IDS` is set, both the user and conversation must match.
- On startup, pending Telegram updates are skipped so messages sent while the relay was offline are intentionally ignored.
- Telegram polling subscribes to `message` and `callback_query` updates. Lark uses long-connection event delivery through the official SDK.
- Transient Telegram failures are retried with exponential backoff. Lark long-connection reconnect and outbound retry behavior is delegated to the SDK.
- Workspace names cannot be empty, `.`, `..`, or contain slashes, backslashes, NUL, or control characters.
- Workspaces are resolved under `WORKSPACE_ROOT`; path traversal and absolute workspace names are rejected.
- Workspace discovery uses real first-level directories and ignores symlinked directories.
- Creating a missing workspace makes the directory and runs `git init`.
- Deleting a workspace physically removes that directory under `WORKSPACE_ROOT` and clears conversation bindings that pointed at it.
- IM photos and Codex-generated images are stored under `.agent-relay/media` inside the selected workspace. The relay writes `.agent-relay/.gitignore` with `*` so media does not appear in the workspace's Git status.
- The relay starts one agent provider process and creates or resumes one agent thread per `conversation + workspace`.
- SQLite stores workspaces, conversation bindings, Codex thread IDs, Plan mode state, Relay Home UI state, prompt/task state, transcript events, approval metadata, paged assistant output, and schema migration metadata.
- Runtime logs go to stdout. `debug` logs include raw IM messages, Codex input text, and Codex output chunks.

## Provider Architecture

The relay is organized by domain. The relay controller depends on `ImAdapter`, `AgentDriver`, and `RelayStore` ports rather than concrete IM, Codex, or SQLite classes. `src/providers/im/factory.ts` and `src/providers/agents/factory.ts` are the runtime provider factories.

The relay controller keeps the user-facing workflow together, while dedicated collaborators handle high-churn routing and streaming behavior:

- `SlashCommandRouter` dispatches relay-owned slash commands and leaves unsupported commands available for the agent.
- `CallbackRouter` dispatches inline keyboard callback payloads.
- `TaskCoordinator` owns prompt queue state, task reactions, and sending work to the agent.
- `OutputStreamer` owns live assistant output buffering, IM message edits, and paged output callbacks.

Extension points:

- IM providers implement `ImAdapter` under `src/providers/im/<provider>/` and are selected from `src/providers/im/factory.ts`.
- Agent providers implement `AgentDriver` under `src/providers/agents/<provider>/` and are selected from `src/providers/agents/factory.ts`.
- Persistence implementations implement `RelayStore`; SQLite is the default implementation.
- Agent-visible relay features live under `src/relay/capabilities/`, register `CapabilityDefinition` entries through `CapabilityRegistry`, and expose helper subcommands from `bin/agent-relay-helper`.

## Known Limitations

- Telegram and Lark IM providers are implemented today. Codex is the only agent provider.
- Telegram file/document attachments are not supported, including document uploads whose MIME type is an image.
- The repository is intended for GitHub source use. npm publication is not configured, and `package.json` remains marked as private.

## Security and Privacy

- Keep `.env` private. It contains IM credentials, allowlisted user IDs, workspace root, and other local runtime settings.
- Treat `TELEGRAM_BOT_TOKEN`, `LARK_APP_SECRET`, `ALLOWED_USER_IDS`, and `ALLOWED_CONVERSATION_IDS` as sensitive operational data. Rotate provider credentials if they are ever committed, pasted into an issue, or exposed in logs.
- Use `ALLOWED_USER_IDS` in every deployment. Add `ALLOWED_CONVERSATION_IDS` when the relay should only operate in specific chats or groups.
- Keep `LOG_LEVEL=info` for normal use. `debug` logs can include raw IM messages, Codex input text, and Codex output chunks.
- Do not publish `.data/agent-relay.sqlite`; SQLite runtime data can contain workspace names, conversation bindings, thread IDs, transcript events, prompt state, approvals, and paged assistant output.
- Review workspace files before publishing a workspace repository. Relay media is stored inside selected workspaces under `.agent-relay/media`, and the relay writes `.agent-relay/.gitignore` with `*`.
- The optional relay capability API binds to `127.0.0.1` and uses a startup-scoped bearer token passed to the child agent process. Do not expose it through a public network proxy.

## Project Structure

```text
src/
  main.ts        Bun entrypoint that delegates to runtime/bootstrap
  runtime/       Runtime bootstrap plus .env loading, validation, and allowlist checks
  domain/        Provider-neutral IDs, session keys, logger, and workspace safety
  ports/         Provider-neutral AgentDriver and ImAdapter contracts
  providers/     Codex agent provider, IM providers, and provider factories
  relay/         Controller, command/callback routers, task coordination, output streaming, capabilities, media, and relay UI state
  storage/       RelayStore port, SQLite implementation, row types, schema migrations, and persistence mappers
  presentation/  Text rendering, Markdown rendering, UI text, and splitting
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

## Contributing

Contributions are welcome. Before opening a pull request, run the local check:

```bash
bun install
bun run check
```

Keep changes focused, include tests for behavior changes, and avoid committing local runtime files such as `.env`, `.data/`, logs, generated media, or workspace-specific artifacts. When filing issues or sharing logs, redact IM credentials, user IDs, conversation IDs, private workspace paths, and prompt/output content that should not be public.

## Support

When opening an issue, include the Bun version, operating system, whether `codex` is available on `PATH`, the Codex CLI version if available, the relevant configuration variable names, and redacted logs. Do not paste IM credentials, allowlisted IDs, private workspace paths, prompt text, or assistant output that should not be public.

## License

`agent-relay` is licensed under the [MIT License](LICENSE).
