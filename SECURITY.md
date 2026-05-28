# Security Policy

## Supported versions

agent-relay is pre-1.0. Security fixes are handled on the `main` branch until release branches exist.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that exposes credentials, private prompts, workspace paths, or local machine access.

Report privately through GitHub Security Advisories when available. If advisories are not available for this repository, contact the maintainer through a private channel and include only the minimum redacted details needed to reproduce the issue.

## Security model

- The relay is intended to run on a trusted machine.
- IM access is restricted with `ALLOWED_USER_IDS`; `ALLOWED_CONVERSATION_IDS` is recommended for group or shared bot deployments.
- The optional relay control API binds to `127.0.0.1` and uses a startup-scoped bearer token passed only through the child agent environment.
- Runtime logs at `debug` level can include raw IM messages, prompts, and agent output chunks.
- SQLite state can contain workspace names, bindings, thread IDs, transcript events, prompt state, approvals, and paged output.

## Sensitive data

Do not publish:

- `.env`
- `.data/agent-relay.sqlite`
- `logs/`
- IM credentials
- allowlisted user or conversation IDs
- private workspace paths
- prompt text or assistant output that should not be public
- relay media under `.agent-relay/media`
