# 实验性接力工作

> **本功能仍处于实验阶段，并且默认关闭。** 在正式稳定前，接口和启用方式可能发生不兼容变化。只有手动开启后，它才会影响 Relay、Codex CLI 或 Codex 桌面版。

实验性接力工作会为当前操作系统用户长期运行一个独立的 Codex Gateway。Gateway 是本机数据面代理，并拥有唯一的 Codex app-server 子进程；Relay、原生 Codex CLI 进程，以及 Windows/macOS Codex 桌面版都通过它继续处理同一批 Codex thread。

![实验性接力工作架构：Codex 与 IM 通过同一 thread 双向互通实时进度和控制信息](../assets/relay-work-overview.png)

## 开启

先在 `.env` 中显式加入：

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=true
# 以下为可选配置及其默认值。
EXPERIMENTAL_RELAY_GATEWAY_PORT=18765
EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH=.data/agent-relay-gateway.json
```

安装当前用户登录时的 Gateway 启动项，并立即启动：

```powershell
.\scripts\relay.ps1 gateway-install
```

```bash
./scripts/relay.sh gateway-install
```

随后启动或重启 Relay。实验模式下，Relay 重启会保留 SQLite 数据，也不会停止独立 Gateway。可以分别使用 `gateway-status` 和 `status` 检查两个进程。

Gateway 只监听 `127.0.0.1`。状态文件会记录 Gateway URL、Gateway PID 和其唯一 app-server 子进程 PID。

## 原生 CLI 与 Windows/macOS Codex 桌面版

CLI 和桌面接入需要再次显式开启：

```powershell
.\scripts\relay.ps1 clients-enable
```

```bash
./scripts/relay.sh clients-enable
```

命令会编译名为 `codex` 的本地代理、保存原来的用户 `Path` 和 `CODEX_CLI_PATH`，再将代理目录放在用户 `Path` 最前面。打开新终端后可以直接运行：

```bash
codex -C /path/to/workspace
codex resume --last
codex fork --last
```

这些交互入口会自动取得唯一配置的 Gateway URL。实验代理会禁用公开的 `--remote` 模式，包括自定义地址和远端认证选项。代理只在内部使用 Codex 的 WebSocket TUI 传输；这是实现细节，不是用户可以选择的另一条连接路径。

开启该接入后，凡是会启动独立本地 agent 或服务、又无法加入共享 app-server 的命令都会被拒绝，包括 `exec`/`e`、`review`、`mcp-server`、`remote-control`、`exec-server`，以及 app-server 的 `daemon`/`proxy`。这些命令的帮助仍可查看。登录、更新、诊断、补全、协议结构生成等不会创建 agent 的管理命令仍会直接交给真实 Codex CLI。

完成后还需要重启 Codex 桌面版。相同代理会保持桌面版所需的 app-server JSONL 协议，并把数据转发到共享 WebSocket Gateway。原来的 `desktop-enable`/`desktop-disable` 命令保留为兼容别名。

Windows 使用用户环境变量；macOS 还会创建用户级 LaunchAgent，确保重新登录后 CLI `Path` 和从 Finder 启动的应用都能取得代理配置。

## 多个 Codex 进程和多个 thread

- 多个桌面版、CLI 或 Relay 客户端可以同时连接同一个 Gateway；Gateway 不会为每个客户端再启动 app-server。
- 每个客户端拥有独立 WebSocket 连接，但 thread 状态仍由同一个 app-server 管理。
- 只有当前 workspace 和目标 workspace 都空闲时，才能在 Relay Home 中切换 workspace。存在活动 turn、审批、用户输入请求，或处于 waiting/queued/running/blocked 状态的 Relay task 时，切换会被拒绝，当前 workspace 保持不变。
- 空闲切换只会释放 Relay 对旧 workspace 的订阅，不会停止它的 Codex thread；该 thread 会保留以供之后 `/resume`。随后 IM scope 只绑定到新目录。再次选择当前 workspace 是无操作行为。
- 选择 workspace 不会启动或恢复 thread。切换后的第一条普通 IM 消息会在所选目录中启动新 thread；只有显式使用 `/resume` 才会加入已有 thread。
- 使用 `/resume [search]` 或 Relay Home 中的 **Resume**，把 IM scope 绑定到已有 thread。两个入口复用同一个选择器和 Codex TUI 的切换语义。
- 接力工作不会因为收到普通 IM 消息就自动绑定活动 thread 或之前持久化的 thread。没有显式执行 `/resume` 时，该消息会启动新 thread。
- 当来源 scope 存在活动 turn、审批、用户输入请求或忙碌的 Relay task 时，`/resume` 会拒绝切换。来源 scope 空闲时，可以恢复一个已经活动的目标 thread。
- 多个原生 Codex 客户端和多个 IM scope 可以恢复同一个 thread；不存在单写者或归属限制，由用户决定哪个已连接客户端发送输入。
- 关闭或切换一个客户端只会释放它自己的订阅。Relay 最后一个逻辑 scope 离开后才发送 `thread/unsubscribe`，释放客户端不会停止共享工作；显式使用 **Interrupt** 或 **Stop** 仍会取消共享的活动 turn。

Gateway 只同步实时事件：Codex、Gateway、Relay 都已启动，并且客户端已经关联同一 thread 后产生的新进度才会转发。Gateway 不保存进度历史，Relay 不维护消费游标，也不会在重连后补发任一进程停止或尚未启动期间的输出。恢复时只读取用于识别当前活动状态的最新 turn 摘要，不会渲染已完成历史，也不会把离线输出追赶到 IM。

同一项审批、用户输入请求或 MCP elicitation 可以显示在关联该 thread 的所有已连接客户端上。第一份有效响应胜出，后续响应会被拒绝，resolved 通知会清除其他客户端上的重复控件。

活动 turn 期间发送的普通 IM 输入与 Codex TUI 的 **Enter / Steer** 语义一致，并携带预期的活动 turn id。接力工作不提供 TUI 的 **Tab / Queue** 操作，也不会在 Gateway 或 thread 层增加输入锁或队列；Relay 仅保持每个 scope 内部的发送顺序。

## 关闭并恢复默认行为

保持实验开关开启时先运行：

```bash
bun run relay-work disable
```

该命令会从用户 `Path` 移除实验代理、恢复之前的桌面 `CODEX_CLI_PATH`、删除 Gateway 登录启动项，并请求关闭 Gateway。然后将配置改回：

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=false
```

Relay 重启后会恢复原有本地 stdio `CodexDriver` 路径：不读取 Gateway 状态、不添加 Relay Home Resume 动作，也不修改桌面环境。

## 故障策略

实验链路采用 fail closed。Gateway 不可用时，交互式 CLI、桌面代理和 Relay 会明确报错，不会静默启动第二个 app-server。可使用 `gateway-status` 检查状态，查看 Gateway 状态文件旁的 `.log`，排除端口或 Codex CLI 问题后运行 `gateway-start`。
