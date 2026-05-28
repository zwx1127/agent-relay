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

## 4. 启动和使用

```bash
bun run start
```

然后在 Telegram 里：

1. 向 bot 发送 `/relay`。
2. 选择或创建工作区。
3. 像平常一样向 Codex 发送消息。
4. 用按钮回答问题或审批操作。

在群聊里发送文本、图片或 slash command 时，需要提及 bot。

## 常用命令

- `/help`：查看命令。
- `/review`：审查工作区改动。
- `/plan <prompt>`：让 Codex 先制定计划。
- `/interrupt`：中断当前 turn。
- `/resume`：恢复之前的线程。

如果配置失败，请看 [常见问题排查](troubleshooting.md)。
