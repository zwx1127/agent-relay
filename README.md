# agent-relay

`agent-relay` connects chat apps to a local Codex CLI agent. It lets approved users pick a workspace, send prompts, answer Codex questions, approve actions, review code, manage threads, and exchange images from Telegram or Lark without sitting at the machine running Codex.

`agent-relay` 将即时通讯工具连接到本地 Codex CLI agent。授权用户可以通过 Telegram 或 Lark 选择工作区、发送提示词、回答 Codex 问题、审批操作、发起代码审查、管理线程，并收发图片，而不需要直接操作运行 Codex 的机器。

The current implementation uses Bun, TypeScript, SQLite, Telegram or Lark as IM providers, and `codex app-server --listen stdio://` as the agent backend.

当前实现基于 Bun、TypeScript、SQLite，支持 Telegram 或 Lark 作为 IM provider，并使用 `codex app-server --listen stdio://` 作为 agent 后端。

## Highlights / 功能亮点

- Remote control of local Codex app-server sessions from Telegram or Lark.
- Per-conversation workspace selection under a configured `WORKSPACE_ROOT`.
- Workspace creation, deletion, selection, and `.gitignore`-aware file browsing.
- Codex thread operations: review, compact, init, new, resume, fork, rename, Plan mode, goals, side conversations, interrupt, and background terminal cleanup.
- Inline handling for Codex user questions, approvals, Plan mode choices, paged output, and stale callback recovery.
- IM image input, image album batching, Codex image output, and workspace-local media storage.
- Optional local capability API for agent-triggered screenshot/image sending and peer-agent mentions.
- Provider-oriented architecture for adding more IM, agent, or persistence backends.

- 可通过 Telegram 或 Lark 远程控制本地 Codex app-server 会话。
- 每个会话可在配置的 `WORKSPACE_ROOT` 下选择独立工作区。
- 支持工作区创建、删除、选择，以及遵循 `.gitignore` 的文件浏览。
- 支持 Codex 线程操作：review、compact、init、new、resume、fork、rename、Plan mode、goal、side conversation、interrupt 和后台终端清理。
- 支持 Codex 问题、审批、Plan mode 选择、长输出分页和过期按钮恢复。
- 支持 IM 图片输入、相册批量提交、Codex 图片输出，并将媒体存储在工作区内。
- 可选本地 capability API，供 agent 主动发送截图/图片或提及其他 agent bot。
- 采用 provider-oriented 架构，便于扩展 IM、agent 或持久化后端。

## Requirements / 环境要求

- Bun 1.3 or newer.
- Git, used when creating new workspaces.
- A local `codex` CLI binary on `PATH`, or a custom `CODEX_BIN`.
- A Codex CLI version that supports `codex app-server --listen stdio://`.
- A Telegram bot token from BotFather, or a Lark/Feishu self-built app with app id and app secret.

- Bun 1.3 或更新版本。
- Git，用于创建新工作区。
- 本地 `PATH` 中可用的 `codex` CLI，或通过 `CODEX_BIN` 指定路径。
- Codex CLI 需要支持 `codex app-server --listen stdio://`。
- Telegram BotFather 创建的 bot token，或 Lark/飞书自建应用的 app id 与 app secret。

## Quick Start / 快速开始

Install dependencies:

安装依赖：

```bash
bun install
```

Create a local environment file:

创建本地环境文件：

```bash
cp .env.example .env
```

Minimum Telegram configuration:

Telegram 最小配置：

```dotenv
IM_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=123:abc
ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

Minimum Lark/Feishu configuration:

Lark/飞书最小配置：

```dotenv
IM_PROVIDER=lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_DOMAIN=feishu
ALLOWED_USER_IDS=ou_xxx
ALLOWED_CONVERSATION_IDS=oc_xxx
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

Start the relay:

启动 relay：

```bash
bun run start
```

For development with file watching:

开发时可使用 watch 模式：

```bash
bun run dev
```

The relay loads `.env` first, then overlays shell environment variables. Exported variables take precedence over values in `.env`.

relay 会先加载 `.env`，再叠加 shell 环境变量。因此，已导出的环境变量优先级高于 `.env` 中的值。

