# Release checklist

Use this checklist for the first public release and later release candidates.

## Repository metadata

Suggested GitHub topics:

```text
codex
codex-cli
telegram-bot
lark
feishu
cli-agent
remote-control
automation
typescript
bun
sqlite
```

Suggested short description:

```text
Remote-control local Codex CLI sessions from Telegram or Lark.
```

## Pre-release checks

```bash
bun install
bun run check
```

Review:

- `README.md` quickstart still matches `.env.example`.
- `CHANGELOG.md` has a release entry.
- `SECURITY.md` reflects the current security model.
- No local runtime files are staged.

## Create a local tag

```bash
git tag -a v0.1.0 -m "agent-relay v0.1.0"
git push origin v0.1.0
```

## Suggested v0.1.0 release notes

~~~markdown
## agent-relay v0.1.0

Initial open-source baseline for remote-controlling local Codex CLI sessions from Telegram or Lark/Feishu.

### Highlights

- Telegram and Lark/Feishu IM providers.
- Local Codex app-server integration.
- Workspace selection, creation, deletion, and `.gitignore`-aware file browsing.
- Codex thread operations: review, compact, init, new, resume, fork, rename, Plan mode, goals, side conversations, interrupt, and background terminal cleanup.
- Inline handling for Codex questions, approvals, Plan mode choices, paged output, and stale callback recovery.
- Image input/output and optional local relay capabilities.

### Install

```bash
git clone https://github.com/zwx1127/agent-relay.git
cd agent-relay
bun install
cp .env.example .env
bun run start
```

See the README for Telegram and Lark/Feishu setup.
~~~
