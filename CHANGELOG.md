# Changelog

All notable changes to agent-relay will be documented in this file.

The project is pre-1.0 and currently installs from source.

## 0.1.0 - Unreleased

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
