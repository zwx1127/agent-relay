# 扩展 agent-relay

agent-relay 适合用来迭代它自己。你可以把这个仓库作为工作区运行 relay，然后在 Telegram 或 Lark/飞书里让 Codex 添加 provider、更新文档并运行检查。

## 推荐流程

1. 启动 agent-relay，并选择当前仓库作为工作区。
2. 让 Codex 先阅读现有 provider 接口。
3. 一次只添加一个小 provider 或能力。
4. 要求 Codex 同步更新配置、文档和测试。
5. 运行 `bun run typecheck` 和 `bun test`。
6. 在聊天里查看 diff，再决定是否合并。

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

## 合并前检查

```bash
bun run typecheck
bun test
```

保持改动小。一个稳定可用的小 provider，比一个很大的半成品集成更有价值。
