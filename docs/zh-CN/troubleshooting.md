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
- token 属于你正在聊天的 bot。

relay 启动时会跳过离线期间积压的 Telegram 消息。

## Lark 或飞书消息被忽略

检查：

- `LARK_DOMAIN` 和应用区域一致：`feishu` 或 `lark`。
- `ALLOWED_USER_IDS` 使用发送者 `open_id`。
- `ALLOWED_CONVERSATION_IDS` 使用 chat `chat_id`。
- 已启用机器人消息、消息接收事件和卡片 action 事件。
- 群聊消息提及了 bot。

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
