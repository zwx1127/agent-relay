# agent-relay

[![CI](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

## 项目介绍

`agent-relay` 可以让你通过 Telegram 或 Lark/飞书远程控制本地 Codex、Claude Code 或 DeepSeek Harness（`dsh`）agent。所选后端仍然运行在可信机器上，你可以在聊天软件里选择工作区、发送提示词、回答问题、审批操作、发起代码审查、管理线程，并收发截图、图片或文件。

它的目标很直接：让 agent 留在代码所在的机器上，同时让你可以从常用聊天工具里操作它。

### 演示

<table>
  <tr>
    <th>Telegram 单聊</th>
    <th>Telegram 群聊 topic 模式</th>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <video src="https://github.com/user-attachments/assets/2109bbbf-35d5-4f10-b712-409d318fdde6" width="360" controls></video>
    </td>
    <td width="50%" valign="top">
      <video src="https://github.com/user-attachments/assets/48aca05e-20f4-47f8-ac80-d93c6a4ecf60" width="360" controls></video>
    </td>
  </tr>
  <tr>
    <th>飞书单聊</th>
    <th>飞书群聊 topic 模式</th>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <video src="https://github.com/user-attachments/assets/b3bda23d-0eb0-402b-996c-b134562e4772" width="360" controls></video>
    </td>
    <td width="50%" valign="top">
      <video src="https://github.com/user-attachments/assets/13889a04-a32b-4ef4-beae-2df48f2a674d" width="360" controls></video>
    </td>
  </tr>
</table>

## npm / npx 安装

准备好 Node.js 20+ 和 npm 后，在交互式终端运行以下命令，无需克隆源码或预装全局 Bun：

```bash
npx @asuka1127/agent-relay install
```

> **包名**：请使用 [`@asuka1127/agent-relay`](https://www.npmjs.com/package/@asuka1127/agent-relay)。无 scope 的 `agent-relay` 属于另一个项目，请勿用 `npx agent-relay` 或 `npm install -g agent-relay` 安装本项目。

`install` 是唯一的“安装并配置”入口：先预览包版本及安装位置，经确认后将当前 scoped 版本持久安装到用户自己的 npm prefix，再打开已安装副本的**英文配置向导**。保存配置不会启动 relay。

> 多后端支持尚未发布。已发布的 npm 0.2.0 仍只支持 Codex；下次发版前，请用本地打包的源码测试 Claude Code 或 DSH。

### 最低要求

- Node.js 20+ 和 npm。npm 安装包自带官方固定版本的 Bun，详见[运行时说明](#安装位置与运行时)。
- 单独安装并配置原生后端：Codex CLI 0.145.0+（`CODEX_BIN`）、Claude Code 2.1.285（`CLAUDE_BIN`），或 DeepSeek Harness 0.2.0-rc.2 开发预览版（`DSH_BIN`）。可执行文件应位于 `PATH`，或指定绝对路径。已验证版本和限制见[后端支持与原生命令](docs/en/backends.md)。
- Git，用于 Codex 工作区和版本控制操作；仅安装 npm 包不需要 Git。
- Telegram bot token，或 Lark/飞书自建应用。创建机器人/应用和账号登录需自行完成。

### 配置机器人

向导先选择原生后端，再配置机器人凭据、用户/会话白名单、工作区根目录、SQLite 状态文件及可执行文件。Codex 单独提供沙箱、审批选项和实验性 Gateway；Claude 和 DSH 的原生设置与认证保留在各自配置中。工作区根目录应选择代码/项目目录，而非安装目录。请在可信机器上运行，并只允许可信用户访问。

- **Telegram**：通过 [BotFather](https://t.me/BotFather) 创建机器人，填入 token 和本人数字 user ID。完整步骤见 [Telegram 快速上手](docs/en/quickstart-telegram.md)。
- **飞书/Lark**：在[飞书开发者后台](https://open.feishu.cn/app)或 [Lark 开发者后台](https://open.larksuite.com/app)创建自建应用，启用机器人能力，填入 App ID/Secret 和该应用专属的 `open_id` 白名单。先保存配置并启动 relay，**再保存长连接订阅**。按 [Lark/飞书快速上手](docs/en/quickstart-lark.md)完成权限、消息事件、卡片回调、版本发布和可用范围设置。

Secret 输入会被掩码；只有明确同意后，才会把凭据发送到所选平台的官方 API 做只读检查。Telegram 检查仅调用 `getMe`、`getWebhookInfo`，不会消费 `getUpdates` 或删除已有 webhook。检查不能证明消息链路、平台权限或应用发布已经完成。向导不会自动创建机器人、修改 webhook、配置平台后台、安装 Gateway 代理或启动 relay。

## 快速上手

保存配置后：

1. 执行**安装器打印的 `doctor` 命令**，检查本地配置、路径、Bun 和所选后端版本。它不会验证机器人认证、后端登录或消息收发。
2. 执行**打印的 `start` 命令**，并保持前台进程运行。飞书/Lark 用户此时应按[快速上手](docs/en/quickstart-lark.md#3-start-the-connection-then-finish-console-setup)完成平台后台设置。
3. 打开与机器人的私聊，发送 `/relay`。
4. 选择或创建工作区，发送普通提示词，并测试卡片按钮来回答问题或审批操作。

打印的命令包含可执行文件绝对路径和所选配置文件。**安装器不会修改 `PATH`。** 如果按照提示手动添加了 `PATH`，可以使用以下简写：

```bash
agent-relay doctor
agent-relay start
```

下文命令示例均假设已安装入口在 `PATH` 中，否则请替换为安装器打印的绝对路径。如果选择了自定义配置文件，请保留打印的 `--config` 参数。以后重新配置时，运行已安装副本的 `install` 命令即可。如果安装后取消了配置，包仍会保留；再次运行打印的 `install` 命令继续配置。

## 能做什么

- 通过 Telegram 或 Lark/飞书远程控制本地 Codex、Claude Code 或 DeepSeek Harness 会话，保留各后端原生命令与能力边界。
- 在聊天里选择、创建、浏览、删除工作区。
- 发送普通提示词、图片、语音/音频、文件提及、技能和运行中的补充指令。
- 在可编辑的活动卡片中查看推理摘要、计划进度、工具、文件改动、警告和 diff；较长的详情保留 24 小时。
- 在聊天里回答原生问题（包括多选），审批选项与范围以当前后端实际提供的内容为准。
- 支持私聊和指定群聊；群聊消息只有提及 bot 时才会被处理。
- 使用 review、Plan mode、goal、resume、fork、side conversation、interrupt、后台终端清理等常见 Codex 工作流。
- 通过可选的本地 relay 能力 API，把截图、生成图片或文件发回聊天窗口。
- 可以把多个 agent-relay bot 放在同一个群里，让 agent 提及已配置的 peer bot 协作。
- 继续扩展更多 IM provider 或 Agent backend。

## 日常使用

### 聊天命令

`/help` 显示所选后端的实时命令列表。Claude 和 DSH 命令保留原生参数及含义，不会误调用 Codex 命令，也不会把未知命令悄悄当作提示词发送。保留原有 `/relay` 工作区和状态面板，会话指令沿用各后端原生写法。DSH 使用 `/new` 新建会话、`/resume [搜索词]` 选择历史会话；这两个快捷指令由 Relay 映射到 DSH 原生会话 API。中断仍使用活动卡上的 Interrupt 按钮，不引入新的 `/relay` 子命令。下面的原有命令表适用于 **Codex**；Claude 和 DSH 见[后端命令矩阵](docs/en/backends.md)。

先发送 `/relay`。Relay Home 会显示当前工作区、agent 状态、等待状态、最近错误和可用操作。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看支持的命令。 |
| `/relay` | 打开 Relay Home。 |
| `/review` | 审查当前工作区改动。 |
| `/plan` | 为当前 Codex 线程切换 Plan mode。 |
| `/plan --on` / `/plan --off` | 显式选择 Plan 或 Default mode。 |
| `/plan <prompt>` | 进入 Plan mode 并执行提示词。 |
| `/goal <objective>` | 为当前 Codex 线程设置目标。 |
| `/resume` | 选择最近的 Codex 线程，并立即显示其最新 turn 状态。 |
| `/side [prompt]`, `/btw [prompt]` | 进入或继续多轮临时 side conversation；使用 **Return to main** 返回主会话。 |
| Activity/Goal 卡片按钮 | 中断当前 turn 或管理 Goal；按钮文案保持英文。 |
| `/ps` | 查看 Codex 后台终端。 |
| `/skills [search]` | 选择 Codex 技能，再回复具体任务。 |
| `/mention [search]` | 选择工作区文件或目录，再回复具体任务。 |
| `/stop` | 要求 Codex 清理后台终端。 |

在群聊里发送文本、图片、文件或 slash command 时，需要提及 bot。普通 bot 提及应作为独立 token 使用，例如 `/relay @relay_bot` 或 `@relay_bot review this change`；Telegram 原生的 `/relay@relay_bot` 命令格式也会兼容。如果 bot 只应该在指定群里工作，请配置 `ALLOWED_CONVERSATION_IDS`。

### CLI 命令

| 命令 | 用途 |
| --- | --- |
| `agent-relay` / `agent-relay start` | 以前台方式运行。缺少配置时退出并提示运行 `install`，不会打开向导。 |
| `agent-relay install` | 安装并配置，或重新配置当前持久安装。执行 npm 安装和保存前分别需要确认；Ctrl+C 或拒绝保存不会改写已有配置。 |
| `agent-relay doctor` | 检查本地配置、路径、Bun 和所选后端，不访问机器人 API。 |
| `agent-relay config path` | 仅显示所选配置文件位置，不显示 secret。 |
| `agent-relay gateway <setup\|start\|stop\|status\|remove>` | 管理需手动启用的[实验性 Gateway](#实验性功能接力工作)。 |

### 群聊和 agent 团队

agent-relay 支持私聊，也支持群聊。群聊适合作为一个共享的 agent 操作室。

- 把 bot 加入群聊，并用 `ALLOWED_CONVERSATION_IDS` 允许这个群。
- 发送文本、图片/文件 caption 和 slash command 时提及 bot；普通 `@bot` 或 `@BotName` 前后用空格分隔。
- 未提及 bot 的群聊消息会在授权检查前被忽略。
- Telegram 论坛话题和 Lark/飞书线程会被视为独立 scope，因此同一个群里的不同话题或线程可以各自选择 workspace，并行运行所选后端的独立会话。
- 如果希望多个 agent 在同一个群里协作，每个 agent bot 运行一个 agent-relay 进程。
- 如果希望 Codex 主动提及另一个 agent bot，需要配置 peer agents 并开启本地 relay 能力 API。

[Telegram](docs/en/quickstart-telegram.md#4-optional-group-chat-setup) 和 [Lark/飞书](docs/en/quickstart-lark.md#4-optional-group-chat-setup) 快速上手文档里有更具体的群聊配置步骤。

## 进阶配置

<a id="配置向导与日常命令"></a>

### 配置位置与安全

配置保存在安装包和工作区之外：Linux/macOS 默认 `$XDG_CONFIG_HOME/agent-relay/config.json` 或 `~/.config/agent-relay/config.json`；Windows 为 `%APPDATA%\agent-relay\config.json`。用 `--config /absolute/path/config.json` 或 `AGENT_RELAY_CONFIG` 指定其他位置。POSIX 下新建目录权限为 0700，配置以 0600 原子写入；对于已有的共享目录会拒绝保存，不会擅自修改目录权限。Windows 下应存放在自己的用户目录，并使用仅本人可访问的 ACL。配置内的凭据以明文保存，切勿提交或分享。

向导保存的 workspace/SQLite 路径均为绝对路径，不随启动目录变化。默认状态文件位于配置旁的 `state/agent-relay.sqlite`；工作区根目录应该是代码/项目目录，不是 npm 安装目录。shell 环境变量优先于保存的配置。新 CLI 不会自动读取当前启动目录中的 `.env`。

### 迁移已有配置

从源码方式迁移已有配置（不会改写原 `.env`）：

```bash
agent-relay install --env-file /absolute/path/to/agent-relay/.env
# 或只使用该文件启动一次，不写入用户配置：
agent-relay start --env-file /absolute/path/to/agent-relay/.env
```

仅迁移已知的 relay 设置；相对文件路径以显式 `.env` 所在目录为基准。该次运行中 `--env-file` 替代用户配置文件作为来源，shell 环境变量仍优先。非交互/CI 场景不会弹出向导：先准备好私有配置或 `.env`，再指定路径运行。不要把 secret 放到命令行参数中。

### 安装位置与运行时

首次安装的默认 npm prefix 独立于源码目录及 npx 缓存：

- Linux/macOS：`$XDG_DATA_HOME/agent-relay/npm`，未设置时为 `~/.local/share/agent-relay/npm`
- Windows：`%LOCALAPPDATA%\agent-relay\npm`，未设置时为 `~\AppData\Local\agent-relay\npm`

通过 `install --prefix /absolute/path/to/private/prefix` 选择其他由自己拥有的安装目录。`--config` 和 `--env-file` 会传给向导。用户可写的 prefix 不需要管理员权限。安装器不会修改 shell 配置或 `PATH`，而是打印可以立即使用的带引号绝对路径命令。Unix 的入口为 `<prefix>/bin/agent-relay`，Windows 为 `<prefix>\agent-relay.cmd`。如需使用文中简写的 `agent-relay` 命令，请按安装器打印的可选说明手动加入 `PATH`。

从持久安装的可执行文件运行 `install` 时，会自动识别并复用该安装自己的 prefix，包括自定义 `--prefix` 和常规 npm 全局安装目录。重新配置时无需再次指定 `--prefix`；显式指定它则会选择其他安装位置。

npm 安装成功后，如果取消配置或保存失败，包仍会保留。使用打印的 `install` 命令重新配置；只有确认保存后才会改写已有配置。

npm 方式需要 Node.js 20+ 和 npm，包含官方 [`bun@1.3.11`](https://www.npmjs.com/package/bun/v/1.3.11) 运行时依赖、对应平台的二进制及非交互安装脚本，**无需预装全局 Bun**。运行时支持 Linux/macOS/Windows 的 x64/arm64，系统限制见 [Bun 安装文档](https://bun.com/docs/installation)。运行时二进制会增加约 100 MB 的安装体积。`install` 会显式调用 npm；正常运行的 relay 启动器不会下载程序。使用 `--ignore-scripts` 或 `--omit=optional` 可能导致 Bun 不可用，此时正常重新安装，或把 `AGENT_RELAY_BUN_PATH` 指向已安装的兼容 Bun 可执行文件。

重复运行 `install` 时会复用已通过运行检查的同版本安装并重新进入配置。损坏的副本会先请求确认再重新安装；显式指定 `--package` 时会重新安装该 tarball。

### 其他方式：npm 全局安装

如果希望自己管理常规 npm 全局安装，也可以使用下面的替代方式。普通 `npm install -g` 不会自动打开向导：

```bash
npm install -g @asuka1127/agent-relay
agent-relay install
```

第二条命令会配置当前全局安装，不会在默认用户 prefix 中另建副本。

### 实验性功能：接力工作

共享 Gateway 仍然仅支持 Codex；为 Claude 或 DSH 启用会直接报错。这两个后端使用各自原生协议和会话存储。

> **本功能处于实验阶段、默认关闭，并且只能手动开启。** 在正式稳定前，其接口和启用方式可能发生不兼容变化。未手动开启时，它不会启动 Gateway、安装客户端代理，也不会改变现有 Relay、Codex CLI 或 Codex 桌面版的任何行为。

“接力工作”允许你先在原生 Codex CLI 或 Windows/macOS Codex 桌面版开始工作，离开电脑后再通过 Telegram 或 Lark/飞书继续同一个 Codex thread。Relay、交互式 Codex CLI 进程和 Codex 桌面版统一连接一个独立的本地 Gateway，由其唯一 app-server 管理 thread；用户正常启动 Codex，无需选择远端入口。

![实验性接力工作架构：Codex 与 IM 通过同一 thread 双向互通实时进度和控制信息](docs/assets/relay-work-overview.png)

npm 持久安装后先执行一次 `agent-relay gateway setup`（源码方式使用 `scripts/gateway.* setup`），需要接力工作时再手动启动 Gateway。若安装目录不在 `PATH` 中，请使用已安装入口的绝对路径。长期运行 Gateway 时不要使用可能被清理的 npx 缓存；移动或升级安装位置后应重新执行 setup。

- Gateway 与 Relay 使用独立的脚本和生命周期，而 Gateway 与唯一 app-server 属于同一故障域。
- 使用 `/resume` 加入已有 thread。多个原生 Codex 客户端和 IM scope 可以共享同一个 thread，不设归属限制。新的用户消息、agent 进度和 Relay 支持的 thread 指令状态会同步到其他已加入的 scope；活动 turn 中的普通输入使用 Steer 语义，审批或输入请求由第一个回答的客户端胜出。
- BTW 模式是例外：临时子会话及其输入、输出和状态仅保留在发起它的 IM scope 中，不会进入共享 Gateway 状态或主线程记录。
- Gateway 模式继承共享 app-server 的 Codex 配置。Relay 请求不会覆盖这些配置，唯一例外是用户明确选择 Default 或 Plan 后的一次性模式切换。
- 有界指令快照只存在于 Gateway 内存中，可跨 Relay 重启/清理恢复，但不能跨 Gateway/app-server 重启；此时采用 Codex 原生重启语义，包括 Plan 回到 Default。
- 不提供 Queue 操作，不增加语义状态 journal，也不重放或事后追赶离线输出。

请阅读[实验性接力工作](docs/en/experimental-relay-work.md)，了解 Windows、macOS 和 Linux 设置、生命周期语义以及完整移除方法。

## 开发与扩展

### 从源码运行（保留原方式）

源码开发需要 Git 和 Bun 1.3+。如需使用与 npm 用户相同的配置向导：

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
npm pack
bun run cli install --package /absolute/path/asuka1127-agent-relay-0.3.0-next.2.tgz
bun run cli start
```

请使用 `npm pack` 实际输出的 tarball 文件名，并把示例路径替换为它的真实绝对路径。`bun run cli install` 仍执行持久 npm 安装流程，需要 Node.js 20+ 和 npm，并打开已安装副本的向导，不会运行单独的源码配置入口。之后，源码 CLI 和已安装 CLI 均可使用保存的私有配置。

原 `.env` 工作流仍可用：复制 `.env.example` 为 `.env`，编辑后运行 `bun run start`。源码 `bun run start` 继续读取当前源码目录的 `.env`；`bun run cli start` 则使用新的用户级配置。`scripts/relay.*` 生命周期脚本仍仅服务源码目录，不随 npm 包安装；npm 安装后可将前台 CLI 交给自己的进程管理器。

### 从本地源码或 release tarball 安装

如需测试本地构建或分发 release tarball，可在源码目录中准备本地包：

```bash
npm install
npm pack
```

使用 `npm pack` 实际输出的文件名，将下面两处路径替换为该文件的真实绝对路径，再用一条命令安装并进入配置：

```bash
npx --package=/absolute/path/asuka1127-agent-relay-0.3.0-next.2.tgz agent-relay install --package /absolute/path/asuka1127-agent-relay-0.3.0-next.2.tgz
```

前一个 `--package` 告诉 npx 从哪里运行安装器，后一个告诉安装器持久安装哪个本地 tarball，而不是下载 registry 版本。tarball 中的 scoped 包名和版本必须匹配。只使用可信的安装包：npm 会安装依赖并执行依赖的安装脚本。

### 用它扩展它自己

agent-relay 的一个重要用法，是用正在运行的 agent-relay 远程迭代 agent-relay 本身。

1. 把这个仓库作为当前工作区启动 agent-relay。
2. 在 Telegram 或 Lark/飞书里要求 Codex 增加新的 IM provider 或 Agent backend。
3. 让 Codex 参考现有 provider 接口和实现。
4. 要求它同步更新配置、工厂、文档和测试。
5. 在聊天里触发 `bun run typecheck` 和 `bun test` 验证。

主要扩展点：

- IM provider：`src/ports/im.ts` 和 `src/providers/im/`。
- Agent provider：`src/ports/agent.ts` 和 `src/providers/agents/`。
- agent 可见的本地能力：`src/relay/capabilities/`。

更多流程见 [扩展 agent-relay](docs/en/extending-agent-relay.md)。

## 项目状态

当前 provider：

- IM：Telegram、Lark/飞书。
- Agent：Codex CLI app-server。
- 存储：SQLite。

已知限制：

- 暂不支持文件夹附件及自动解压。
- 当前只有 Codex 这一种 Agent backend。

## 使用指南与问题排查

除本 README 外，项目文档、配置向导和用户界面均使用英文；以下链接指向维护中的英文指南。

- [Telegram 快速上手](docs/en/quickstart-telegram.md)
- [Lark/飞书快速上手](docs/en/quickstart-lark.md)
- [常见问题排查](docs/en/troubleshooting.md)
- [扩展 agent-relay](docs/en/extending-agent-relay.md)
- [实验性接力工作](docs/en/experimental-relay-work.md)（默认关闭）

### 贡献和支持

- 提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 报告敏感问题前请阅读 [SECURITY.md](SECURITY.md)。
- 提交安装或运行问题前，请先查看 [常见问题排查](docs/en/troubleshooting.md)。
- 版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

`agent-relay` 使用 [MIT License](LICENSE) 授权。

## 项目交流群

扫描下面的 Telegram 二维码加入项目交流群。

<img src="docs/assets/telegram-group-qr.jpg" alt="Telegram 群组二维码" width="240">