## Process Script / 进程管理脚本

The repository includes a small management script for running the relay in the background:

仓库提供了一个简单脚本用于后台管理 relay：

```bash
scripts/relay.sh start
scripts/relay.sh status
scripts/relay.sh stop
scripts/relay.sh restart
scripts/relay.sh clean-data
scripts/relay.sh clean
```

The script writes the pid to `.data/agent-relay.pid` and appends logs to `logs/agent-relay.log`. `restart` stops the relay, removes `.data/` and `logs/`, and starts a fresh process. `clean-data` removes `.data/` and `logs/`, but refuses to run while the relay process is active. `clean` is an alias for `clean-data`.

脚本会将 pid 写入 `.data/agent-relay.pid`，并将日志追加到 `logs/agent-relay.log`。`restart` 会停止 relay、删除 `.data/` 和 `logs/`，然后重新启动。`clean-data` 会删除 `.data/` 和 `logs/`，但 relay 仍在运行时会拒绝执行。`clean` 是 `clean-data` 的别名。

The script also supports timing overrides for tests or local tuning: `AGENT_RELAY_STOP_TIMEOUT_SECONDS`, `AGENT_RELAY_STOP_POLL_INTERVAL_SECONDS`, `AGENT_RELAY_START_CHECK_DELAY_SECONDS`, and `AGENT_RELAY_RESTART_WORKER_DELAY_SECONDS`.

该脚本还支持用于测试或本地调优的时间参数：`AGENT_RELAY_STOP_TIMEOUT_SECONDS`、`AGENT_RELAY_STOP_POLL_INTERVAL_SECONDS`、`AGENT_RELAY_START_CHECK_DELAY_SECONDS` 和 `AGENT_RELAY_RESTART_WORKER_DELAY_SECONDS`。

## Configuration / 配置

Provider IDs are stored as strings. `ALLOWED_USER_IDS` is required in every deployment. `ALLOWED_CONVERSATION_IDS` is optional, but recommended for group deployments or any shared bot.

