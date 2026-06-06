# 常见问题排查

这里列出最常见的安装和运行问题。公开 issue 中不要粘贴 bot token、app secret、私有路径、提示词或 assistant 输出。

## relay 无法启动

检查：

- `.env` 存在。
- `WORKSPACE_ROOT` 是绝对路径。
- 已配置 `ALLOWED_USER_IDS`。
- 已配置对应 provider 的凭证。
- `codex --version` 可以正常运行。

运行：

```bash
bun run typecheck
bun test
bun run start
```

## 找不到 Codex

如果 `codex` 不在 `PATH` 中，可以配置完整路径：

```dotenv
CODEX_BIN=/absolute/path/to/codex
```

Windows 上支持 `codex.cmd` 和 `codex.exe`。如果自动查找失败，请填写完整路径。

## Telegram 消息被忽略

检查：

- 发送者 user ID 在 `ALLOWED_USER_IDS` 中。
- 如果配置了 `ALLOWED_CONVERSATION_IDS`，当前 chat ID 也在其中。
- 群聊消息提及了 bot。
- 如果 bot username 自动发现失败，群聊里需要手动配置 `TELEGRAM_BOT_USERNAME`。
- token 属于你正在聊天的 bot。

relay 启动时会跳过离线期间积压的 Telegram 消息。

## Lark 或飞书消息被忽略

检查：

- `LARK_DOMAIN` 和应用区域一致：`feishu` 或 `lark`。
- `ALLOWED_USER_IDS` 使用发送者 `open_id`。
- `ALLOWED_CONVERSATION_IDS` 使用 chat `chat_id`。
- 已启用机器人消息、消息接收事件和卡片 action 事件。
- 群聊消息提及了 bot。普通 `@BotName` 需要用空格分隔，例如 `/relay @RelayBot` 或 `@RelayBot /relay`。

## 群聊消息被忽略

检查：

- bot 确实已经加入群聊。
- 消息直接提及了 bot。普通 `@bot` 提及需要用空格分隔，例如 `/relay @relay_bot` 或 `@relay_bot /relay`；Telegram 原生的 `/relay@relay_bot` 命令格式也会兼容。
- 如果设置了 `ALLOWED_CONVERSATION_IDS`，用户和群聊都需要命中 allowlist。
- slash command、图片 caption 和普通文本都需要包含 bot 提及。
- 如果发送群聊消息后没有 `router.message_received` 或 `router.group_message_ignored` 日志，说明 Telegram 没有把 update 投递给 bot，需要检查命令格式、bot privacy mode 和群权限。
- 多 agent 群聊中，每个 bot 都需要独立 relay 进程和独立凭证。

Telegram Privacy Mode 是服务端投递过滤。开启 Privacy Mode 时，Telegram 只会把它认为和 bot 相关的消息投递给 bot，因此普通群消息或 `@relay_bot /relay` 这种先提及 bot 的消息，可能完全不会到达 agent-relay。需要稳定指定某个 bot 时，优先使用 Telegram 原生命令格式 `/relay@relay_bot`。如果 Telegram 投递了 update，relay 也会兼容 `/relay @relay_bot`。如果希望普通群文本只要提及 bot 就能被收到，需要在 BotFather 中关闭 Privacy Mode 后重新把 bot 加入群聊，或把 bot 设为群管理员。Telegram 官方说明见：https://core.telegram.org/bots/features#privacy-mode

## Topic 或 thread 路由不符合预期

Telegram 论坛话题和 Lark/飞书线程会从父群聊中拆成独立 scope。`ALLOWED_CONVERSATION_IDS` 只需要配置父群聊 chat ID。

检查：

- 不同 topic 或 thread 的消息在日志中有不同 `scope_key`，例如 Telegram 的 `-100123|telegram|15|`，或 Lark/飞书的 `oc_xxx|lark|thread_xxx|root_xxx`。
- 消息确实发送在 topic 或 thread 内，而不是父群聊主时间线。
- Relay Home 是在同一个 topic 或 thread 中打开并选择 workspace 的。
- 如果停止后的 topic 或 thread 不再显示 workspace，请在该 topic 或 thread 中重新发送 `/relay` 并选择 workspace。

## 按钮失效

发送 `/relay` 打开新的 Relay Home。

如果 Codex 正在等待旧的问题或审批，请从最新卡片回答，或使用 `/interrupt` 中断。

## 工作区操作失败

检查：

- `WORKSPACE_ROOT` 存在。
- 工作区名称只是简单目录名。
- 工作区是 `WORKSPACE_ROOT` 下一级真实目录。

## 图片失败

检查：

- 已选择工作区。
- 图片大小低于 `MEDIA_MAX_BYTES`。
- 上传的是图片消息，不是文档附件。

## 提交 issue 时提供什么

请提供：

- 操作系统和 shell。
- Bun 版本。
- Codex CLI 版本。
- IM provider：Telegram 或 Lark/飞书。
- 脱敏后的 `.env` 变量名。
- 出错附近的脱敏日志。
