# agent-relay

[![CI](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [中文](README.zh-CN.md)

`agent-relay` lets you control a local Codex CLI agent from Telegram or Lark/Feishu. You keep Codex running on a trusted machine, then use chat to choose a workspace, send prompts, answer questions, approve actions, review code, manage threads, and exchange screenshots, images, or files.

The goal is simple: keep the agent close to your code, while letting you operate it from the chat app you already use.

## Community Group

Scan the Telegram QR code below to join the project community group.

<img src="docs/assets/telegram-group-qr.jpg" alt="Telegram group QR code" width="240">

## Showcase

<table>
  <tr>
    <th>Telegram direct chat</th>
    <th>Telegram group topic mode</th>
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
    <th>Feishu direct chat</th>
    <th>Feishu group topic mode</th>
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

## What you can do

- Remote-control local Codex sessions from Telegram or Lark/Feishu.
- Select, create, browse, and delete workspaces from chat.
- Send normal prompts, images, voice/audio, file mentions, skills, and follow-up steering messages.
- Follow reasoning summaries, plan progress, tools, file changes, warnings, and diffs in one editable activity card; long details remain available for 24 hours.
- Answer Codex questions and approve actions inline.
- Use direct chats or allowed group chats; group messages are handled only when they mention the bot.
- Use common Codex workflows such as review, Plan mode, goals, resume, fork, side conversations, interrupt, and background terminal cleanup.
- Send screenshots, generated images, or files back to chat with the optional local relay capability API.
- Put multiple agent-relay bots in one group and let agents mention configured peers for related work.
- Extend the relay to support more IM providers or agent backends.

## Experimental: relay work

> **Experimental, disabled by default, and opt-in only.** This feature may change incompatibly before it is stable. It does not start a Gateway, install a client proxy, or change existing Relay, Codex CLI, or Codex Desktop behavior unless you enable it manually.

Experimental relay work lets you begin in the native Codex CLI or the Windows/macOS Codex Desktop app, leave the computer, and continue the same Codex thread through Telegram or Lark/Feishu. Relay, interactive Codex CLI processes, and Codex Desktop all connect to one independent local Gateway and its single authoritative app-server; users run Codex normally and do not choose remote endpoints.

![Experimental relay work architecture: Codex and IM exchange live progress and control bidirectionally through one shared thread](docs/assets/relay-work-overview.png)

Run `scripts/gateway.* setup` once, then start Gateway manually whenever relay work is needed. Gateway and Relay have separate scripts and lifecycles. Use `/resume` to join an existing thread. Multiple native Codex clients and IM scopes can share a thread without ownership restrictions; ordinary input during an active turn uses Steer semantics, and the first client to answer an approval or input request wins. Only new live progress produced while Codex, Gateway, and Relay are running is synchronized—there is no Queue action, offline replay, or catch-up. See [Experimental relay work](docs/en/experimental-relay-work.md) for the Windows, macOS, and Linux setup, lifecycle semantics, and complete removal instructions.

## Quick start

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
```

Edit `.env` with a Telegram bot token or Lark/Feishu app credentials, then start the relay:

```bash
bun run start
```

Send `/relay` to the bot, select or create a workspace, then send a normal message to Codex.

## Setup guides

- [Telegram quickstart](docs/en/quickstart-telegram.md)
- [Lark/Feishu quickstart](docs/en/quickstart-lark.md)
- [Troubleshooting](docs/en/troubleshooting.md)
- [Extending agent-relay](docs/en/extending-agent-relay.md)
- [Experimental relay work](docs/en/experimental-relay-work.md) (disabled by default)

## Minimum requirements

- Bun 1.3 or newer.
- Git.
- A local `codex` CLI on `PATH`, or a full path set with `CODEX_BIN`.
- Codex CLI 0.145.0 or newer with `codex app-server --listen stdio://`; the experimental launcher uses the CLI's WebSocket transport internally, so users do not select a separate remote mode.
- A Telegram bot token, or a Lark/Feishu self-built app.

## Daily usage

Start from `/relay`. The home view shows the selected workspace, Codex status, waiting state, recent errors, and available actions.

Common commands:

| Command | Use |
| --- | --- |
| `/help` | Show supported commands. |
| `/relay` | Open Relay Home. |
| `/review` | Review current workspace changes. |
| `/plan <prompt>` | Run a prompt in Plan mode. |
| `/goal <objective>` | Set a goal for the current Codex thread. |
| `/resume` | Pick a recent Codex thread. |
| `/side <prompt>` | Ask in a temporary side conversation. |
| Activity/Goal card buttons | Interrupt the active turn or manage the goal. Button labels stay in English. |
| `/ps` | List Codex background terminals. |
| `/skills [search]` | Select a Codex skill, then reply with the task. |
| `/mention [search]` | Select a workspace file or directory, then reply with the task. |
| `/stop` | Ask Codex to clean background terminals. |

In group chats, mention the bot when sending text, images, files, or slash commands. Keep normal bot mentions as separate tokens, such as `/relay @relay_bot` or `@relay_bot review this change`. Telegram's native `/relay@relay_bot` command form is also accepted. Use `ALLOWED_CONVERSATION_IDS` when a bot should only respond in specific groups.

## Group chats and agent teams

agent-relay works in private chats and group chats. Group chats are useful when you want a shared operator room for one or more local agents.

- Add the bot to the group and allow the group with `ALLOWED_CONVERSATION_IDS`.
- Mention the bot in text, image/file captions, and slash commands, with spaces around `@bot` or `@BotName` when it is a normal mention.
- Unmentioned group messages are ignored before authorization checks.
- Telegram forum topics and Lark/Feishu threads are treated as separate scopes, so each topic or thread can select its own workspace and run its own Codex session in parallel.
- Run one agent-relay process per agent bot when you want several agents in the same group.
- Configure peer agents and enable the local relay capability API when you want Codex to mention another agent bot.

See the Telegram and Lark/Feishu quickstarts for group setup details.

## Extend it with itself

agent-relay is designed so you can use the running relay to improve agent-relay.

1. Start agent-relay in this repository as the selected workspace.
2. Ask Codex from Telegram or Lark/Feishu to add a new IM provider or agent backend.
3. Point Codex at the provider contracts and existing implementations.
4. Ask it to update config, factories, docs, and tests.
5. Run `bun run typecheck` and `bun test` from chat.

The main extension points are:

- IM providers: `src/ports/im.ts` and `src/providers/im/`.
- Agent providers: `src/ports/agent.ts` and `src/providers/agents/`.
- Local agent-visible capabilities: `src/relay/capabilities/`.

See [Extending agent-relay](docs/en/extending-agent-relay.md) for the suggested workflow.

## Project status

Current providers:

- IM: Telegram, Lark/Feishu.
- Agent: Codex CLI app-server.
- Storage: SQLite.

Known limitations:

- Folder attachments and automatic archive extraction are not supported.
- npm publication is not configured; install from source with `git clone`.
- Codex is currently the only implemented agent backend.

## Contributing and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Read [SECURITY.md](SECURITY.md) before reporting sensitive issues.
- Check [Troubleshooting](docs/en/troubleshooting.md) before opening a setup issue.
- See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

`agent-relay` is licensed under the [MIT License](LICENSE).