provider ID 会按字符串存储。所有部署都必须配置 `ALLOWED_USER_IDS`。`ALLOWED_CONVERSATION_IDS` 可选，但在群组或共享 bot 场景中建议配置。

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `IM_PROVIDER` | no | `telegram` | IM provider. Supported: `telegram`, `lark`. IM provider，支持 `telegram`、`lark`。 |
| `AGENT_PROVIDER` | no | `codex` | Agent provider. Only `codex` is implemented today. Agent provider，目前仅实现 `codex`。 |
| `ALLOWED_USER_IDS` | yes | | Comma-separated provider user IDs allowed to use the relay. 允许使用 relay 的 provider 用户 ID，逗号分隔。 |
| `ALLOWED_CONVERSATION_IDS` | no | any conversation | Optional comma-separated conversation/chat IDs. When set, both user and conversation must be allowed. 可选会话/群聊 ID，设置后用户和会话都必须命中 allowlist。 |
| `TELEGRAM_BOT_TOKEN` | when `IM_PROVIDER=telegram` | | Telegram bot token. Telegram bot token。 |
| `TELEGRAM_BOT_USERNAME` | no | auto-discovered | Bot username for Telegram group mention detection. Telegram 群组提及时使用的 bot 用户名，默认启动时自动发现。 |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | no | `30` | Telegram long-poll timeout. Telegram long-poll 超时时间。 |
| `TELEGRAM_REQUEST_RETRY_MAX_ATTEMPTS` | no | `3` | Retry attempts for non-polling Telegram API calls. 非 polling Telegram API 调用重试次数。 |
| `TELEGRAM_RETRY_INITIAL_DELAY_MS` | no | `500` | Initial retry backoff for transient Telegram failures. Telegram 临时失败的初始重试退避。 |
| `TELEGRAM_RETRY_MAX_DELAY_MS` | no | `10000` | Maximum Telegram retry backoff. Telegram 最大重试退避。 |
| `LARK_APP_ID` | when `IM_PROVIDER=lark` | | Lark/Feishu self-built app id. Lark/飞书自建应用 app id。 |
| `LARK_APP_SECRET` | when `IM_PROVIDER=lark` | | Lark/Feishu self-built app secret. Lark/飞书自建应用 app secret。 |
| `LARK_DOMAIN` | no | `feishu` | `feishu`, `lark`, or a custom HTTPS origin. 可设为 `feishu`、`lark` 或自定义 HTTPS origin。 |
| `LARK_CARD_ACTION_DISPATCH_DELAY_MS` | no | `150` | Delay before dispatching Lark card actions, useful for provider ordering quirks. Lark 卡片回调分发延迟，用于规避 provider 事件顺序问题。 |
| `WORKSPACE_ROOT` | yes | | Parent directory containing selectable workspace directories. 可选工作区所在的父目录。 |
| `MEDIA_MAX_BYTES` | no | `20971520` | Maximum inbound/outbound image size in bytes. 输入/输出图片大小上限，单位字节。 |
| `SQLITE_PATH` | no | `.data/agent-relay.sqlite` | SQLite database path. Parent directories are created automatically. SQLite 数据库路径，父目录会自动创建。 |
| `CODEX_BIN` | no | `codex` | Codex CLI executable. Codex CLI 可执行文件。 |
| `CODEX_SANDBOX` | no | `workspace-write` | Sandbox policy passed to Codex thread start/resume/fork. 传给 Codex 线程 start/resume/fork 的 sandbox policy。 |
| `CODEX_APPROVAL` | no | `on-request` | Approval policy passed to Codex thread start/resume/fork. 传给 Codex 线程 start/resume/fork 的 approval policy。 |
| `CODEX_DEVELOPER_INSTRUCTIONS_FILE` | no | | File loaded into Codex developer instructions. 载入 Codex developer instructions 的文件。 |
| `CODEX_DEVELOPER_INSTRUCTIONS` | no | | Inline developer instructions appended after file instructions. 追加在文件内容后的内联 developer instructions。 |
| `CODEX_MODEL_INSTRUCTIONS_FILE` | no | | File loaded into Codex base/model instructions. 载入 Codex base/model instructions 的文件。 |
| `RELAY_AGENT_NAME` | no | | Human-readable name injected into peer-agent capability instructions. 注入 peer-agent capability instructions 的 relay 实例名称。 |
| `RELAY_PEER_AGENTS_FILE` | no | | JSON file listing peer agent bots for `mention_agent`. 配置 `mention_agent` 可提及的 peer agent bot JSON 文件。 |
| `RELAY_CONTROL_ENABLED` | no | `false` | Enables the local agent-to-relay capability API on `127.0.0.1`. 启用绑定在 `127.0.0.1` 的本地 agent-to-relay capability API。 |
| `RELAY_CONTROL_PORT` | no | `0` | Local capability API port. `0` asks the OS to choose a free port. 本地 capability API 端口，`0` 表示由系统分配。 |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, or `error`. 日志级别，可选 `debug`、`info`、`warn`、`error`。 |

When both `CODEX_DEVELOPER_INSTRUCTIONS_FILE` and `CODEX_DEVELOPER_INSTRUCTIONS` are set, file contents are sent first, then a blank line, then the inline text. `CODEX_MODEL_INSTRUCTIONS_FILE` is sent as Codex base instructions. The relay also injects its own interaction rules, and capability instructions when the control API is enabled.

同时设置 `CODEX_DEVELOPER_INSTRUCTIONS_FILE` 和 `CODEX_DEVELOPER_INSTRUCTIONS` 时，会先发送文件内容，再空一行追加内联文本。`CODEX_MODEL_INSTRUCTIONS_FILE` 会作为 Codex base instructions 发送。relay 还会注入自身交互规则；启用 control API 时也会注入 capability instructions。

On Windows, `CODEX_BIN=codex` is resolved through `PATH` and `PATHEXT`, so npm-style shims such as `codex.cmd` are supported. If needed, set `CODEX_BIN` to the full `codex.cmd` or `codex.exe` path. Do not include escaped quotes in the value.

