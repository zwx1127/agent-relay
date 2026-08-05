# Experimental relay work

> **Experimental and disabled by default.** This feature may change incompatibly. Normal Relay, Codex CLI, and Codex Desktop behavior is unchanged until you opt in and explicitly configure each client.

Experimental relay work keeps an independent per-user Codex Gateway running as the local data-plane proxy. The Gateway owns one Codex app-server child process. Relay, native Codex CLI processes, and the Windows or macOS Codex desktop app connect through it and continue the same Codex threads.

![Experimental relay work architecture: Codex and IM exchange live progress and control bidirectionally through one shared thread](../assets/relay-work-overview.png)

## Enable

1. Add the master opt-in to `.env`:

   ```dotenv
   EXPERIMENTAL_RELAY_WORK_ENABLED=true
   # Optional; defaults are shown below.
   EXPERIMENTAL_RELAY_GATEWAY_PORT=18765
   EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH=.data/agent-relay-gateway.json
   ```

2. Install user-login startup for the independent Gateway and start it now:

   ```powershell
   .\scripts\relay.ps1 gateway-install
   ```

   ```bash
   ./scripts/relay.sh gateway-install
   ```

3. Start or restart Relay. In experimental mode, Relay restarts preserve SQLite state and do not stop the Gateway.

Check the two processes independently with `gateway-status` and `status`. The Gateway binds only to `127.0.0.1` and writes its current URL and PIDs to the configured state file.

## Native CLI and Codex Desktop on Windows and macOS

CLI and Desktop integration are a second explicit opt-in:

```powershell
.\scripts\relay.ps1 clients-enable
```

```bash
./scripts/relay.sh clients-enable
```

The command compiles a local proxy named `codex`, records the previous user `Path` and `CODEX_CLI_PATH`, and prepends the proxy directory to the user `Path`. Open a new terminal and run interactive entrypoints normally:

```bash
codex -C /path/to/workspace
codex resume --last
codex fork --last
```

These entrypoints discover the one configured Gateway URL automatically. The public `--remote` mode is disabled by the experimental proxy, including custom endpoints and remote-auth options. The proxy uses Codex's WebSocket TUI transport internally; this is an implementation detail rather than a selectable connection path.

Commands that start an independent local agent or server and cannot join the shared app-server are rejected while the integration is enabled. This includes `exec`/`e`, `review`, `mcp-server`, `remote-control`, `exec-server`, and app-server `daemon`/`proxy`. Their help remains available. Non-agent management commands such as login, update, doctor, completion, and protocol schema generation continue to pass through to the real Codex CLI.

Restart Codex Desktop afterward. The same proxy preserves the desktop app-server JSONL protocol while forwarding it to the shared WebSocket Gateway. The older `desktop-enable` and `desktop-disable` commands remain compatibility aliases. Windows uses per-user environment variables; macOS also installs per-user LaunchAgents so the CLI `Path` and Finder-launched apps inherit the proxy configuration after login.

## Multiple Codex processes, threads, and IM scopes

- Multiple desktop, CLI, and Relay clients can connect to one Gateway without starting an app-server per client.
- Each client has an independent WebSocket connection, while one app-server remains authoritative for thread state.
- If exactly one thread is active in the selected workspace, Relay attaches it automatically.
- If several threads are active, Relay sends the thread picker instead of guessing.
- `/threads [search]` lists shared threads.
- `/attach <thread-id-or-unique-prefix>` attaches the current IM scope.
- `/detach` releases the current scope.
- A thread can have only one writable IM scope at a time. Detach it before moving it to another chat, Telegram topic, or Lark thread.

The Gateway synchronizes live events only. New progress is forwarded after Codex, Gateway, and Relay are all running and the clients are associated with the same thread. The Gateway stores no progress history, Relay keeps no consumption cursor, and reconnecting does not replay output produced while any process was stopped or not yet running. Resuming a thread restores only the current state needed to continue working; it does not catch offline output up to IM.

An approval or user-input request can be presented to multiple clients associated with that thread. The Gateway accepts the first valid response and drops later responses. Relay still serializes its own sends per session.

## Disable and restore defaults

Run the following while the feature is still enabled:

```bash
bun run relay-work disable
```

This removes the experimental proxy from the user `Path`, restores the previous desktop `CODEX_CLI_PATH`, removes Gateway user-login startup, and requests Gateway shutdown. Then set:

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=false
```

After Relay restarts it uses the original local stdio `CodexDriver` path. It does not read Gateway state, register shared-thread commands, or modify the desktop environment.

## Failure behavior

The experimental path fails closed. If its Gateway is unavailable, interactive CLI/Desktop proxy requests and Relay startup report an error rather than silently creating a second app-server. Use `gateway-status`, inspect the `.log` file beside the Gateway state file, and run `gateway-start` after resolving port or Codex CLI errors.
