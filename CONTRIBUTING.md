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

- `src/ports/agent.ts` and `src/ports/im.ts`: stable compatibility barrels; contracts are grouped by capability in their adjacent subdirectories.
- `src/runtime/`: environment loading, parsing and validation, final configuration assembly, and bootstrap.
- `src/providers/agents/codex/`: the public Codex driver plus process/RPC lifecycle, session state, notification, activity, and server-request collaborators.
- `src/providers/im/`: Telegram and Lark adapters, with provider-specific transport and inbound normalization kept beside each adapter.
- `src/relay/`: the composition controller and focused services for agent events, thread commands, prompt flows, media, capabilities, and UI state.
- `src/storage/`: the `RelayStore` contract, the `SQLiteStore` facade, migrations, and domain-specific SQLite repositories.
- `test/support/`: shared Relay fixtures, message builders, fakes, and the Codex app-server harness.
- `test/unit/`: focused unit tests, including pure parser and validation behavior.
- `test/integration/`: adapter, controller, storage, protocol, and smoke tests split by subsystem.

Keep public imports pointed at the compatibility barrels unless an implementation genuinely needs a narrower internal contract. New collaborators should depend on the smallest port or store surface they use rather than the complete controller or store.

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