在 Windows 上，`CODEX_BIN=codex` 会通过 `PATH` 和 `PATHEXT` 解析，因此支持 `codex.cmd` 这类 npm shim。必要时可将 `CODEX_BIN` 设置为完整的 `codex.cmd` 或 `codex.exe` 路径。不要在值中包含转义引号。

## Telegram Usage / Telegram 使用

Send `/relay` to open Relay Home. Relay Home shows the selected workspace, Codex status, waiting state, recent errors, and compact/detail toggles. In groups, text, media, and slash commands must mention the bot; unmentioned group messages are ignored before authorization. Inline button callbacks still work.

发送 `/relay` 打开 Relay Home。Relay Home 会显示当前工作区、Codex 状态、等待状态、最近错误，并支持紧凑/详情视图切换。在群组中，文本、媒体和 slash command 必须提及 bot；未提及 bot 的群消息会在授权检查前被忽略。内联按钮回调仍然可用。

After selecting a workspace, ordinary text is sent to Codex. If a turn is already active, the text is sent as steering input. If Codex is waiting for an answer or approval, new direct prompts are held back until the pending item is handled or interrupted. When the IM provider supports reactions, relay-owned prompt messages show status reactions for waiting, running, blocked, done, interrupted, failed, or cancelled states.

选择工作区后，普通文本会发送给 Codex。如果当前 turn 正在运行，文本会作为 steering input 发送。如果 Codex 正在等待回答或审批，新的直接提示会被暂停，直到待处理项被处理或中断。当 IM provider 支持 reaction 时，relay 自己发送的提示消息会用 reaction 表示 waiting、running、blocked、done、interrupted、failed 或 cancelled 等状态。

Supported slash commands:

支持的 slash command：

| Command | Behavior |
| --- | --- |
| `/help` | Show supported Relay commands. 显示 Relay 命令帮助。 |
| `/relay` | Open Relay Home. 打开 Relay Home。 |
| `/review` | Review uncommitted changes. 审查未提交变更。 |
| `/review branch <name>` | Review against a base branch. 基于指定分支审查。 |
| `/review commit <sha> [title]` | Review a commit. 审查指定 commit。 |
| `/review <instructions>` | Start a custom review. 发起自定义审查。 |
| `/compact` | Start Codex thread compaction. 发起 Codex 线程压缩。 |
| `/init` | Ask Codex to create `AGENTS.md` if missing. 如果缺失则要求 Codex 创建 `AGENTS.md`。 |
| `/new`, `/clear` | Start a fresh Codex thread while keeping the workspace. 保持工作区并开启新线程。 |
| `/resume [search]` | List recent Codex threads and resume one. 列出并恢复最近线程。 |
| `/fork` | Fork the current thread and switch to the fork. fork 当前线程并切换过去。 |
| `/side <prompt>`, `/btw <prompt>` | Ask in an ephemeral side conversation fork. 在临时 side conversation fork 中提问。 |
| `/rename <name>` | Rename the current thread. Without a name, Relay asks via reply prompt. 重命名当前线程；不带名称时通过回复提示输入。 |
| `/plan` | Toggle Plan mode for the current conversation and workspace. 切换当前会话与工作区的 Plan mode。 |
| `/plan <prompt>` | Run a prompt in Plan mode, then offer Implement or Continue. 以 Plan mode 运行提示，然后提供 Implement 或 Continue。 |
| `/goal` | Show the current Codex thread goal. 显示当前 Codex 线程 goal。 |
| `/goal <objective>` | Set the current goal, asking before replacing an existing one. 设置当前 goal，已有 goal 时会先确认替换。 |
| `/goal pause`, `/goal resume`, `/goal clear` | Pause, resume, or clear the current goal. 暂停、恢复或清除当前 goal。 |
| `/interrupt` | Interrupt the active Codex turn. 中断当前 Codex turn。 |
| `/interrupt all` | Interrupt the active turn and queued prompts for the current workspace. 中断当前 turn 以及当前工作区队列中的提示。 |
| `/ps` | List background terminals started by Codex for the current thread. 列出当前线程中 Codex 启动的后台终端。 |
| `/stop` | Ask Codex to clean background terminals for the current thread. 要求 Codex 清理当前线程的后台终端。 |

