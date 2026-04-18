# CI Channel — Architecture

> Last updated: 2026-04-11

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
| CLI dependencies | gh, glab (optional) | — |

## Directory Structure

```
ci-channel/
├── server.ts                  # Entry point: MCP server + HTTP server + bootstrap + reconciliation
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
│   ├── project-root.ts        # Walk-up project root discovery (.mcp.json / .git)
│   └── setup.ts               # `ci-channel setup` + `remove` — multi-forge installer/uninstaller + Codev auto-integration (Spec 5 + Spec 7 + Spec 8)
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
│   ├── setup.test.ts               # `ci-channel setup` + `remove` installer/uninstaller (28 scenarios total: 18 setup + 10 remove)
│   ├── stdio-lifecycle.test.ts     # MCP stdio stability regression
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

**Purpose**: Entry point that wires everything together.

Responsibilities:
- Creates MCP `Server` with `claude/channel` capability and instructions
- Connects via `StdioServerTransport`
- Selects forge implementation based on `--forge` config
- Starts HTTP server on port 0 (OS-assigned) with routes: `POST /webhook` and `POST /webhook/github`
- Runs bootstrap (secret generation, smee provisioning, setup notification)
- Starts smee-client in-process via Node.js API
- Triggers delayed startup reconciliation (5s after MCP handshake)

### Configuration (`lib/config.ts`)

**Purpose**: Loads and validates settings from CLI args, env vars, and `.env` file.

Sources (in priority order):
1. CLI args (`process.argv` — `--forge`, `--repos`, `--port`, etc.)
2. Environment variables (`process.env`)
3. File: `~/.claude/channels/ci/.env` (user-supplied secrets only)
4. File: `~/.claude/channels/ci/state.json` (auto-provisioned state — lowest priority)

Key config fields: `forge`, `webhookSecret` (nullable — auto-generated), `port` (default 0), `repos`, `smeeUrl`, `giteaUrl`, `giteaToken`.

The `.env` file is only ever touched by the user. `state.json` is only ever touched by the plugin.

### Bootstrap (`lib/bootstrap.ts`)

**Purpose**: First-run auto-provisioning with injectable deps for testability.

Flow:
1. Ensure webhook secret (generate if missing, check `state.json`)
2. Provision smee.io channel (if `--smee-url` not provided, 5s timeout)
3. Persist auto-provisioned state to `state.json` (survives restarts)
4. Start smee-client in-process
5. Push setup notification via MCP channel

Auto-provisioned state (generated secret, smee URL) is persisted to `~/.claude/channels/ci/state.json`, not `.env`. The `.env` file is reserved for user-supplied secrets. All bootstrap side effects are injectable via `BootstrapDeps` interface for testability.

### Webhook Handler (`lib/handler.ts`)

**Purpose**: Orchestrates the forge-agnostic webhook processing pipeline.

Pipeline steps:
1. Validate signature via `forge.validateSignature()` → 403 if invalid
2. Parse event via `forge.parseWebhookEvent()` → 400 if malformed, 200 if irrelevant
3. Check deduplication by delivery ID → 200 if duplicate
4. Check repo allowlist → 200 drop if not listed
5. Check workflow filter → 200 drop if not matching
6. Check conclusion filter (Spec 13) → 200 drop if not matching
7. Format and push notification → immediately
8. Fire-and-forget: async job enrichment via `forge.fetchFailedJobs()`
9. Return 200

### Webhook Types (`lib/webhook.ts`)

**Purpose**: Forge-agnostic types, deduplication, and filtering.

Exports:
- `WebhookEvent` interface — common type produced by all forge parsers
- `ParseResult` discriminated union — `event | irrelevant | malformed`
- `isDuplicate()` — Bounded dedup set (100 entries, FIFO eviction)
- `isRepoAllowed()` / `isWorkflowAllowed()` — Allowlist/filter checks
- `normalizeConclusion()` — Pure lowercase + spelling canonicalization (`failed`→`failure`, `canceled`→`cancelled`). Used by both config-load and the runtime filter.
- `isConclusionAllowed()` (Spec 13) — Three-mode filter: `null` allowlist uses a hardcoded exclusion set of known non-failure and in-progress outcomes (`success`, `skipped`, `neutral`, `manual`, `stale`, `requested`, `in_progress`, `completed`, `running`, `pending`, `queued`, `waiting`, `preparing`, plus GitLab-specific `created`, `waiting_for_resource`, `scheduled`) and forwards everything else (including unknown strings — fail-open for novel forge outcomes). `['all']` sentinel bypasses the filter entirely. Any other list is treated as an inclusion list with normalization applied to the event side only (the allowlist is pre-normalized at config-load).

### Notification (`lib/notify.ts`)

**Purpose**: Formats and sanitizes channel notifications.

### Subprocess Runner (`lib/exec.ts`)

**Purpose**: Shared subprocess helper for CLI-based forges (GitHub, GitLab).

Exports `runCommand(args, timeoutMs)` — spawns a CLI command with timeout, returns stdout or null. All subprocess calls use `stdin: 'ignore'` to prevent consuming MCP stdin bytes.

### Reconciliation (`lib/reconcile.ts`)

**Purpose**: Generic startup reconciliation loop. Iterates branches, calls `forge.runReconciliation()` per branch, applies workflow filter, pushes notifications.

### Installer/Uninstaller (`lib/setup.ts`)

**Purpose**: Implements the `ci-channel setup` AND `ci-channel remove` subcommands in a single file. A deliberately single-file, non-DI, ≤400-line implementation (Spec 8 raised the cap from Spec 7's 300 to accommodate `remove()`). Exports two functions: `setup()` performs install operations, `remove()` reverses them. Spec 5 constrained the file rigidly after Spec 3's 4,385-line attempt was abandoned; Spec 7 loosened the cap to 300 lines for multi-forge support; Spec 8 loosened to 400 for the remove subcommand. See `codev/resources/lessons-learned.md` entry "Prefer single-file implementations + real-fs tests for install/bootstrap commands."

**Supported forges (Spec 7)**: the CLI accepts `--forge github|gitlab|gitea` (default `github`). Each forge branch shares the same common flow (parse args → project root → [Gitea-only token check] → load state → generate secret → fetch smee → write state → forge API call → `.mcp.json` merge → Codev integration → done). The only per-forge divergence is the "forge API call" step:
- **GitHub**: `gh api repos/OWNER/REPO/hooks` via subprocess, POST/PATCH with canonical webhook payload
- **GitLab**: `glab api projects/ENCODED_PATH/hooks` via subprocess, POST/**PUT** (not PATCH) with the `pipeline_events: true`, `push_events: false`, ... payload. `path_with_namespace` is URL-encoded via `encodeURIComponent` so nested subgroups work.
- **Gitea**: global `fetch` against `{gitea-url}/api/v1/repos/OWNER/REPO/hooks`, POST/PATCH with a GitHub-like `config.url/secret/content_type` payload. `type: "gitea"` is ONLY on the POST body (Gitea's update endpoint rejects it). Requires `GITEA_TOKEN` from `process.env` or `<project>/.claude/channels/ci/.env` — the only exception to state-first ordering is this fail-fast token check, which runs BEFORE smee/state provisioning so a missing token doesn't burn a smee channel.

**Design choices worth knowing about**:
- **No DI**: calls `fs`, `spawn`, `fetch` (via `fetchSmeeChannel`) directly. Tests use a PATH-override fake `gh`/`glab` binary and a local `http.createServer` for Gitea, and prepopulate state.json to skip the smee fetch path.
- **State-first ordering**: state.json is written before any webhook API call on all paths where a write is needed, so a partial failure leaves the secret/URL persisted for the next run. (Exception: Gitea token validation runs before state provisioning — see above.)
- **Conditional write**: state.json is only written when the computed desired state deep-differs from what's on disk (checked by `webhookSecret` + `smeeUrl` field equality plus `Object.keys(existing).length === 2`). This is a correctness check, not a speed optimization — it avoids mtime churn on idempotent re-runs.
- **Key-presence `.mcp.json` merge**: if `mcpServers.ci` is present (regardless of contents), the file is left alone. This respects user customizations like manually adding `--repos` to `args`.
- **Always-PATCH/PUT**: when a matching webhook is found by URL, the installer updates it with the canonical payload unconditionally. No "skip if already correct" fast path.
- **Codev auto-integration (Spec 7)**: after the core install, if `<project>/.codev/config.json` exists, the installer appends `--dangerously-load-development-channels server:ci` to `shell.architect` (idempotent — substring check). Wrapped in a local `try/catch` that warns and exits 0 on failure — the webhook is already live by this point, so a malformed Codev config should not report "setup failed."
- **Shared error classification**: `classifyForgeError(bin, err, repo)` maps 404/403/401/ENOENT from `gh` or `glab` stderr to user-friendly error messages. Gitea uses `giteaFetch(url, init, repo, base)` which does the equivalent classification from HTTP status codes.

**Dispatch**: `server.ts` checks `process.argv[2] === 'setup' || process.argv[2] === 'remove'` as a 5-line block before `loadConfig()` and dynamically imports `./lib/setup.js`. The dynamic import still only fires on these two subcommands, so the server startup path does NOT load installer/uninstaller code. Everything else on the CLI (forges, flags) passes through unchanged.

**Uninstaller (`remove()`, Spec 8)**: Reverses what `setup()` did. Deletes the forge webhook (matched by `smeeUrl` from `state.json`), deletes `state.json`, strips the canonical `ci` entry from `.mcp.json` (leaves non-canonical entries alone with a warning), and reverts Codev integration if `.codev/config.json` contains the loader flag. Fails fast with exit 1 if:
- `state.json` is missing → `no ci-channel install detected`
- `state.json` is unreadable or missing `smeeUrl` → distinct error messages
- `findProjectRoot()` returns null → same error as setup
- For Gitea: `GITEA_TOKEN` not set (precondition check before any HTTP call)
- LIST call returns 404 (repo not found) → hard fail via `classifyForgeError`

**404 handling**: the spec disambiguates list-404 (hard fail, repo not found) from delete-404 (soft — webhook already gone, treat as success and continue local cleanup). For GitHub and GitLab, the distinction happens via a nested `cliDelete` helper inside `remove()` with two try/catch blocks — LIST errors hard-fail through `classifyForgeError`, DELETE errors are inspected for `HTTP 404|Not Found` and swallowed. For Gitea, LIST uses the existing `giteaFetch` (404 → hard fail), but DELETE bypasses `giteaFetch` and uses direct `fetch()` with manual status handling.

**Canonical `.mcp.json` check**: `remove()` only deletes the `ci` entry if it exactly matches the shape `setup()` writes for the passed `--forge`: `{ command: 'npx', args: [...] }` with no extra keys and with the full expected args array (forge-specific trailing args included). If the entry has been customized (extra `env` key, different command, hand-edited args), `remove()` leaves it alone and logs a warning. This is the only "safety valve" in remove — there's no `--force` flag.

**Second-run behavior**: `state.json` is the source of truth for "is ci-channel installed here?". Running `remove` twice in a row: first succeeds and deletes `state.json`, second fails fast with exit 1 and `no ci-channel install detected`. This is intentionally NOT idempotent exit-0 — a non-zero exit is more informative for scripts.

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
│ 6. Check conclusion filter           │
│ 7. Format notification               │
│ 8. Push to MCP channel               │
│ 9. Async: forge.fetchFailedJobs()    │
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
6. **Subprocess isolation** — All child processes use `stdin: 'ignore'` to prevent MCP stdio corruption.
7. **No stdin event handlers** — `process.stdin.on("close")` must never be used in MCP stdio servers; it kills long-lived in-process connections (smee-client EventSource).

## Conventions

- **No build step**: TypeScript runs directly via `tsx`
- **Forge strategy pattern**: All forge-specific behavior in `lib/forges/`
- **Auto-provisioning**: Secret and smee auto-generated on first run
- **Async enrichment**: Never blocks the primary notification path
- **Sanitize at the boundary**: All user-controlled input sanitized in `notify.ts` before reaching MCP
- **Meta keys**: Underscore-separated only (no hyphens) per channels spec

---

*Updated for Spec 1 (multi-forge support). To update: run MAINTAIN or edit directly.*
