# Changelog

All notable changes to agent-relay will be documented in this file.

The project is pre-1.0. The npm distribution uses the scoped name `@asuka1127/agent-relay`.

## 0.2.0 - 2026-09-30

- Add the `@asuka1127/agent-relay` npm package/Node executable and official pinned Bun runtime dependency, with global installation and npx tarball support without global Bun
- Make `install` the sole installation/configuration entry point: persist the scoped package, open the masked English setup wizard, and reuse the current persistent installation for reconfiguration, including conventional global and custom-prefix installs
- Keep installation consent, local tarball support, and no automatic PATH edits; default/`start` directs missing configuration to `install` without opening the wizard
- Add local `doctor`, explicit config/migration paths, and installed Gateway commands
- Guide Telegram BotFather and Feishu/Lark self-built app setup with consent-based official-host credential checks, no webhook/queue changes, and clear manual publication/event requirements
- Store private versioned configuration and state outside package caches/workspaces; preserve the source `.env` workflow and native Codex authority
- Add focused setup/security tests and a clean packed-artifact npm/npx smoke check; update both README languages and provider guides
- Standardize project documentation and user-facing text on English, keeping `README.zh-CN.md` as the only Chinese document and preserving old documentation URLs with English redirects

## Unreleased (0.3.0-next.2 candidate)

### Native backends

- Keep the original `/relay` Home without management subcommands; add the requested DSH-only `/new` and `/resume [search]` shortcuts to its native session APIs, replacing the candidate Home buttons while retaining session search and stale/busy safeguards

- Add backend-first configuration and local executable detection for Codex, Claude Code, and DeepSeek Harness, preserving existing Codex configurations
- Route Claude and DSH slash commands through their own native command catalogs and semantics; preserve Codex commands and the existing `/relay` Home without new Relay subcommands
- Isolate native session IDs by backend and preserve backend-owned settings, authentication, permissions, and conversation history
- Add native approval-choice validation and multi-select questions without widening Codex approval scopes
- Support bounded native image input and DSH session-authorized image output, with no arbitrary remote image fetching
- Bind persisted task/prompt state to its backend and propose separate state files when switching, preventing cross-backend replay of legacy queued work
- Keep the experimental shared Gateway Codex-only; do not silently apply Codex instructions or mode settings to other backends

### Fixed

- Keep Codex approval callbacks distinct by native callback ID/action, reject ambiguous or conflicting security payloads, and honor the exact advertised decisions.
- Preserve nonblocking question behavior, concurrent blocking requests, and explicit nullable native reasoning settings when selecting Plan/Default.
- Keep pending Gateway requests alive until native resolution and reject browser-origin/non-loopback-host access to the local Gateway.

### Added

- Pinned Codex 0.159.2 experimental schema fixtures and CI contract alongside the 0.145.0 floor and scheduled latest check.

### Changed

- Split user-facing README and docs into separate English and Chinese versions.
- Simplified user docs around features, quick start, daily usage, troubleshooting, and extension workflow.
- Documented group chat setup, allowed conversations, and multi-agent group workflows.

## 0.1.0 - 2026-05-28

Initial open-source baseline.

### Added

- Telegram and Lark/Feishu IM providers.
- Local Codex app-server integration.
- Workspace selection, creation, deletion, and `.gitignore`-aware file browsing.
- Codex thread operations including review, compact, init, new, resume, fork, rename, Plan mode, goals, side conversations, interrupt, and background terminal cleanup.
- Inline handling for Codex questions, approvals, Plan mode choices, paged output, and stale callback recovery.
- IM image input, album batching, Codex image output, and workspace-local media storage.
- Optional local capability API with `send_image` and `mention_agent`.
- SQLite persistence for relay state.
- Unit and integration test coverage for adapters, routing, storage, and Codex protocol behavior.

### Known limitations

- Codex is the only implemented agent provider.
- Telegram and Lark/Feishu are the only implemented IM providers.
- File/document attachments are not supported.
- npm publication is not configured.