`/help` and `/relay` work without a selected workspace. Unsupported slash commands show an unknown-command notice and point to `/help`.

`/help` 和 `/relay` 不需要先选择工作区。未知 slash command 会显示 unknown-command 提示并引导使用 `/help`。

## Lark/Feishu Usage / Lark/飞书使用

Set `IM_PROVIDER=lark` and configure `LARK_APP_ID` plus `LARK_APP_SECRET` for a self-built app. Use `LARK_DOMAIN=feishu` for apps created in the Feishu China developer console, or `LARK_DOMAIN=lark` for Lark international. A custom HTTPS origin is also accepted.

设置 `IM_PROVIDER=lark`，并为自建应用配置 `LARK_APP_ID` 和 `LARK_APP_SECRET`。中国飞书开发者后台创建的应用使用 `LARK_DOMAIN=feishu`，Lark 国际版使用 `LARK_DOMAIN=lark`。也可以配置自定义 HTTPS origin。

The provider uses the official SDK long-connection mode. The relay only needs outbound network access and does not require a public HTTPS callback URL. In the developer console, enable bot messaging and subscribe to message receive plus card action events. The relay expects text/image receive events and `card.action.trigger` callbacks for buttons, approvals, questions, pagination, workspace actions, and file browsing.

Lark provider 使用官方 SDK 的长连接模式。relay 只需要出站网络访问，不需要公网 HTTPS callback URL。请在开发者后台启用机器人消息能力，并订阅消息接收与卡片 action 事件。relay 需要文本/图片接收事件，以及用于按钮、审批、问题、分页、工作区操作和文件浏览的 `card.action.trigger` 回调。

Use sender `open_id` values in `ALLOWED_USER_IDS`; use chat `chat_id` values in `ALLOWED_CONVERSATION_IDS`. In Lark group chats, text, image captions, and slash commands must mention the bot. Unmentioned group messages are ignored.

`ALLOWED_USER_IDS` 应使用发送者 `open_id`；`ALLOWED_CONVERSATION_IDS` 应使用 chat `chat_id`。在 Lark 群聊中，文本、图片 caption 和 slash command 必须提及 bot；未提及的群消息会被忽略。

## Workspaces and Files / 工作区与文件浏览

Workspaces are first-level real directories under `WORKSPACE_ROOT`. Selecting a workspace binds the conversation to that workspace and starts or reuses the relay session for that `conversation + workspace`. Creating a missing workspace creates the directory and runs `git init`. Deleting a workspace physically removes that directory under `WORKSPACE_ROOT` and clears conversation bindings that pointed at it.

工作区是 `WORKSPACE_ROOT` 下的一级真实目录。选择工作区会将会话绑定到该工作区，并为该 `conversation + workspace` 启动或复用 relay session。创建不存在的工作区会创建目录并执行 `git init`。删除工作区会物理删除 `WORKSPACE_ROOT` 下对应目录，并清除指向它的会话绑定。

The file browser is read-only. It lists files not excluded by workspace `.gitignore` rules, hides `.git/`, and previews regular UTF-8 text files up to 256 KiB. Binary files, symlinks, ignored files, oversized files, and invalid paths are rejected.

文件浏览器是只读的。它会列出未被工作区 `.gitignore` 排除的文件，隐藏 `.git/`，并可预览最大 256 KiB 的普通 UTF-8 文本文件。二进制文件、符号链接、被忽略文件、超大文件和非法路径都会被拒绝。

## Images and Media / 图片与媒体

After a workspace is selected, IM image messages are downloaded into the selected workspace and sent to Codex as local image inputs. Captions become the prompt when available; otherwise the default prompt is `Please inspect the attached image(s).` Provider albums/media groups are buffered briefly and submitted to Codex as one prompt with multiple images.

选择工作区后，IM 图片消息会下载到当前工作区，并作为本地图片输入发送给 Codex。有 caption 时 caption 会作为提示词；否则使用默认提示 `Please inspect the attached image(s).` provider 的相册/media group 会短暂缓冲，并作为带多张图片的单个提示提交给 Codex。

