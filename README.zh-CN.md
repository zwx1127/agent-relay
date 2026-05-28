# agent-relay

[![CI](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

`agent-relay` 可以让你通过 Telegram 或 Lark/飞书远程控制本地 Codex CLI agent。Codex 仍然运行在可信机器上，你可以在聊天软件里选择工作区、发送提示词、回答问题、审批操作、发起代码审查、管理线程，并收发截图或图片。

它的目标很直接：让 agent 留在代码所在的机器上，同时让你可以从常用聊天工具里操作它。

## 能做什么

- 通过 Telegram 或 Lark/飞书远程控制本地 Codex 会话。
- 在聊天里选择、创建、浏览、删除工作区。
- 发送普通提示词、图片和运行中的补充指令。
- 直接在聊天里回答 Codex 问题和审批操作。
- 使用 review、Plan mode、goal、resume、fork、side conversation、interrupt、后台终端清理等常见 Codex 工作流。
- 通过可选的本地能力 API，把截图或生成图片发回聊天窗口。
- 继续扩展更多 IM provider 或 Agent backend。

## 快速开始

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

编辑 `.env`，填入 Telegram bot token 或 Lark/飞书应用凭证，然后启动：

```bash
bun run start
```

向 bot 发送 `/relay`，选择或创建工作区，然后像平常一样向 Codex 发送消息。

## 使用指南

- [Telegram 快速上手](docs/zh-CN/quickstart-telegram.md)
- [Lark/飞书快速上手](docs/zh-CN/quickstart-lark.md)
- [常见问题排查](docs/zh-CN/troubleshooting.md)
- [扩展 agent-relay](docs/zh-CN/extending-agent-relay.md)

## 最低要求

- Bun 1.3 或更新版本。
- Git。
- 本地可用的 `codex` CLI，或通过 `CODEX_BIN` 指定完整路径。
- Codex CLI 需要支持 `codex app-server --listen stdio://`。
- Telegram bot token，或 Lark/飞书自建应用。

## 日常使用

先发送 `/relay`。Relay Home 会显示当前工作区、Codex 状态、等待状态、最近错误和可用操作。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看支持的命令。 |
| `/relay` | 打开 Relay Home。 |
| `/review` | 审查当前工作区改动。 |
| `/plan <prompt>` | 用 Plan mode 执行提示词。 |
| `/goal <objective>` | 为当前 Codex 线程设置目标。 |
| `/resume` | 选择最近的 Codex 线程。 |
| `/side <prompt>` | 发起临时 side conversation。 |
| `/interrupt` | 中断当前 turn。 |
| `/ps` | 查看 Codex 后台终端。 |
| `/stop` | 要求 Codex 清理后台终端。 |

在群聊里发送文本、图片或 slash command 时，需要提及 bot。

## 用它扩展它自己

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

更多流程见 [扩展 agent-relay](docs/zh-CN/extending-agent-relay.md)。

## 项目状态

当前 provider：

- IM：Telegram、Lark/飞书。
- Agent：Codex CLI app-server。
- 存储：SQLite。

已知限制：

- 暂不支持文件/文档附件。
- 暂未配置 npm 发布，请通过 `git clone` 从源码安装。
- 当前只有 Codex 这一种 Agent backend。

## 贡献和支持

- 提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 报告敏感问题前请阅读 [SECURITY.md](SECURITY.md)。
- 提交安装或运行问题前，请先查看 [常见问题排查](docs/zh-CN/troubleshooting.md)。
- 版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

`agent-relay` 使用 [MIT License](LICENSE) 授权。
