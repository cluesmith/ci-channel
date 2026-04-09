# CI Channel — Architecture

> Last updated: 2026-04-05

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
│   └── reconcile.ts           # Startup reconciliation orchestration
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
| GitHub | HMAC-SHA256 (`X-Hub-Signature-256`) | `workflow_run` completed | `gh` CLI | `lib/forges/github.ts` |
| GitLab | Token (`X-Gitlab-Token`) | `Pipeline Hook` terminal states | `glab` CLI | `lib/forges/gitlab.ts` |
| Gitea | HMAC-SHA256 (`X-Gitea-Signature`, raw hex) | `workflow_run` completed | Gitea API via `fetch` | `lib/forges/gitea.ts` |

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
6. **Subprocess isolation** — All child processes use `stdin: 'ignore'` to prevent MCP stdio corruption.

## Conventions

- **No build step**: TypeScript runs directly via `tsx`
- **Forge strategy pattern**: All forge-specific behavior in `lib/forges/`
- **Auto-provisioning**: Secret and smee auto-generated on first run
- **Async enrichment**: Never blocks the primary notification path
- **Sanitize at the boundary**: All user-controlled input sanitized in `notify.ts` before reaching MCP
- **Meta keys**: Underscore-separated only (no hyphens) per channels spec

---

*Updated for Spec 1 (multi-forge support). To update: run MAINTAIN or edit directly.*
