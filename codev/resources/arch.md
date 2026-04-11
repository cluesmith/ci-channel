# CI Channel — Architecture

> Last updated: 2026-04-10

## Overview

A Claude Code channel plugin that receives CI/CD webhook events from multiple forges (GitHub Actions, GitLab CI, Gitea Actions) via a local HTTP server and pushes structured notifications into running Claude Code sessions. Push-based (not polling), with auto-provisioning on first run, startup reconciliation for offline failures, and async job-detail enrichment.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js (via tsx) | 20+ |
| Language | TypeScript | — |
| Protocol | MCP (Model Context Protocol) | SDK ^1.12.1 |
| Transport | stdio (MCP) + HTTP (webhooks) | — |
| Testing | node:test (built-in) | Node 20+ |
| Webhook proxy | smee-client (in-process) | ^2.0.4 |
| Interactive prompts | @inquirer/prompts (installer only) | 8.4.1 (pinned) |
| CLI dependencies | gh, glab (optional) | — |

## Directory Structure

```
ci-channel/
├── server.ts                  # Entry point: setup dispatch + MCP server + HTTP server + bootstrap + reconciliation
├── lib/
│   ├── forge.ts               # Forge interface definition (strategy pattern)
│   ├── forges/
│   │   ├── github.ts          # GitHub Actions forge implementation
│   │   ├── gitlab.ts          # GitLab CI forge implementation
│   │   └── gitea.ts           # Gitea Actions forge implementation
│   ├── config.ts              # Configuration loading (CLI args + env vars + .env)
│   ├── bootstrap.ts           # First-run auto-provisioning (secret, smee, notification)
│   ├── state.ts               # Plugin state persistence (state.json read/write)
│   ├── exec.ts                # Subprocess runner (shared by CLI-based forges)
│   ├── handler.ts             # Webhook handler pipeline (orchestrates the flow)
│   ├── webhook.ts             # WebhookEvent interface, dedup, filtering (forge-agnostic)
│   ├── notify.ts              # Notification formatting, sanitization, MCP push
│   ├── reconcile.ts           # Startup reconciliation orchestration
│   └── setup/                 # Interactive installer (`ci-channel setup` subcommand)
│       ├── index.ts           # runSetup entry point + promptForRepo loop + dep wiring
│       ├── args.ts            # parseSetupArgs with interactive/non-interactive matrix
│       ├── types.ts           # SetupArgs + ParseSetupArgsResult (discriminated union)
│       ├── errors.ts          # SetupError + UserDeclinedError (clean-exit subclass)
│       ├── project.ts         # detectProjectRoot wrapper around findProjectRoot
│       ├── state.ts           # Project-local state read/write with chmod 0o600
│       ├── gitignore.ts       # Ancestor-walking .gitignore matcher (warning-only)
│       ├── gh.ts              # gh CLI wrapper: ghListHooks (--slurp + fallback), ghCreateHook (piped stdin)
│       ├── mcp-json.ts        # .mcp.json read/merge/write with 7-shape fail-fast matrix
│       ├── io.ts              # Io implementations: createAutoYesIo + createInteractiveIo (@inquirer/prompts)
│       └── orchestrator.ts    # runInstall end-to-end flow with dependency injection + confirm prompts
├── tests/
│   ├── forges/
│   │   ├── gitlab.test.ts     # GitLab forge unit tests
│   │   └── gitea.test.ts      # Gitea forge unit tests
│   ├── config.test.ts         # Config loading, CLI args, precedence
│   ├── webhook.test.ts        # GitHub forge + shared webhook tests
│   ├── notify.test.ts         # Sanitization, formatting
│   ├── bootstrap.test.ts      # Auto-provisioning with injected deps
│   ├── reconcile.test.ts      # Reconciliation, job enrichment
│   ├── integration.test.ts    # GitHub HTTP pipeline end-to-end
│   ├── integration-gitlab.test.ts  # GitLab HTTP pipeline end-to-end
│   ├── integration-gitea.test.ts   # Gitea HTTP pipeline end-to-end
│   ├── stdio-lifecycle.test.ts     # MCP stdio stability regression
│   ├── setup-args.test.ts     # Installer arg parser matrix
│   ├── setup-dispatch.test.ts # Subcommand dispatch smoke tests (source + built dist)
│   ├── setup-mcp-json.test.ts # .mcp.json 7-shape matrix
│   ├── setup-gh.test.ts       # gh wrapper with injected spawn
│   ├── setup-orchestrator.test.ts # runInstall all idempotency rows
│   ├── setup-integration.test.ts  # Real-fs integration (chmod 0o600, idempotent re-run)
│   ├── setup-interactive.test.ts  # Confirmation prompts, decline paths (scripted Io)
│   ├── setup-io-tty.test.ts   # TTY matrix + promptForRepo loop
│   └── fixtures/
│       ├── workflow-run-failure.json      # GitHub webhook payload
│       ├── gitlab-pipeline-failure.json   # GitLab webhook payload
│       └── gitea-workflow-run-failure.json # Gitea webhook payload
├── .claude-plugin/
│   └── plugin.json            # Plugin metadata for Claude Code
├── .mcp.json                  # MCP server registration
├── codev/                     # Development methodology
├── package.json
├── CLAUDE.md
├── README.md
└── LICENSE
```

