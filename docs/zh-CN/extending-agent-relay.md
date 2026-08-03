# 扩展 agent-relay

agent-relay 适合用来迭代它自己。你可以把这个仓库作为工作区运行 relay，然后在 Telegram 或 Lark/飞书里让 Codex 添加 provider、更新文档并运行检查。

## 推荐流程

1. 启动 agent-relay，并选择当前仓库作为工作区。
2. 让 Codex 先阅读现有 provider 接口。
3. 一次只添加一个小 provider 或能力。
4. 要求 Codex 同步更新配置、文档和测试。
5. 运行 `bun run typecheck` 和 `bun test`。
6. 在聊天里查看 diff，再决定是否合并。

## 内部扩展点

`src/ports/agent.ts` 和 `src/ports/im.ts` 仍是稳定的公共导入入口。事件、会话、输入、线程、入站和出站协议按职责放在相邻子模块中，并由这两个文件统一重新导出。

Provider 适配器保持轻量：各 provider 的入站归一化和传输辅助逻辑与适配器放在一起。Codex driver 是稳定外观，内部组合 app-server 进程/RPC 生命周期、会话状态、通知转换和服务端请求处理。`RelayController` 组合 Agent 事件、线程命令、提示流程、媒体、能力和工作区 UI 等专用服务；`SQLiteStore` 也以同样方式组合各领域 repository，同时保持 `RelayStore` 协议不变。

扩展子系统时，应把行为加入真正负责该职责的窄协作者，并保持兼容导入路径和工厂函数签名稳定。

## 添加新的 IM provider

当你想支持另一个聊天工具时，用这个方向。

让 Codex 从这些文件开始：

- `src/ports/im.ts`
- `src/providers/im/telegram/adapter.ts`
- `src/providers/im/lark/adapter.ts`
- `src/providers/im/factory.ts`
- `src/runtime/config.ts`

新的 provider 应该能接收消息、发送文本，尽可能支持按钮，并只声明自己真正支持的能力。

可用提示词：

```text
Add a new IM provider for <provider name>. Reuse the ImAdapter contract, follow the existing Telegram and Lark patterns, add configuration, update the factory, and add focused tests.
```

## 添加新的 Agent backend

当你想让 agent-relay 连接 Codex 之外的 agent 时，用这个方向。

让 Codex 从这些文件开始：

- `src/ports/agent.ts`
- `src/providers/agents/codex/driver.ts`
- `src/providers/agents/factory.ts`
- `src/runtime/config.ts`

建议先做最小可用流程：启动会话、发送文本、流式输出、停止会话、报告状态。其他能力后续再加。

可用提示词：

```text
Add a new AgentDriver for <agent name>. Start with text prompts, streaming output, stop, and status. Keep optional features disabled until they are implemented. Add tests.
```

## 添加本地 relay 能力

当你希望运行中的 agent 主动调用 relay，例如发送截图或提及另一个 bot，可以添加本地能力。

让 Codex 查看：

- `src/relay/capabilities/`
- `src/relay/control/server.ts`
- `bin/agent-relay-helper`

可用提示词：

```text
Add a new relay capability named <capability>. It should be callable from the helper, validate input carefully, and include tests for success and rejection paths.
```

## 多 agent 群聊协作

你可以把多个 agent-relay bot 放在同一个 Telegram 或 Lark/飞书群聊里。这样每个本地 agent 都有独立 bot 身份，但协作讨论仍然在同一个群里完成。

推荐配置：

1. 每个 agent bot 运行一个 agent-relay 进程。
2. 将所有 agent bot 加入同一个允许的群聊。
3. 设置 `RELAY_AGENT_NAME`，让每个 agent 知道自己的角色。
4. 设置 `RELAY_PEER_AGENTS_FILE`，列出它可以提及的其他 bot。
5. 设置 `RELAY_CONTROL_ENABLED=true`，让 Codex 获得 helper 和能力说明。

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

配置完成后，Codex 可以用 `mention_agent` 请求另一个 agent bot 协助。relay 会在群里发送一条提及 peer 的消息；它不会启动或管理 peer 的本地会话。

可用提示词：

```text
Ask the designer peer to review the current UI screenshot, then continue with the implementation while waiting for feedback.
```

## 合并前检查

```bash
bun run typecheck
bun test
```

保持改动小。一个稳定可用的小 provider，比一个很大的半成品集成更有价值。
