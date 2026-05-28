# Contributing to agent-relay

Thanks for taking the time to improve agent-relay.

## Development setup

```bash
bun install
bun run check
```

`bun run check` runs TypeScript type checking and the full test suite.

## Pull request expectations

- Keep changes focused on one behavior or documentation topic.
- Add or update tests for behavior changes.
- Run `bun run check` before opening a pull request.
- Do not commit local runtime files such as `.env`, `.data/`, `logs/`, generated media, or workspace-specific artifacts.
- Redact bot tokens, allowlisted IDs, private paths, prompts, and assistant output from screenshots or logs.

## Project structure

- `src/runtime/`: configuration, dotenv loading, validation, bootstrap.
- `src/providers/`: Codex, Telegram, and Lark provider implementations.
- `src/relay/`: controller, routing, task flow, media, capabilities, and UI state.
- `src/storage/`: store contract and SQLite implementation.
- `test/unit/`: focused unit tests.
- `test/integration/`: adapter, controller, storage, protocol, and smoke tests.

## Reporting bugs

Use the bug report issue template and include:

- OS and shell.
- Bun version.
- Codex CLI version, if available.
- Whether `codex` is available on `PATH`.
- IM provider: Telegram or Lark/Feishu.
- Relevant configuration variable names, with values redacted.
- Redacted logs around the failure.

Never paste IM credentials, allowlisted IDs, private workspace paths, prompt text, or assistant output that should not be public.