## Key Components

### Forge Interface (`lib/forge.ts`)

**Purpose**: Strategy pattern interface for multi-forge support.

Each forge implements:
- `validateSignature()` — Forge-specific webhook signature/token validation
- `parseWebhookEvent()` — Forge-specific payload parsing into common `WebhookEvent`
- `runReconciliation()` — Startup failure check via forge-specific CLI or API
- `fetchFailedJobs()` — Async job name enrichment via forge-specific CLI or API

### Forge Implementations

| Forge | Signature | Event Type | CLI/API | File |
|-------|-----------|------------|---------|------|
| GitHub | HMAC-SHA256 (`X-Hub-Signature-256`) | `workflow_run` (all actions) | `gh` CLI | `lib/forges/github.ts` |
| GitLab | Token (`X-Gitlab-Token`) | `Pipeline Hook` (all states) | `glab` CLI | `lib/forges/gitlab.ts` |
| Gitea | HMAC-SHA256 (`X-Gitea-Signature`, raw hex) | `workflow_run` (all actions) | Gitea API via `fetch` | `lib/forges/gitea.ts` |

### MCP Server (`server.ts`)

**Purpose**: Entry point that wires everything together, plus top-of-file dispatch to the `setup` subcommand.

Responsibilities:
- **Subcommand dispatch** (before any other runtime code): if `process.argv[2] === 'setup'`, dynamically import `lib/setup/index.js` and delegate to `runSetup`. The dynamic import keeps installer-only dependencies (`@inquirer/prompts`) off the server path. ESM hoists the static imports, so the dispatch check happens after imports resolve but before `loadConfig()` and any other side-effecting code.
- Creates MCP `Server` with `claude/channel` capability and instructions
- Connects via `StdioServerTransport`
- Selects forge implementation based on `--forge` config
- Starts HTTP server on port 0 (OS-assigned) with routes: `POST /webhook` and `POST /webhook/github`
- Runs bootstrap (secret generation, smee provisioning, setup notification)
- Starts smee-client in-process via Node.js API
- Triggers delayed startup reconciliation (5s after MCP handshake)

### Interactive Installer (`lib/setup/`)

**Purpose**: Replace the legacy five-step manual install flow (register MCP → launch → read state → create webhook → relaunch) with a single command: `npx ci-channel setup --repo owner/repo`. GitHub-only in v1; GitLab/Gitea users fall back to the manual flow documented in INSTALL.md.

The installer is a pure addition to the codebase — no existing `lib/` file was modified. It reuses `findProjectRoot` from `lib/project-root.ts`, `loadState` from `lib/state.ts` (for reads), and `fetchSmeeChannel` from `lib/bootstrap.ts`. Notably it does **not** reuse `saveState`, which swallows write errors — the installer needs error-propagating writes with an explicit `chmod 0o600` on the state file.

