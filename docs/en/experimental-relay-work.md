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

Gateway runtime state, logs, launcher configuration, and installation records default to `~/.agent-relay/experimental-relay-work/`. Relay's repository-local `.data` and `logs` directories are independent. Relay restart clears those repository-local directories so sessions, tasks, prompts, UI state, and transcripts start fresh; it never deletes Gateway data or Codex thread history, which remain available through `/resume`.

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
- For Gateway TUI entrypoints, the launcher forwards the directory where the command was invoked as the working root. An explicit `-C`/`--cd` takes precedence. This applies to new invocations only; threads previously recorded under the Gateway startup directory are not reclassified.
- User-supplied `--remote` and remote-auth options are rejected while the launcher is installed. The launcher may use Codex's WebSocket transport internally; it is not a public connection mode in relay work.
- In `gateway` mode, commands that would create an independent agent or server are rejected: `exec`/`e`, `review`, `mcp-server`, `remote-control`, `exec-server`, and app-server `daemon`/`proxy`. Help and non-agent management commands still pass through. Stopping Gateway returns new processes to local mode, where these commands work normally.

Mode changes apply to new processes and new connections. Relaunch Codex CLI/Desktop after a mode change. Existing connected processes are not transparently moved between transports.

## Relay behavior and failure semantics

Relay never starts Gateway. With the experimental gate enabled, Relay itself can remain online in local mode, but an IM action that needs Codex reports that Gateway is stopped and tells the user to run the Gateway start command. After Gateway starts, the next Relay action connects lazily; Relay does not need a restart and never falls back to spawning its own stdio app-server.

An explicit `gateway stop` writes durable `local` mode before stopping the processes. An unexpected Gateway or app-server exit deliberately leaves durable mode as `gateway`; new CLI, Desktop, and Relay connections fail closed until `gateway start` recovers the runtime. This prevents an unnoticed second app-server from diverging from the shared thread.

Gateway and its app-server are one failure domain. Normal shutdown terminates both, a detached watchdog terminates an orphaned app-server after an abnormal Gateway exit, and startup refuses an inconsistent live Gateway/app-server pair. Relay restart or `clean-data` does not stop either process. No thread-semantic journal is added: Gateway's state file contains lifecycle discovery data only.

`gateway start` requires a successful prior setup. `gateway remove` switches to local mode and stops Gateway before changing the client environment. If Gateway cannot stop, removal aborts and preserves the launcher and installation state so the user can retry safely.

## Threads, workspaces, and multiple clients

