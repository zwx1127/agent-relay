# Native agent backends

Multi-backend support is **unreleased**, with checkout/package candidate version `0.3.0-next.2`. The published `@asuka1127/agent-relay@0.2.0` package remains Codex-only. Test this checkout with a locally packed tarball until a new version is published.

## Select a backend

Run the installed `agent-relay install` command and choose Codex, Claude Code, or DeepSeek Harness before choosing Telegram or Feishu/Lark. The wizard detects the selected executable with `--version`; it does not install it, authenticate it, collect model credentials, or make a model request. Existing configurations that omit `AGENT_PROVIDER` remain Codex configurations.

| Setting | Codex | Claude Code | DeepSeek Harness |
| --- | --- | --- | --- |
| `AGENT_PROVIDER` | `codex` (default) | `claude` | `dsh` |
| Executable | `CODEX_BIN=codex` | `CLAUDE_BIN=claude` | `DSH_BIN=dsh` |
| Native transport | app-server stdio, or opt-in shared Gateway | persistent native CLI bidirectional stream-JSON | native Web Remote HTTP/WebSocket, loopback only |
| Verified release target | existing Codex 0.159.2 contract; minimum 0.145.0 | 2.1.285; runtime capability negotiation with a 2.1.280 floor | exactly 0.2.0-rc.2 developer preview |
| Configuration and login | native Codex configuration | native Claude configuration and login | native DSH Web-profile composition and provider configuration |
| Shared Codex Gateway | opt-in | unavailable | unavailable |

Release metadata was checked on **2026-09-30**. Claude's npm `latest` was 2.1.285; its delayed `stable` tag was 2.1.280. DSH had no stable release: `latest` and `next` were 0.2.0-rc.2. DSH's preview Web Remote contract has no stable compatibility promise, so unverified versions are refused. A successful `doctor` executable check is not a protocol, authentication, model-access, or IM delivery test.

Install and authenticate the backend independently using its official documentation. Relay never changes a subscription into API-key billing, reads credential stores, creates access tokens, or embeds a login flow. Backend-specific environment variables remain the backend's responsibility; for example, an inherited Anthropic API key can affect native Claude authentication precedence.

## Commands keep their native meaning

Use `/help` after selecting a workspace to discover the active backend's commands. Claude commands are discovered from initialization and refreshed on native catalog updates. DSH commands are queried from the effective native session registry before dispatch. Unknown slash commands are rejected; they never silently turn into model prompts or invoke a similarly named Codex command.

The pre-existing `/relay` entry opens Home for workspace selection and status. It has no management subcommands. Codex keeps its existing commands; Claude and DSH use their own native commands and arguments. There is no separate Relay command dialect to learn.

For DSH, `/new` creates a session and `/resume [search]` opens the saved-session picker. These are explicit Relay shortcuts to DSH's native session APIs; DSH's upstream slash-command registry does not define them. `/new` takes no arguments. `/resume` initially shows up to eight sessions; supply a search term or click **Search sessions** and reply with a native session name or ID to find older sessions. The former Home buttons are removed. Claude keeps native `/clear` and exact-UUID `/resume`; its full session browser remains local. Use the activity-card **Interrupt** button for the active backend.

Switching backends does not rename `/plan`, `/compact`, `/goal`, or `/stop` into a universal operation with invented semantics.

### Command and workflow matrix

| Workflow | Codex | Claude Code | DeepSeek Harness |
| --- | --- | --- | --- |
| Normal prompts | native turn start/steer | native print-mode turn; wait or interrupt before next input | native prompt/steer admission |
| `/plan` | existing Codex collaboration-mode behavior | native Claude permission Plan mode; optional task | exact native registered command, including DSH's arguments |
| `/compact` | existing confirmation + app-server operation | unchanged native command, including optional instructions, when advertised | exact registered native command |
| `/goal` | existing native goal controls | only if the active Claude catalog advertises that command | exact native plugin command and subcommands |
| `/permission` or `/permissions` | existing Codex approval interfaces | `/permissions` is a local terminal dialog; no synthetic policy rewrite | `/permission` is the genuine native preset command |
| `/model` | existing model status/capabilities | native headless command/catalog | IM picker backed by native `modelCatalog` and `selectModel`; no invented slash-argument grammar |
| Resume | existing `/resume` picker | `/resume <native session UUID>`; full session browser remains `claude --resume` locally | `/resume [search]` and **Search sessions** call native persisted session listing/resume (Relay shortcut) |
| Fresh context | existing `/new` and `/clear` | advertised native `/clear` returns its real replacement session UUID | `/new` calls native session creation (Relay shortcut) |
| Custom commands/skills | existing skill picker | native advertised commands, aliases and skills | effective native plugin registry |
| `/export` | not a shared cross-backend command | only if advertised | local native Web browser download UI; not falsely reported as a downloaded file |
| `/login`, `/theme`, `/terminal-setup` | backend-specific | local native terminal only | backend-specific native UI |
| Questions and approvals | existing granular Codex choices | native tool permission callbacks, questions and supported MCP elicitation | native waterfall approvals, user questions and native command interactions |
| Images and screenshots | existing supported Codex capabilities | native base64 PNG/JPEG/GIF/WebP input; bounded local files, no arbitrary URL fetch | native image input using advertised image limits; session-authorized generated image output |
| Audio and other structured attachments | existing supported Codex capabilities | audio and non-image structured input unavailable | generic files/audio and image-attached slash commands unavailable |
| Optional Relay helper | supported | generic helper instructions appended to native system prompt | unavailable: native Web session creation has no supplemental instruction field |