Stored media lives under `.agent-relay/media/incoming` and `.agent-relay/media/outgoing` inside the workspace. The relay writes `.agent-relay/.gitignore` with `*`, so relay media does not appear in workspace Git status. `MEDIA_MAX_BYTES` limits downloads and outgoing images.

存储的媒体位于工作区内的 `.agent-relay/media/incoming` 和 `.agent-relay/media/outgoing`。relay 会写入 `.agent-relay/.gitignore`，内容为 `*`，因此媒体文件不会出现在工作区 Git 状态中。`MEDIA_MAX_BYTES` 会限制下载图片和输出图片的大小。

File/document attachments are intentionally not supported, including document uploads whose MIME type is an image.

文件/文档附件目前有意不支持，即使该文档 MIME type 是图片也不会作为图片处理。

## Relay Capabilities / Relay 能力

When `RELAY_CONTROL_ENABLED=true`, agent-relay starts a local HTTP API bound to `127.0.0.1` and injects a helper plus capability instructions into the Codex child process. The API uses a startup-scoped random bearer token passed only through the agent environment.

当 `RELAY_CONTROL_ENABLED=true` 时，agent-relay 会启动绑定到 `127.0.0.1` 的本地 HTTP API，并向 Codex 子进程注入 helper 和 capability instructions。该 API 使用启动时生成的随机 bearer token，并只通过 agent 环境变量传递。

### `send_image`

`send_image` is intended for remote H5/web UI debugging. Codex can render a page locally, save a screenshot inside the selected workspace, and send it back to the active IM chat:

`send_image` 主要用于远程 H5/web UI 调试。Codex 可以在本地渲染页面，将截图保存到当前工作区，并发送回当前 IM 会话：

```bash
"$AGENT_RELAY_HELPER" send-image /absolute/path/to/screen.png --cwd "$PWD" --caption "current screen"
```

The relay validates that the image is a regular PNG/JPG/WEBP/GIF inside the selected workspace, enforces `MEDIA_MAX_BYTES`, copies it to `.agent-relay/media/outgoing`, and sends it through the IM adapter.

relay 会校验图片是位于当前工作区内的普通 PNG/JPG/WEBP/GIF 文件，检查 `MEDIA_MAX_BYTES`，复制到 `.agent-relay/media/outgoing`，再通过 IM adapter 发送。

### `mention_agent`

When `RELAY_PEER_AGENTS_FILE` is set, the relay also registers `mention_agent`. This supports a multi-agent group-chat topology: run one `agent-relay` process per agent bot, put the bots in the same allowed group, and let each agent mention configured peers.

设置 `RELAY_PEER_AGENTS_FILE` 后，relay 还会注册 `mention_agent`。这支持多 agent 群聊拓扑：每个 agent bot 运行一个 `agent-relay` 进程，将这些 bot 放在同一个允许的群里，然后让每个 agent 提及已配置的 peer。

Example peer file:

peer 配置示例：

```json
[
  {
    "id": "designer",
    "name": "Designer",
    "telegramUsername": "designer_bot",
    "larkOpenId": "ou_designer"
  }
]
```

Example helper call:

helper 调用示例：

```bash
"$AGENT_RELAY_HELPER" mention-agent designer "Please review the UI state." --cwd "$PWD"
```

The relay sends an IM message mentioning that peer. It does not create local agent sessions for peers; each peer is handled by its own relay instance.

relay 会发送一条提及该 peer 的 IM 消息。它不会为 peer 创建本地 agent session；每个 peer 都由自己的 relay 实例处理。

## Runtime Notes / 运行说明