**Modules** (all under `lib/setup/`):

| File | Purpose |
|------|---------|
| `index.ts` | `runSetup(argv)` entry point. Selects `Io` based on `--yes`, prompts for missing repo via `promptForRepo`, builds real `InstallDeps`, calls `runInstall`. Catches `SetupError`/`UserDeclinedError` for clean stderr output. |
| `args.ts` | `parseSetupArgs(argv, {isTty})` — full flag set with interactive/non-interactive matrix. Returns discriminated union `{ kind: 'run', args } \| { kind: 'help' }`. Throws `SetupError` for invalid input. |
| `types.ts` | `SetupArgs` type + `ParseSetupArgsResult` discriminated union. |
| `errors.ts` | `SetupError` (userMessage + exitCode) + `UserDeclinedError extends SetupError` (exitCode 0) for clean decline exits. |
| `project.ts` | `detectProjectRoot(cwd)` wrapper that throws `SetupError` if no `.mcp.json`/`.git/` found. |
| `state.ts` | `readStateForSetup` (reuses `loadState`) + `writeStateForSetup` (own `writeFileSync` with `mode: 0o600` + explicit `chmodSync` to handle existing-file case) + `legacyGlobalStateExists` for the informational note. |
| `gitignore.ts` | Ancestor-walking `.gitignore` matcher. Used to warn when `.claude/channels/ci/` is not ignored (state.json contains a secret). |
| `gh.ts` | `gh` CLI wrapper. `ghListHooks` prefers `gh api --paginate --slurp` with a documented fallback to page-by-page parsing for older `gh` versions. `ghCreateHook` (`POST`) and `ghUpdateHook` (`PATCH`) both use `stdio: ['pipe', 'pipe', 'pipe']` so the JSON payload can be written to a dedicated stdin pipe without inheriting `process.stdin`. `ghUpdateHook` is used to rotate the hook's secret in place when the installer generates a fresh secret and finds a matching URL — without it, the existing hook would keep signing with the lost secret and the runtime would fail HMAC validation on every event. |
| `mcp-json.ts` | `readMcpJson` (I/O + JSON parse only) + `mergeCiServer` (pure function with all 7 fail-fast shape cases) + `writeMcpJson` (indent-preserving write). |
| `io.ts` | Two `Io` implementations: `createAutoYesIo` (confirm → true, prompt throws) and `createInteractiveIo` (wraps `@inquirer/prompts` `confirm` + `input`). Converts inquirer errors (`ExitPromptError` → Ctrl-C exit 130) to `SetupError`. |
| `orchestrator.ts` | `runInstall(args, deps, io)` — end-to-end flow with dependency injection. Handles all idempotency rows from the spec: state reuse, `--smee-url` override (secret reuse + old-webhook warning), skip state write when unchanged, dry-run semantics (read-only `ghListHooks` still runs, mutating ops skipped), conditional next-steps reminder (only when `.mcp.json` was created/merged), and confirmation prompts before each mutating step (smee provision, state write, webhook create, `.mcp.json` update). |

**Flow** (for a non-dry-run, `--yes` install):

```
runSetup(argv)
    ├── parseSetupArgs → { kind: 'run', args }
    ├── io = createAutoYesIo()
    ├── deps = buildInstallDeps()
    └── runInstall(args, deps, io)
        ├── detectProjectRoot()
        ├── legacyGlobalStateExists() → informational note (if true)
        ├── readState() → existingState
        ├── resolveSecret:   generate 256-bit or reuse existing
        │                    (tracks secretWasGenerated flag)
        ├── resolveSmeeUrl:  --smee-url override | reuse | fetchSmeeChannel
        ├── isGitignored check → io.warn if not ignored
        ├── ghListHooks(repo) → scan for matching smee URL
        ├── warn if multiple hooks point at the same URL
        ├── ── webhook reconciliation FIRST (before state write) ──
        │   if matching hook
        │     → ghUpdateHook(repo, id, canonical_payload)
        │       [PATCH — always reconcile, no skip path. Sets the
        │        canonical ci-channel config: url, content_type=json,
        │        secret, insecure_ssl=0, events=[workflow_run],
        │        active=true. See orchestrator.ts field audit comment.]
        │   else
        │     → ghCreateHook(repo, canonical_payload)
        │       [POSTs via piped stdin]
        │   (any failure or user decline throws HERE — state.json untouched)
        ├── writeState(projectRoot, state)  [skipped if unchanged; mode 0o600]
        │   (only reached if the webhook step succeeded)
        ├── readMcpJson + mergeCiServer → {updated, action}
        ├── writeMcpJson  [skipped if action === 'skipped_exists']
        └── printNextSteps(action)  [conditional approval reminder]
```

