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
- Use `/resume [search]`, or **Resume** in Relay Home, to bind an IM scope to an existing thread. Both entrypoints use the same picker and switching semantics as Codex TUI.
- Relay Work never attaches an active or previously persisted thread merely because an ordinary IM message arrived. Without an explicit `/resume`, that message starts a fresh thread.
- `/resume` is rejected while the source scope has an active turn, approval, user-input request, or busy Relay task. An idle source scope may resume a target thread that is already active.
- Multiple native Codex clients and multiple IM scopes may resume the same thread. There is no one-writer or ownership rule; the user controls which connected client sends input.
- Closing or switching one client releases only that subscription. Relay sends `thread/unsubscribe` after its last logical scope leaves the thread, and releasing a client does not stop shared work. An explicit **Interrupt** or **Stop** still cancels the shared active turn.

The Gateway synchronizes live events only. New progress is forwarded after Codex, Gateway, and Relay are all running and the clients are associated with the same thread. The Gateway stores no progress history, Relay keeps no consumption cursor, and reconnecting does not replay output produced while any process was stopped or not yet running. Resuming inspects only the latest turn summary needed to identify the current active state; it never renders completed history or catches offline output up to IM.

An approval, user-input request, or MCP elicitation can be presented to every connected client associated with that thread. The first valid response wins, later responses are rejected, and the resolved notification removes duplicate controls from the other clients.

Ordinary IM input sent during an active turn has Codex TUI **Enter / Steer** semantics and includes the expected active turn id. Relay Work does not expose a TUI **Tab / Queue** action and adds no Gateway-level or thread-level input lock or queue. Relay only preserves per-scope send ordering.

## Disable and restore defaults

Run the following while the feature is still enabled:

```bash
bun run relay-work disable
```

This removes the experimental proxy from the user `Path`, restores the previous desktop `CODEX_CLI_PATH`, removes Gateway user-login startup, and requests Gateway shutdown. Then set:

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=false
```

After Relay restarts it uses the original local stdio `CodexDriver` path. It does not read Gateway state, add the Relay Home Resume action, or modify the desktop environment.

## Failure behavior

The experimental path fails closed. If its Gateway is unavailable, interactive CLI/Desktop proxy requests and Relay startup report an error rather than silently creating a second app-server. Use `gateway-status`, inspect the `.log` file beside the Gateway state file, and run `gateway-start` after resolving port or Codex CLI errors.
