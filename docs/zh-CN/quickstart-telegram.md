# Telegram 快速上手

如果你想通过 Telegram 远程控制本地 Codex，可以按这个流程配置。

## 1. 准备本地工具

确认已安装：

- Bun 1.3 或更新版本。
- Git。
- 可用的 Codex CLI。

```bash
bun --version
codex --version
```

## 2. 创建 Telegram bot

1. 打开 Telegram 的 BotFather。
2. 创建一个 bot。
3. 复制 bot token。
4. 如果要在群里使用，记下 bot username。

## 3. 配置 agent-relay

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

编辑 `.env`：

```dotenv
IM_PROVIDER=telegram
TELEGRAM_BOT_TOKEN=123:abc
ALLOWED_USER_IDS=123456
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

如果用于群聊，建议再配置：

```dotenv
ALLOWED_CONVERSATION_IDS=-100123456
```

## 4. 可选群聊配置

群聊使用时：

1. 把 bot 加入群聊。
2. 将 `ALLOWED_CONVERSATION_IDS` 设置为这个群的 chat ID。
3. 如果当前环境中 bot username 自动发现不稳定，可以手动配置 `TELEGRAM_BOT_USERNAME`。
4. 发送文本、图片 caption 和 slash command 时提及 bot。普通 `@bot` 提及需要用空格分隔，例如 `/relay @relay_bot` 或 `@relay_bot inspect this`。

未提及 bot 的群聊消息会在授权检查前被忽略，因此普通群消息不会触发 relay。

## 5. 启动和使用

```bash
bun run start
```

然后在 Telegram 里：

1. 向 bot 发送 `/relay`。
2. 选择或创建工作区。
3. 像平常一样向 Codex 发送消息。
4. 用按钮回答问题或审批操作。

在群聊里发送文本、图片或 slash command 时，需要提及 bot。普通 `@bot` 前后需要用空格分隔；Telegram 原生的 `/relay@relay_bot` 命令格式也会兼容。

## 6. Topic 和多 workspace 用法

在 Telegram 论坛群组中，每个 topic 都是独立的 relay scope。`ALLOWED_CONVERSATION_IDS` 仍然配置群聊 chat ID，不配置 topic ID。

多 workspace 并行使用时：

1. 在 Telegram 群组里开启 Topics。
2. 按 workspace 或工作流创建不同 topic。
3. 在每个 topic 中发送 `/relay@relay_bot`，或其它 Telegram 会投递给 bot 的定向命令。
4. 在该 topic 的 Relay Home 中选择 workspace。
5. 分别在不同 topic 中发送提示词。回复、按钮、任务和 Codex 输出都会留在对应 topic 内。

从 Relay Home 停止会话时，只会停止当前 topic 的 session，并清除当前 topic 的 workspace 绑定。同群里的其它 topic 会保留各自的 session。

## 常用命令

- `/help`：查看命令。
- `/review`：审查工作区改动。
- `/plan <prompt>`：让 Codex 先制定计划。
- 最新活动卡上的 `Interrupt`：中断当前 turn。Goal 卡会按状态提供 `Pause`、`Resume`、`Edit`、`Clear`。
- `/resume`：恢复之前的线程。

如果配置失败，请看 [常见问题排查](troubleshooting.md)。