Claude session listing is available through the official SDK’s public `listSessions()` helper. This dependency-free CLI adapter does not currently integrate that helper and does not reimplement its on-disk transcript parser. Exact UUID resume is supported; a complete in-chat picker is an explicit implementation limit, not a claim that upstream enumeration is impossible.

The actual runtime catalog is authoritative. Account, platform, installed plugins, project configuration, and upstream release can change availability. Terminal/browser dialogs are not all representable as slash text; unsupported UI-only actions return explicit guidance instead of being emulated.

## Permissions and session authority

Each backend owns its tools, sandbox, settings, history and permission decisions. Relay normalizes presentation, not policy. Native approval cards contain only choices actually offered by that adapter, and the driver revalidates the live request when a button is clicked. Stale, conflicting, expired and unsupported decisions do not create permission grants. Multi-select answers remain separate selections.

Codex instruction files and Plan-mode tool rules are never read or injected into Claude or DSH. Claude can receive the explicitly enabled generic Relay helper instructions without replacing its native prompt. DSH rejects `RELAY_CONTROL_ENABLED=true`; its user profile is not rewritten to force helper access. The wizard disables that option when DSH is selected.

Persisted native session keys include the provider, so a saved Codex thread is never resumed as a Claude or DSH thread. Existing Codex keys remain compatible. SQLite task/prompt state is also bound to one backend: populated legacy state belongs to Codex, and startup refuses to reinterpret it for Claude or DSH. The wizard proposes a separate state file when switching backends; existing history and queued work are preserved. Use a separate configuration, SQLite state path and bot identity for each concurrent Relay process. Do not simultaneously write to the same native thread from separate unsupported Relay/native sessions. The existing experimental multi-client Gateway remains exclusively Codex's authority.

DSH starts its own native Web profile with `127.0.0.1`, an ephemeral port and no browser launch. The one-time launch URL is exchanged for a short-lived cookie kept in memory. Relay rejects non-loopback launch URLs, redirects and unverified protocol versions. This is local-machine isolation, not a reason to expose the port through tunnels or reverse proxies. Reconnection uses DSH's own session history and projections; Relay adds no semantic journal or offline execution queue.

## Claude distribution and authentication boundary

This project invokes an independently installed native CLI. It does not bundle Anthropic executables, redistribute SDK code, or provide Claude account login. Anthropic's Agent SDK documentation places restrictions on third-party products offering claude.ai login or subscription rate limits without prior approval. Launching a user's CLI is not a grant of redistribution or subscription-product rights; review the applicable upstream terms before offering a hosted service or marketing account entitlements.

## Verification and limitations

Protocol tests use fake native executables and pinned response fixtures, including streaming, image byte/size validation, command catalogs, permission denial, interrupted work, process failures, and stale request/session boundaries. Genuine no-account probes passed against Claude 2.1.285 (version/help, initialization, native clear and Plan control) and DSH 0.2.0-rc.2 (version/help, Web startup, sessions/history, native command/model catalogs, read-only permission and goal commands), without making a model request. These checks do not establish live authenticated model behavior or Telegram/Feishu end-to-end delivery. Those require a separate opt-in test using the owner's configured backend and bot.

The new adapters have local Linux test coverage. Safe Windows executable/shim argument construction is unit-tested; this is not a claim of a live Windows/macOS backend test. When a Windows `.cmd`/`.bat` shim cannot safely carry an argument, Relay fails with guidance to use a native executable instead of invoking a shell with untrusted input.

## Primary sources

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [headless use](https://code.claude.com/docs/en/headless), [slash commands](https://code.claude.com/docs/en/agent-sdk/slash-commands), [sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code 2.1.285 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.285), [SDK terms and integration guidance](https://code.claude.com/docs/en/agent-sdk/overview), [native authentication](https://code.claude.com/docs/en/authentication)
- [DeepSeek Harness official repository](https://github.com/deepseek-ai/deepseek-harness), [pinned 0.2.0-rc.2 source](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84), [official package](https://www.npmjs.com/package/@deepseek-ai/dsh)