**Critical ordering invariant**: the webhook reconciliation runs **before** the state.json write. If state were written first, a subsequent failure or user decline of the webhook PATCH would leave state.json inconsistent with the remote state. By reconciling the webhook first, a failure/decline throws before state is touched, and the next run correctly re-runs the reconciliation.

**No skip path (iter5 structural fix)**: After four iterations of finding silent-failure modes in the skip path (iter1: secret-not-rotated when state deleted; iter2: state-persisted-before-webhook race; iter3: single-field URL-mismatch skip; iter4: active=false / wrong events / wrong content_type skip), the skip path was removed entirely. The installer now always PATCHes an existing hook with the canonical ci-channel payload. The cost is one extra API call per re-run; the benefit is that skip-path edge cases are eliminated by construction. See the extensive `Webhook field audit` block comment in `lib/setup/orchestrator.ts` for the per-field rationale.

### Configuration (`lib/config.ts`)

**Purpose**: Loads and validates settings from CLI args, env vars, and `.env` file.

Sources (in priority order):
1. CLI args (`process.argv` — `--forge`, `--repos`, `--port`, etc.)
2. Environment variables (`process.env`)
3. File: `<project-root>/.claude/channels/ci/.env` (user-supplied secrets only)
4. File: `<project-root>/.claude/channels/ci/state.json` (auto-provisioned state — lowest priority)

Project root is detected by walking up from `process.cwd()` looking for `.mcp.json` or `.git/`. If no project root is found, both paths fall back to the legacy global location `~/.claude/channels/ci/` for backward compatibility with pre-project-scope installs.

Key config fields: `forge`, `webhookSecret` (nullable — auto-generated), `port` (default 0), `repos`, `smeeUrl`, `giteaUrl`, `giteaToken`.

The `.env` file is only ever touched by the user. `state.json` is only ever touched by the plugin (bootstrap on first run, or `ci-channel setup` via `lib/setup/state.ts`).

### Bootstrap (`lib/bootstrap.ts`)

**Purpose**: First-run auto-provisioning with injectable deps for testability.

Flow:
1. Ensure webhook secret (generate if missing, check `state.json`)
2. Provision smee.io channel (if `--smee-url` not provided, 5s timeout)
3. Persist auto-provisioned state to `state.json` (survives restarts)
4. Start smee-client in-process
5. Push setup notification via MCP channel

Auto-provisioned state (generated secret, smee URL) is persisted to `<project-root>/.claude/channels/ci/state.json` (project-local, with a fallback to the legacy global path `~/.claude/channels/ci/` when no project root is detected). The `.env` file is reserved for user-supplied secrets and is never written by the plugin or the installer. All bootstrap side effects are injectable via `BootstrapDeps` interface for testability.

### Webhook Handler (`lib/handler.ts`)

**Purpose**: Orchestrates the forge-agnostic webhook processing pipeline.

Pipeline steps:
1. Validate signature via `forge.validateSignature()` → 403 if invalid
2. Parse event via `forge.parseWebhookEvent()` → 400 if malformed, 200 if irrelevant
3. Check deduplication by delivery ID → 200 if duplicate
4. Check repo allowlist → 200 drop if not listed
5. Check workflow filter → 200 drop if not matching
6. Format and push notification → immediately
7. Fire-and-forget: async job enrichment via `forge.fetchFailedJobs()`
8. Return 200

