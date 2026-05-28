# Lark/飞书快速上手

如果你想通过 Lark 或飞书远程控制本地 Codex，可以按这个流程配置。

## 1. 准备本地工具

确认已安装：

- Bun 1.3 或更新版本。
- Git。
- 可用的 Codex CLI。

```bash
bun --version
codex --version
```

## 2. 创建自建应用

在 Lark 或飞书开发者后台创建自建应用。

启用：

- 机器人消息能力。
- 消息接收事件。
- 卡片 action 事件。

agent-relay 使用长连接接收事件，不需要公网 callback URL。

## 3. 配置 agent-relay

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

编辑 `.env`：

```dotenv
IM_PROVIDER=lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_DOMAIN=feishu
ALLOWED_USER_IDS=ou_xxx
ALLOWED_CONVERSATION_IDS=oc_xxx
WORKSPACE_ROOT=/absolute/path/to/workspaces
```

飞书中国区应用使用 `LARK_DOMAIN=feishu`，Lark 国际版应用使用 `LARK_DOMAIN=lark`。

## 4. 启动和使用

```bash
bun run start
```

然后在 Lark 或飞书里：

1. 向 bot 发送 `/relay`。
2. 选择或创建工作区。
3. 像平常一样向 Codex 发送消息。
4. 用卡片按钮回答问题或审批操作。

在群聊里发送文本、图片 caption 或 slash command 时，需要提及 bot。

## 常用命令

- `/help`：查看命令。
- `/review`：审查工作区改动。
- `/plan <prompt>`：让 Codex 先制定计划。
- `/interrupt`：中断当前 turn。
- `/resume`：恢复之前的线程。

如果配置失败，请看 [常见问题排查](troubleshooting.md)。
