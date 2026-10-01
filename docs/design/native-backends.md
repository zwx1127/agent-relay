# Backend-native Relay boundaries

## Decision

Keep the existing Codex driver, app-server contract, shared Gateway and native policy authority. Add independently implemented Claude and DeepSeek Harness drivers behind the same agent ports. The transport owns native session state and command interpretation; Relay owns messaging presentation and workspace navigation.

Commands are a provider capability, not a universal alias table. The Codex command router remains backward-compatible. Other providers implement live native command catalogs and `runNativeCommand`; Relay passes the exact suffix through after removing the messaging provider's bot-name suffix. Unknown commands never become model prompts. `/relay` keeps its pre-existing Home behavior; no Relay management subcommand dialect is introduced. Native UI-only actions may use IM controls backed by the same provider API. DSH has an explicit user-requested exception: `/new` and `/resume [search]` are Relay shortcuts to native session creation/listing/resume, not upstream slash-registry commands or a universal cross-backend alias table. Its picker/search remains fenced to the originating workspace and native thread.

A native picker can be presented as IM buttons when it uses the same native catalog and selection API. The DSH `/model` picker therefore uses opaque catalog IDs and revalidates them natively before applying a choice. This does not create a new slash-argument grammar.

## Authority and isolation

- Codex uses its established stdio or opt-in Gateway paths unchanged.
- Claude invokes the user's independently installed CLI and speaks its verified bidirectional stream-JSON control protocol. There is no SDK runtime dependency or redistributed native executable.
- DSH invokes the pinned native Web profile, preserving plugin/command composition. Its local launch token is exchanged for an in-memory cookie; all HTTP and WebSocket traffic remains loopback.
- Each driver validates live permission request identity and offered response scope. Presentation never invents an approval choice or converts one backend's policy values into another's.
- Native session keys include the backend. Resume admission also reserves native identities during asynchronous startup, preventing simultaneous claims from separate scopes.
- SQLite task and prompt state is bound to one backend. Populated pre-multi-backend state belongs to Codex. A different backend must use a separate state file; it cannot replay queued prompts from another backend. The wizard proposes a separate state filename when backend selection changes and preserves the old file.
- User configuration files remain unchanged. Codex instruction files are read only when Codex is selected. DSH helper integration is rejected because the native Web session API does not accept supplemental instructions; no synthetic prompt wrapper or user-profile mutation is used.

## Lifecycle and backpressure

Agent output callbacks must not block native protocol processing: Relay serializes inbound operations and output presentation per chat scope. Awaiting presentation while an inbound command is waiting for native completion would deadlock approvals. Drivers dispatch presentation asynchronously, and delivery failure for a blocking native request must fail closed.

Commands that can wait for native human interaction return admission promptly and stream their actual outcome later. Their driver-side operation stays bound to its session generation. Intentional stop/restart does not emit an unexpected-exit callback that could retire a replacement session. Late command outcomes and queued native frames cannot publish into a replacement session.

Relay adds no new execution queue or semantic journal. Claude currently refuses additional prompts while a turn is active; DSH forwards supported steering to its native admission API. DSH reconnect repair reads authoritative native history/projections. Unrecoverable gaps or malformed streams become terminal, recoverable errors instead of permanent hidden waiting.

## Verification

Use official release metadata and schema/source evidence to choose versions. Test each adapter with fake native processes and protocol fixtures, and separately probe the genuine executable in an isolated environment without account credentials or model prompts. Full lint/typecheck/tests and packed npm/npx installation checks remain required. Live model/tool/IM acceptance is a separate opt-in test, and must not be inferred from no-account protocol probes.

See [user-facing backend matrix](../en/backends.md) for release targets, native command behavior, unavailable UI operations and authentication/distribution boundaries.