### Webhook Types (`lib/webhook.ts`)

**Purpose**: Forge-agnostic types, deduplication, and filtering.

Exports:
- `WebhookEvent` interface — common type produced by all forge parsers
- `ParseResult` discriminated union — `event | irrelevant | malformed`
- `isDuplicate()` — Bounded dedup set (100 entries, FIFO eviction)
- `isRepoAllowed()` / `isWorkflowAllowed()` — Allowlist/filter checks

### Notification (`lib/notify.ts`)

**Purpose**: Formats and sanitizes channel notifications.

### Subprocess Runner (`lib/exec.ts`)

**Purpose**: Shared subprocess helper for CLI-based forges (GitHub, GitLab).

Exports `runCommand(args, timeoutMs)` — spawns a CLI command with timeout, returns stdout or null. All subprocess calls use `stdin: 'ignore'` to prevent consuming MCP stdin bytes.

### Reconciliation (`lib/reconcile.ts`)

**Purpose**: Generic startup reconciliation loop. Iterates branches, calls `forge.runReconciliation()` per branch, applies workflow filter, pushes notifications.

## Data Flow

```
Forge (GitHub/GitLab/Gitea)
        │
    webhook POST
        │
        ▼
   smee.io (relay)
        │
        ▼
   localhost:{port}/webhook
        │
        ▼
┌──────────────────────────────────────┐
│        Webhook Handler Pipeline       │
├──────────────────────────────────────┤
│ 1. forge.validateSignature()         │
│ 2. forge.parseWebhookEvent()         │
│ 3. Check dedup (delivery ID)         │
│ 4. Check repo allowlist              │
│ 5. Check workflow filter             │
│ 6. Format notification               │
│ 7. Push to MCP channel               │
│ 8. Async: forge.fetchFailedJobs()    │
└──────────────────────────────────────┘
        │
        ▼
   MCP notification → Claude Code session
```

### Startup Flow

```
server.ts starts
    ├── Load config (CLI args + env vars + .env)
    ├── Select forge implementation
    ├── Create MCP Server with channel capability
    ├── Connect StdioServerTransport
    ├── Create webhook handler (with forge)
    ├── Start HTTP server on port 0
    └── listen callback:
        └── setTimeout(5s) → (after MCP handshake completes)
            ├── Bootstrap (ensure secret, provision smee, persist, push notification)
            ├── Start smee-client in-process
            └── runStartupReconciliation()
```

## Security Model

1. **Webhook signature validation** — Per-forge: HMAC-SHA256 (GitHub, Gitea) or token comparison (GitLab), all timing-safe.
2. **Localhost-only binding** — HTTP server on `127.0.0.1` only.
3. **Repository allowlist** — Defense-in-depth on top of signature validation.
4. **Input sanitization** — All user-controlled fields escaped and truncated before inclusion in notifications.
5. **Deduplication** — Bounded 100-entry set prevents replay.
6. **Subprocess isolation** — No child process inherits `process.stdin`, which would steal bytes from the MCP JSON-RPC stream. Server-path subprocesses use `stdin: 'ignore'`; the `setup` installer's `ghCreateHook` uses `stdio: ['pipe', 'pipe', 'pipe']` with a dedicated stdin pipe for `gh api --input -`. Both satisfy the invariant.
7. **No stdin event handlers** — `process.stdin.on("close")` must never be used in MCP stdio servers; it kills long-lived in-process connections (smee-client EventSource).

## Conventions

- **No build step**: TypeScript runs directly via `tsx`
- **Forge strategy pattern**: All forge-specific behavior in `lib/forges/`
- **Auto-provisioning**: Secret and smee auto-generated on first run
- **Async enrichment**: Never blocks the primary notification path
- **Sanitize at the boundary**: All user-controlled input sanitized in `notify.ts` before reaching MCP
- **Meta keys**: Underscore-separated only (no hyphens) per channels spec

---

*Updated for Spec 3 (interactive installer). To update: run MAINTAIN or edit directly.*
