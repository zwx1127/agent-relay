# 实验性接力工作

> **实验功能，默认关闭，必须手动启用。** 在功能稳定前，接口和启用方式可能发生不兼容变化。只有显式启用并完成设置后，才会影响 Relay、Codex CLI 或 Codex 桌面版。

接力工作让原生 Codex CLI、受支持的 Codex 桌面版和 IM Relay 通过一个本地 Gateway 及其唯一权威 Codex app-server 继续处理同一批 Codex thread。

![实验性接力工作架构：Codex 与 IM 通过同一 thread 双向互通实时进度和控制信息](../assets/relay-work-overview.png)

## 设置与手动生命周期

先在 `.env` 中加入实验开关：

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=true
# 可选：
EXPERIMENTAL_RELAY_GATEWAY_PORT=18765
# EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH=/absolute/path/to/gateway-state.json
```

Gateway 的运行状态、日志、启动器配置和安装记录默认位于 `~/.agent-relay/experimental-relay-work/`。Relay 仓库内的 `.data` 和 `logs` 与之独立；Relay 的清理和重启不会删除 Gateway 数据。

只需执行一次 setup。它会安装永久 Codex 启动器和客户端环境、初始化持久 `local` 模式，但**不会启动 Gateway**：

```powershell
.\scripts\gateway.ps1 setup
```

```bash
./scripts/gateway.sh setup
```

完成后打开新终端；Windows 和 macOS 还需要重启 Codex 桌面版。Relay 与 Gateway 使用独立脚本，并且都由用户手动启动：

```powershell
.\scripts\relay.ps1 start
.\scripts\gateway.ps1 start
```

```bash
./scripts/relay.sh start
./scripts/gateway.sh start
```

所有平台都不会创建 Gateway 登录启动项、服务、计划任务或其他自动启动机制。Gateway 命令语义如下：

```text
gateway setup    安装启动器并初始化 local 模式，不启动 Gateway
gateway start    要求先完成 setup；健康检查通过后切换为 gateway 模式
gateway stop     先切换为 local 模式，再停止 Gateway；保留设置
gateway status   只读显示设置、模式、PID、健康、URL、状态文件和启动器
gateway remove   切换 local、停止进程、恢复客户端环境并删除数据
```

package 级入口为 `bun run gateway <command>`。不保留 `gateway-install`、`clients-enable`、`desktop-enable` 及对应 disable 命令的兼容别名。

## 各平台客户端接入

- **Windows：** setup 安装 `codex.exe` 启动器，将目录加入用户 `Path` 最前方，并把用户级 `CODEX_CLI_PATH` 指向启动器，供 Codex 桌面版使用。
- **macOS：** setup 安装 `codex` 启动器，并创建只负责设置 `PATH` 和 `CODEX_CLI_PATH` 的客户端环境 LaunchAgent。这些 LaunchAgent 永远不会启动 Gateway。
- **Linux：** setup 根据 `$SHELL` 仅配置当前 Bash、Zsh 或 Fish，在 `~/.bashrc`、`~/.zshrc` 或 Fish `conf.d` 中加入可重复执行、可移除的受管 PATH 片段。Linux 当前只接入 Codex CLI；不宣称支持尚不存在的官方 Linux Codex 桌面版，仅为未来官方应用预留适配位置。

永久启动器在每次新启动时读取持久模式：

- `local` 模式把普通 Codex 命令原样交给真实 CLI。
- `gateway` 模式自动把交互式 TUI 和桌面 app-server 连接到 Gateway。用户只需正常运行 `codex`、`codex resume` 或 `codex fork`。
- 启动器安装期间，用户提供的 `--remote` 和远端认证选项始终被拒绝。启动器内部可以使用 Codex WebSocket 传输，但这不是暴露给用户的连接模式。
- `gateway` 模式会拒绝无法加入共享 app-server、会创建独立 agent 或 server 的命令，包括 `exec`/`e`、`review`、`mcp-server`、`remote-control`、`exec-server` 和 app-server `daemon`/`proxy`。帮助和管理命令仍会透传。停止 Gateway 后，新进程回到 local 模式，这些命令恢复正常。

模式切换只影响新进程和新连接。切换后应重新启动 Codex CLI/桌面版；已连接进程不会在两种传输之间自动迁移。

## Relay 行为与故障语义

Relay 永远不会启动 Gateway。实验开关启用但当前为 local 模式时，Relay 自身仍可在线；需要 Codex 的 IM 操作会明确提示 Gateway 已停止，并要求用户运行 Gateway start。Gateway 启动后，下一次 Relay 操作会懒连接，无需重启 Relay，也不会回退为自行启动 stdio app-server。

显式执行 `gateway stop` 时，会先把持久模式写为 `local`，再停止进程。Gateway 或 app-server 意外退出时，持久模式故意保留为 `gateway`；新的 CLI、桌面版和 Relay 连接会 fail closed，直到用户运行 `gateway start` 恢复，防止静默创建第二个 app-server 导致 thread 分叉。

`gateway start` 必须在成功 setup 后运行。`gateway remove` 会先切换 local 并停止 Gateway，再修改客户端环境；如果停止失败，remove 会中止并保留启动器与安装状态，方便安全重试。

## Thread、workspace 与多客户端

- 多个 CLI、桌面版和 Relay 客户端可连接同一个 Gateway。每个客户端有独立 WebSocket 连接，但只由一个 app-server 管理权威状态。
- 多个原生客户端和多个 IM scope 可以 `/resume` 同一个 thread。Relay 不增加单写者或所有权限制，由用户决定哪个客户端发送输入。
- `/resume` 复用 Codex TUI 的恢复语义。来源 scope 存在活动 turn、审批、用户输入请求或其他忙碌 Relay task 时，会拒绝切换。
- `/resume` 成功后，Relay 会根据最近 turn 摘要立即显示活动卡片。活动 turn 会继续更新同一张卡；已完成、中断、失败或没有 turn 的 thread 会显示对应终态或 Idle 状态。
- Relay Home 选择 workspace 只绑定目录，不会让已运行的原生 Codex 进程切换目录，也不会自动绑定 thread。第一条普通消息会新建 thread；只有 `/resume` 会显式加入已有工作。
- 空闲 workspace 切换只释放 Relay 的旧订阅，不停止 thread；忙碌时会拒绝切换。
- 活动 turn 期间的普通 IM 输入采用 Codex TUI Enter/Steer 语义。接力工作不增加 Tab/Queue、Gateway 输入锁或 thread 所有权锁。
- 审批、用户输入和 MCP elicitation 可以出现在关联同一 thread 的全部已连接客户端中。第一份有效响应胜出，resolved 通知会清除重复控件。

Gateway 只转发 Codex、Gateway、Relay 同时运行且关联同一 thread 后产生的新实时事件。它不保存进度历史、消费游标、离线队列、重放或追赶流。恢复时只读取最新 turn 摘要来生成即时活动状态卡，不会把错过的对话输出补发到 IM。

## 停止或移除

临时让新的 Codex 进程回到正常本地模式，同时保留设置：

```powershell
.\scripts\gateway.ps1 stop
```

```bash
./scripts/gateway.sh stop
```

移除启动器、恢复 Windows/macOS 原环境或删除 Linux 受管 shell 片段，并删除 Gateway 用户数据：

```powershell
.\scripts\gateway.ps1 remove
```

```bash
./scripts/gateway.sh remove
```

最后把 `EXPERIMENTAL_RELAY_WORK_ENABLED=false` 并重启 Relay，即可恢复原有本地 stdio driver。该功能始终默认关闭。
