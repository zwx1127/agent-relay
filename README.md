# agent-relay

[![CI](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/zwx1127/agent-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [中文](README.zh-CN.md)

`agent-relay` lets you control a local Codex CLI agent from Telegram or Lark/Feishu. You keep Codex running on a trusted machine, then use chat to choose a workspace, send prompts, answer questions, approve actions, review code, manage threads, and exchange screenshots or images.

The goal is simple: keep the agent close to your code, while letting you operate it from the chat app you already use.

## What you can do

- Remote-control local Codex sessions from Telegram or Lark/Feishu.
- Select, create, browse, and delete workspaces from chat.
- Send normal prompts, images, and follow-up steering messages.
- Answer Codex questions and approve actions inline.
- Use common Codex workflows such as review, Plan mode, goals, resume, fork, side conversations, interrupt, and background terminal cleanup.
- Send screenshots or generated images back to chat with the optional local relay capability API.
- Extend the relay to support more IM providers or agent backends.

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

## Minimum requirements

- Bun 1.3 or newer.
- Git.
- A local `codex` CLI on `PATH`, or a full path set with `CODEX_BIN`.
- A Codex CLI version that supports `codex app-server --listen stdio://`.
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
| `/interrupt` | Stop the active turn. |
| `/ps` | List Codex background terminals. |
| `/stop` | Ask Codex to clean background terminals. |

In group chats, mention the bot when sending text, images, or slash commands.

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

- File/document attachments are not supported.
- npm publication is not configured; install from source with `git clone`.
- Codex is currently the only implemented agent backend.

## Contributing and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Read [SECURITY.md](SECURITY.md) before reporting sensitive issues.
- Check [Troubleshooting](docs/en/troubleshooting.md) before opening a setup issue.
- See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

`agent-relay` is licensed under the [MIT License](LICENSE).