- Authorization requires `ALLOWED_USER_IDS`; if `ALLOWED_CONVERSATION_IDS` is set, both user and conversation must match.
- In group chats, unmentioned user messages are ignored before authorization, so unrelated group traffic does not receive unauthorized notices.
- Telegram startup skips pending updates, so messages sent while the relay was offline are ignored.
- Telegram polling subscribes to `message` and `callback_query` updates. Lark uses SDK long-connection event delivery.
- Transient Telegram API failures are retried with exponential backoff. Lark reconnect and outbound retry behavior is delegated to the SDK.
- The relay starts one agent provider process and creates or resumes one agent thread per `conversation + workspace`.
- SQLite stores workspaces, conversation bindings, sessions, thread IDs, Plan mode state, UI state, tasks, transcript events, pending prompts, approvals, paged output, and migration metadata.
- Runtime logs go to stdout. `debug` logs can include raw IM messages, Codex input text, and Codex output chunks.

- 授权要求配置 `ALLOWED_USER_IDS`；如果设置了 `ALLOWED_CONVERSATION_IDS`，用户和会话都必须匹配。
- 群聊中未提及 bot 的用户消息会在授权前被忽略，因此无关群消息不会收到 unauthorized 提示。
- Telegram 启动时会跳过 pending updates，因此 relay 离线期间发送的消息会被忽略。
- Telegram polling 订阅 `message` 和 `callback_query` updates。Lark 使用 SDK 长连接事件投递。
- Telegram 临时 API 失败会使用指数退避重试。Lark 重连和出站重试由 SDK 处理。
- relay 启动一个 agent provider 进程，并为每个 `conversation + workspace` 创建或恢复一个 agent 线程。
- SQLite 存储工作区、会话绑定、session、thread ID、Plan mode 状态、UI 状态、任务、转录事件、待处理提示、审批、分页输出和迁移元数据。
- 运行日志输出到 stdout。`debug` 日志可能包含原始 IM 消息、Codex 输入文本和 Codex 输出 chunk。

## Architecture / 架构

The relay controller depends on provider-neutral ports: `ImAdapter`, `AgentDriver`, and `RelayStore`. Runtime factories select concrete implementations from configuration. High-churn workflow code is split into command routing, callback routing, task coordination, output streaming, media handling, workspace flow, Codex prompt flow, and thread commands.

relay controller 依赖 provider-neutral port：`ImAdapter`、`AgentDriver` 和 `RelayStore`。运行时 factory 根据配置选择具体实现。高变化的工作流代码被拆分到 command routing、callback routing、task coordination、output streaming、media handling、workspace flow、Codex prompt flow 和 thread commands。

```text
src/
  main.ts        Bun entrypoint
  runtime/       Bootstrap, .env loading, validation, and allowlist checks
  domain/        IDs, session keys, logger, and workspace safety helpers
  ports/         Provider-neutral AgentDriver and ImAdapter contracts
  providers/     Codex provider, Telegram/Lark providers, and factories
  relay/         Controller, routers, task flow, media, capabilities, and UI state
  storage/       RelayStore port and SQLite implementation
  presentation/  Markdown/text rendering and provider-specific formatting
test/
  unit/          Focused unit tests
  integration/   Router, adapter, store, control API, protocol, and smoke tests
```

Extension points:

扩展点：

- IM providers implement `ImAdapter` under `src/providers/im/<provider>/`.
- Agent providers implement `AgentDriver` under `src/providers/agents/<provider>/`.
- Persistence implementations implement `RelayStore`; SQLite is the default.
- Agent-visible relay features live under `src/relay/capabilities/` and expose helper subcommands from `bin/agent-relay-helper`.

- IM provider 在 `src/providers/im/<provider>/` 下实现 `ImAdapter`。
- Agent provider 在 `src/providers/agents/<provider>/` 下实现 `AgentDriver`。
- 持久化实现需要实现 `RelayStore`；默认实现是 SQLite。
- agent 可见的 relay 功能位于 `src/relay/capabilities/`，并通过 `bin/agent-relay-helper` 暴露 helper 子命令。

## Development / 开发

Run type checks:

运行类型检查：

```bash
bun run typecheck
```

Run tests:

运行测试：

```bash
bun test
```

Run the full local check:

运行完整本地检查：

```bash
bun run check
```

Useful package scripts:

常用 package scripts：