- Multiple CLI, Desktop, and Relay clients can connect to one Gateway. Each has an independent WebSocket connection; one app-server remains authoritative.
- Gateway mode inherits Codex configuration from that shared app-server and the existing thread. Ordinary Relay requests, forks, and side conversations do not override model, reasoning effort, personality, approval, sandbox, or instructions. A new IM-created thread carries only the workspace directory explicitly selected by the user. An explicit Default/Plan selection is applied through native `thread/settings/update` while the thread is idle; the protocol-required model and reasoning-effort fields reuse the thread's current values. `CODEX_APPROVAL`, `CODEX_SANDBOX`, and Relay instruction-injection settings apply only to local stdio mode.
- Multiple native clients and multiple IM scopes may `/resume` the same thread. Relay adds no one-writer ownership rule; the user chooses which client sends input.
- `/resume` uses Codex TUI resume semantics. A resume switch is rejected while the source scope has an active turn, approval, user-input request, or other busy Relay task.
- After a successful `/resume`, Relay immediately shows an activity card hydrated from the latest complete turn representation and reads the current Goal and background-terminal state before returning. Active turns continue updating that card; completed, interrupted, failed, and empty threads show their terminal or Idle state.
- Selecting a workspace in Relay Home only binds that directory. It does not make a running native Codex process change directories and does not auto-attach a thread. An ordinary first message starts fresh; `/resume` explicitly joins existing work.
- An idle workspace switch releases Relay's old subscription without stopping the thread. A busy switch is rejected.
- Ordinary IM input during an active turn uses Codex TUI Enter/Steer semantics. Relay work adds no Tab/Queue action, Gateway-level input lock, or thread ownership lock.
- New user messages entered in a native Codex client or another IM scope are mirrored live to every other IM scope attached to the thread. Relay does not echo a message back to its originating scope. Messages originating in IM preserve supported text formatting and reply relationships to synchronized user messages and final assistant replies; their mirrored copies use the same user-message presentation as the originating IM instead of a shared-thread title. Native Codex messages, or IM messages whose local presentation context is unavailable, keep the fallback shared-thread title. Non-text inputs are represented only by attachment type and count and are not downloaded or re-uploaded.
- Synchronized reply aliases are bounded, process-local Relay state. If Relay restarts or a referenced message is no longer mapped, the message is still synchronized without the reply relationship.
- Approval, user-input, and MCP elicitation requests may appear in all connected clients associated with the thread. The first valid response wins; resolved notifications clear duplicate controls and update Relay IM cards with the winning answer or decision when it is available. User-input answers, including values entered for secret questions, are visible in every connected Relay IM scope attached to that parent thread; they are not added to Gateway logs or durable state.
- Relay-supported thread operations are mirrored as command state to other Relay scopes on the same thread. This includes review, compaction, rename, Goal mutations, archive/delete, background-terminal cleanup, and Plan-mode state. The operation executes only in its originating client; peers never re-run a mirrored command.
- `/side` and `/btw` enter a scope-local, multi-turn BTW mode backed by one ephemeral fork. Bare `/btw` opens the child immediately and shows a ForceReply control card with **Return to main**; `/btw <prompt>` opens and submits, or continues the existing child. Ordinary text and structured attachments stay in BTW mode, input received during a running child turn uses Steer, and each new child turn gets its own streamed work card and progress reactions. Approvals, user-input requests, and MCP elicitation remain interactive. BTW questions, answers, status, and child-thread notifications are never synchronized to another Gateway client, never enter the parent transcript, and never change the parent task/activity state, so native Codex CLI TUI and Desktop users can keep working on the parent thread independently. Chat/workspace navigation is blocked until **Return to main** closes the child.
- `/plan` toggles the synchronized mode; `/plan --on` and `/plan --off` select it explicitly. Matching Codex CLI TUI semantics, collaboration mode cannot change while a turn is active, waiting for approval/input, or interrupting; Gateway rejects the native settings request as well as the Relay command so a race cannot create a next-turn-only mode. After a Gateway/app-server restart, native Codex restart semantics apply and Plan resumes as Default instead of being reconstructed from Relay storage.
- Gateway projects the shared thread's native idle/active/waiting state, active turn, latest completed/failed/interrupted turn, and the initiating client/time into Relay's private control snapshot. External mode changes produce a concise IM notice, active cards retain the mode captured when their turn started, and an external interrupt updates the card to Interrupting then Interrupted. Reconnect snapshots hydrate current state without replaying historical mode notices.

Gateway uses an internal observer connection to keep already-seen threads subscribed while every Relay frontend is disconnected. A per-Gateway epoch, per-thread revision, ACK, and resync snapshot prevent a reconnecting Relay from treating a partial event suffix as complete. This control plane is private to Gateway and does not extend the Codex app-server protocol.

The recovery boundary deliberately matches native Codex App/CLI process-restart behavior:

- If Relay disconnects, restarts, or clears its local data while Gateway/app-server stays alive, `/resume` rebuilds the latest full parent turn, Goal, background terminals, replayed pending approval/input requests, Plan/Default state, and Relay-supported parent command state from the live app-server plus Gateway memory. BTW mode is intentionally not recovered; old BTW cards become ended controls.
- If Gateway/app-server restarts, only state recoverable by native Codex resume/query is restored. Relay-only command projections and ephemeral `/btw` state disappear, in-process callbacks disappear, and Plan becomes Default.
- Live text/activity deltas are eventually consistent during a reconnect window. A terminal `turn/completed` plus the full resumed turn is authoritative; Relay never claims exactly-once delta delivery.

There is no progress-history database, consumption cursor, semantic JSON journal, offline output queue, or persisted replay. The bounded parent-command snapshot exists only in Gateway memory and expires/prunes there. BTW content is excluded from that snapshot. Gateway restart clears both Gateway state and any active ephemeral child.

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
