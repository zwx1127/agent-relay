# Extending agent-relay

agent-relay is built so you can use it to improve itself. Run the relay on this repository, then ask Codex from Telegram or Lark/Feishu to add a provider, update docs, and run checks.

## Recommended workflow

1. Start agent-relay with this repository as the selected workspace.
2. Ask Codex to inspect the current provider interfaces.
3. Ask it to add one small provider or capability at a time.
4. Ask it to update config, docs, and tests.
5. Run `bun run typecheck` and `bun test`.
6. Review the diff from chat before merging.

## Internal extension points

`src/ports/agent.ts` and `src/ports/im.ts` remain the stable public import paths. Their event, session, input, thread, inbound, and outbound contracts live in adjacent submodules and are re-exported by those files.

Provider adapters are intentionally thin: provider-specific inbound normalization and transport helpers live beside the adapter. The Codex driver is the stable facade over app-server process/RPC lifecycle, session state, notification conversion, and server-request handling. `RelayController` composes focused relay services for agent events, thread commands, prompt flows, media, capabilities, and workspace UI. `SQLiteStore` similarly composes domain-specific repositories without changing the `RelayStore` contract.

When extending a subsystem, add behavior to the narrow collaborator that owns it and keep compatibility imports and factory signatures stable.

## Add a new IM provider

Use this when you want to support another chat app.

Ask Codex to start from:

- `src/ports/im.ts`
- `src/providers/im/telegram/adapter.ts`
- `src/providers/im/lark/adapter.ts`
- `src/providers/im/factory.ts`
- `src/runtime/config.ts`

The provider should receive messages, send text, support buttons when possible, and expose only the capabilities it can actually handle.

Suggested prompt:

```text
Add a new IM provider for <provider name>. Reuse the ImAdapter contract, follow the existing Telegram and Lark patterns, add configuration, update the factory, and add focused tests.
```

## Add a new agent backend

Use this when you want agent-relay to talk to an agent other than Codex.

Ask Codex to start from:

- `src/ports/agent.ts`
- `src/providers/agents/codex/driver.ts`
- `src/providers/agents/factory.ts`
- `src/runtime/config.ts`

Start with a small working flow: start a session, send text, stream output, stop a session, and report status. Add optional capabilities later.

Suggested prompt:

```text
Add a new AgentDriver for <agent name>. Start with text prompts, streaming output, stop, and status. Keep optional features disabled until they are implemented. Add tests.
```

## Add a local relay capability

Use this when the running agent should call back into the relay, for example to send a screenshot or mention another bot.

Ask Codex to inspect:

- `src/relay/capabilities/`
- `src/relay/control/server.ts`
- `bin/agent-relay-helper`

Suggested prompt:

```text
Add a new relay capability named <capability>. It should be callable from the helper, validate input carefully, and include tests for success and rejection paths.
```

## Multi-agent group workflow

You can put several agent-relay bots in the same Telegram or Lark/Feishu group. This gives each local agent its own bot identity while keeping the discussion in one shared room.

Recommended setup:

1. Run one agent-relay process per agent bot.
2. Add all agent bots to the same allowed group.
3. Set `RELAY_AGENT_NAME` so each agent knows its own role.
4. Set `RELAY_PEER_AGENTS_FILE` to list the other bots it may mention.
5. Set `RELAY_CONTROL_ENABLED=true` so Codex receives the helper and capability instructions.

Example peer file:

```json
[
  {
    "id": "designer",
    "name": "Designer",
    "telegramUsername": "designer_bot",
    "larkOpenId": "ou_designer"
  }
]
```

Once configured, Codex can ask another agent bot for related work with `mention_agent`. The relay sends a group message that mentions the peer; it does not start or manage the peer's local session.

Suggested prompt:

```text
Ask the designer peer to review the current UI screenshot, then continue with the implementation while waiting for feedback.
```

## Checks before merging

```bash
bun run typecheck
bun test
```

Keep changes small. A provider that handles one reliable workflow is better than a large unfinished integration.