| Script | Description |
| --- | --- |
| `bun run dev` | Start with file watching. 以 watch 模式启动。 |
| `bun run start` | Start the relay. 启动 relay。 |
| `bun test` | Run all tests. 运行全部测试。 |
| `bun run test:unit` | Run unit tests. 运行单元测试。 |
| `bun run test:integration` | Run integration tests. 运行集成测试。 |
| `bun run test:smoke` | Run smoke tests. 运行 smoke tests。 |
| `bun run typecheck` | Run TypeScript type checking. 运行 TypeScript 类型检查。 |
| `bun run check` | Run typecheck and tests. 运行类型检查和测试。 |

## Security and Privacy / 安全与隐私

- Keep `.env` private. It contains IM credentials, allowlisted IDs, workspace root, and local runtime settings.
- Treat `TELEGRAM_BOT_TOKEN`, `LARK_APP_SECRET`, `ALLOWED_USER_IDS`, and `ALLOWED_CONVERSATION_IDS` as sensitive operational data.
- Use `ALLOWED_CONVERSATION_IDS` when the relay should only operate in specific chats or groups.
- Keep `LOG_LEVEL=info` for normal use. `debug` logs can include raw messages, prompts, and agent output.
- Do not publish `.data/agent-relay.sqlite`; it can contain workspace names, bindings, thread IDs, transcript events, prompt state, approvals, and paged output.
- Review workspace repositories before publishing them. Relay media is stored under `.agent-relay/media` inside selected workspaces.
- The optional relay capability API binds to `127.0.0.1` and uses a startup-scoped bearer token. Do not expose it through a public proxy.

- 请保护好 `.env`。其中包含 IM 凭证、allowlist ID、workspace root 和本地运行配置。
- `TELEGRAM_BOT_TOKEN`、`LARK_APP_SECRET`、`ALLOWED_USER_IDS` 和 `ALLOWED_CONVERSATION_IDS` 都应视为敏感运维数据。
- 如果 relay 只应在特定聊天或群组中工作，请配置 `ALLOWED_CONVERSATION_IDS`。
- 常规使用建议保持 `LOG_LEVEL=info`。`debug` 日志可能包含原始消息、提示词和 agent 输出。
- 不要发布 `.data/agent-relay.sqlite`；其中可能包含工作区名称、绑定、thread ID、转录事件、prompt 状态、审批和分页输出。
- 发布工作区仓库前请检查内容。relay 媒体存储在所选工作区内的 `.agent-relay/media`。
- 可选 relay capability API 绑定到 `127.0.0.1` 并使用启动时生成的 bearer token。不要通过公网代理暴露它。

## Known Limitations / 已知限制

- Telegram and Lark are the implemented IM providers today.
- Codex is the only implemented agent provider today.
- File/document attachments are not supported.
- npm publication is not configured; `package.json` is private.

- 目前已实现的 IM provider 是 Telegram 和 Lark。
- 目前已实现的 agent provider 只有 Codex。
- 不支持文件/文档附件。
- 当前未配置 npm 发布，`package.json` 标记为 private。

## Contributing / 贡献

Contributions are welcome. Before opening a pull request, run:

欢迎贡献。提交 pull request 前请运行：

```bash
bun install
bun run check
```

Keep changes focused, include tests for behavior changes, and avoid committing local runtime files such as `.env`, `.data/`, logs, generated media, or workspace-specific artifacts.

请保持变更聚焦；行为变更应包含测试；不要提交 `.env`、`.data/`、日志、生成媒体或工作区特定产物等本地运行文件。

## Support / 支持

When opening an issue, include the Bun version, operating system, whether `codex` is available on `PATH`, the Codex CLI version if available, relevant configuration variable names, and redacted logs. Do not paste IM credentials, allowlisted IDs, private workspace paths, prompt text, or assistant output that should not be public.

提交 issue 时，请提供 Bun 版本、操作系统、`codex` 是否在 `PATH` 中可用、Codex CLI 版本（如可用）、相关配置变量名称以及脱敏日志。不要粘贴 IM 凭证、allowlist ID、私有工作区路径、提示词文本或不应公开的 assistant 输出。

## License / 许可证

`agent-relay` is licensed under the [MIT License](LICENSE).

`agent-relay` 使用 [MIT License](LICENSE) 授权。
