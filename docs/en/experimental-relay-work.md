# Experimental relay work

> **Experimental, disabled by default, and opt-in only.** This feature may change incompatibly before it is stable. Relay, Codex CLI, and Codex Desktop keep their existing behavior until you explicitly enable and set up relay work.

Relay work lets the native Codex CLI, supported Codex Desktop apps, and IM-based Relay continue the same Codex threads through one local Gateway and its authoritative Codex app-server.

![Experimental relay work architecture: Codex and IM exchange live progress and control bidirectionally through one shared thread](../assets/relay-work-overview.png)

## Setup and manual lifecycle

Add the experimental gate to `.env`:

```dotenv
EXPERIMENTAL_RELAY_WORK_ENABLED=true
# Optional:
EXPERIMENTAL_RELAY_GATEWAY_PORT=18765
# EXPERIMENTAL_RELAY_GATEWAY_STATE_PATH=/absolute/path/to/gateway-state.json
```

Gateway runtime state, logs, launcher configuration, and installation records default to `~/.agent-relay/experimental-relay-work/`. Relay's repository-local `.data` and `logs` directories are independent; Relay cleanup and restart never delete Gateway data.

Run setup once. Setup installs the permanent Codex launcher and client environment, initializes durable `local` mode, and does **not** start Gateway:

```powershell
.\scripts\gateway.ps1 setup
```

```bash
./scripts/gateway.sh setup
```

Open a new terminal afterward; on Windows and macOS, also restart Codex Desktop. Start Relay with its own script, and start Gateway manually whenever shared work is wanted:

```powershell
.\scripts\relay.ps1 start
.\scripts\gateway.ps1 start
```

```bash
./scripts/relay.sh start
./scripts/gateway.sh start
```

Gateway has no login item, service, scheduled task, or automatic startup on any platform. Its lifecycle is separate from Relay:

```text
gateway setup    install the launcher and initialize local mode; do not start
gateway start    require setup, health-check Gateway, then select gateway mode
gateway stop     select local mode first, then stop Gateway; keep setup
gateway status   report setup, mode, PIDs, health, URL, state, and launcher
gateway remove   select local, stop, restore the client environment, remove data
```

Use `bun run gateway <command>` as the package-level equivalent. There are no `gateway-install`, `clients-enable`, `desktop-enable`, or matching disable compatibility aliases.

## Client integration by platform

- **Windows:** setup installs a `codex.exe` launcher, prepends its directory to the per-user `Path`, and points the per-user `CODEX_CLI_PATH` at it for Codex Desktop.
- **macOS:** setup installs a `codex` launcher plus client-environment LaunchAgents that set `PATH` and `CODEX_CLI_PATH` for terminals and Finder-launched apps. These LaunchAgents only publish environment values; they never start Gateway.
- **Linux:** setup supports the current Bash, Zsh, or Fish selected by `$SHELL`. It adds one managed, idempotent PATH fragment to `~/.bashrc`, `~/.zshrc`, or Fish `conf.d`. Linux setup targets Codex CLI only. There is no current official Codex Desktop integration to claim; the launcher layout reserves an adapter for a future official Linux app.

The launcher reads durable mode on every new invocation:

- In `local` mode it delegates normal Codex commands to the real CLI unchanged.
- In `gateway` mode interactive TUI entrypoints and the Desktop app-server connection use Gateway automatically. Users run `codex`, `codex resume`, and `codex fork` normally.
- User-supplied `--remote` and remote-auth options are rejected while the launcher is installed. The launcher may use Codex's WebSocket transport internally; it is not a public connection mode in relay work.
- In `gateway` mode, commands that would create an independent agent or server are rejected: `exec`/`e`, `review`, `mcp-server`, `remote-control`, `exec-server`, and app-server `daemon`/`proxy`. Help and non-agent management commands still pass through. Stopping Gateway returns new processes to local mode, where these commands work normally.

Mode changes apply to new processes and new connections. Relaunch Codex CLI/Desktop after a mode change. Existing connected processes are not transparently moved between transports.

## Relay behavior and failure semantics

Relay never starts Gateway. With the experimental gate enabled, Relay itself can remain online in local mode, but an IM action that needs Codex reports that Gateway is stopped and tells the user to run the Gateway start command. After Gateway starts, the next Relay action connects lazily; Relay does not need a restart and never falls back to spawning its own stdio app-server.

An explicit `gateway stop` writes durable `local` mode before stopping the processes. An unexpected Gateway or app-server exit deliberately leaves durable mode as `gateway`; new CLI, Desktop, and Relay connections fail closed until `gateway start` recovers the runtime. This prevents an unnoticed second app-server from diverging from the shared thread.

`gateway start` requires a successful prior setup. `gateway remove` switches to local mode and stops Gateway before changing the client environment. If Gateway cannot stop, removal aborts and preserves the launcher and installation state so the user can retry safely.

## Threads, workspaces, and multiple clients

- Multiple CLI, Desktop, and Relay clients can connect to one Gateway. Each has an independent WebSocket connection; one app-server remains authoritative.
- Multiple native clients and multiple IM scopes may `/resume` the same thread. Relay adds no one-writer ownership rule; the user chooses which client sends input.
- `/resume` and Relay Home **Resume** share Codex TUI resume semantics. A resume switch is rejected while the source scope has an active turn, approval, user-input request, or other busy Relay task.
- Selecting a workspace in Relay Home only binds that directory. It does not make a running native Codex process change directories and does not auto-attach a thread. An ordinary first message starts fresh; `/resume` explicitly joins existing work.
- An idle workspace switch releases Relay's old subscription without stopping the thread. A busy switch is rejected.
- Ordinary IM input during an active turn uses Codex TUI Enter/Steer semantics. Relay work adds no Tab/Queue action, Gateway-level input lock, or thread ownership lock.
- Approval, user-input, and MCP elicitation requests may appear in all connected clients associated with the thread. The first valid response wins; resolved notifications clear duplicate controls.

Gateway forwards only live events produced while Codex, Gateway, and Relay are running and associated with the same thread. It stores no progress history, consumption cursor, offline queue, replay, or catch-up stream. Resuming may inspect the latest turn summary only to identify current active state; it does not render missed completed output into IM.

## Stop or remove

Temporarily return new Codex processes to normal local behavior while keeping setup:

```powershell
.\scripts\gateway.ps1 stop
```

```bash
./scripts/gateway.sh stop
```

Remove the launcher, restore the previous Windows/macOS environment or remove the managed Linux shell fragment, and delete Gateway user data:

```powershell
.\scripts\gateway.ps1 remove
```

```bash
./scripts/gateway.sh remove
```

Then set `EXPERIMENTAL_RELAY_WORK_ENABLED=false` and restart Relay to restore its original local stdio driver. The feature remains disabled by default.
