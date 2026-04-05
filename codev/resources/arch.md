# CI Channel — Architecture

> Last updated: 2026-04-04

## Overview

A Claude Code channel plugin that receives GitHub Actions webhook events via a local HTTP server and pushes structured CI notifications into running Claude Code sessions. Push-based (not polling), with startup reconciliation for offline failures and async job-detail enrichment.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js (via tsx) | 18+ |
| Language | TypeScript | — |
| Protocol | MCP (Model Context Protocol) | SDK ^1.12.1 |
| Transport | stdio (MCP) + HTTP (webhooks) | — |
| Testing | node:test (built-in) | Node 20+ |
| Webhook proxy | smee.io / smee-client | — |
| CLI dependency | gh (GitHub CLI) | optional |

## Directory Structure

```
ci-channel/
├── server.ts                  # Entry point: MCP server + HTTP server + smee + reconciliation
├── lib/
│   ├── config.ts              # Configuration loading (.env + env vars)
│   ├── handler.ts             # Webhook handler pipeline (orchestrates the flow)
│   ├── webhook.ts             # Signature validation, event parsing, dedup, filtering
│   ├── notify.ts              # Notification formatting, sanitization, MCP push
│   └── reconcile.ts           # Startup reconciliation + async job enrichment
├── tests/
│   ├── config.test.ts         # 20 tests — config loading
│   ├── webhook.test.ts        # 25 tests — signatures, parsing, dedup, filtering
│   ├── notify.test.ts         # 18 tests — sanitization, formatting
│   ├── reconcile.test.ts      # 6 tests — reconciliation, job fetching
│   ├── integration.test.ts    # 9 tests — full HTTP pipeline
│   ├── stdio-lifecycle.test.ts # 1 test — MCP stdio stability
│   └── fixtures/
│       └── workflow-run-failure.json
├── .claude-plugin/
│   └── plugin.json            # Plugin metadata for Claude Code
├── .mcp.json                  # MCP server registration
├── codev/                     # Development methodology (specs, plans, reviews)
│   ├── specs/
│   ├── plans/
│   ├── reviews/
│   └── resources/
│       ├── arch.md            # This file
│       └── lessons-learned.md
├── package.json
├── CLAUDE.md                  # Claude Code-specific instructions
├── AGENTS.md                  # Cross-tool AI agent instructions
├── README.md                  # User-facing documentation
├── CONTRIBUTING.md            # Contributor guide
└── LICENSE                    # MIT
```

## Key Components

### MCP Server (`server.ts`)

**Purpose**: Entry point that wires everything together.

Responsibilities:
- Creates MCP `Server` with `claude/channel` capability and instructions
- Connects via `StdioServerTransport`
- Starts HTTP server on `127.0.0.1:{PORT}` with single route: `POST /webhook/github`
- Spawns smee-client as child process when `SMEE_URL` is configured
- Triggers delayed startup reconciliation (5s after MCP handshake)
- Handles EADDRINUSE with clear error message

### Configuration (`lib/config.ts`)

**Purpose**: Loads and validates settings.

Sources (in priority order):
1. Environment variables (`process.env`)
2. File: `~/.claude/channels/ci/.env`

Validates `WEBHOOK_SECRET` is present (required). Parses `PORT` strictly via `Number()`. Splits comma-separated lists for `GITHUB_REPOS`, `WORKFLOW_FILTER`, `RECONCILE_BRANCHES`.

### Webhook Handler (`lib/handler.ts`)

**Purpose**: Orchestrates the webhook processing pipeline.

Pipeline steps:
1. Validate HMAC-SHA256 signature → 403 if invalid
2. Check deduplication by delivery ID → 200 if duplicate
3. Parse event → 400 if malformed JSON, 200 if irrelevant event
4. Check repo allowlist → 200 drop if not listed
5. Check workflow filter → 200 drop if not matching
6. Format and push notification → immediately (never blocked by enrichment)
7. Fire-and-forget: async job enrichment
8. Return 200

### Webhook Parsing (`lib/webhook.ts`)

**Purpose**: Signature validation, event parsing, deduplication, filtering.

Key functions:
- `validateSignature()` — HMAC-SHA256 with timing-safe comparison
- `parseWebhookEvent()` — Extracts `WebhookEvent` from payload, returns discriminated union (`event | irrelevant | malformed`)
- `isDuplicate()` — Bounded dedup set (100 entries, FIFO eviction)
- `isRepoAllowed()` / `isWorkflowAllowed()` — Allowlist/filter checks

### Notification (`lib/notify.ts`)

**Purpose**: Formats and sanitizes channel notifications.

Key functions:
- `sanitize()` — Escapes HTML entities, strips control chars, truncates to max length
- `formatNotification()` — Builds `{ content, meta }` from a `WebhookEvent`
- `pushNotification()` — Calls `mcp.notification()` with `notifications/claude/channel` method

### Reconciliation (`lib/reconcile.ts`)

**Purpose**: Catches missed failures and enriches notifications.

Key functions:
- `runStartupReconciliation()` — Checks configured branches via `gh run list`, pushes notifications for recent failures. 10s total budget.
- `fetchFailedJobs()` — Calls `gh api` to get failed job names. 3s timeout. Best-effort, never blocks.

All subprocess calls use `stdin: 'ignore'` to prevent consuming MCP stdin bytes.

## Data Flow

```
GitHub Actions (workflow completes)
        │
        ▼
   GitHub webhook POST
        │
        ▼
   smee.io (relay)
        │
        ▼
   localhost:{PORT}/webhook/github
        │
        ▼
┌──────────────────────────────────────┐
│        Webhook Handler Pipeline       │
├──────────────────────────────────────┤
│ 1. Validate HMAC-SHA256 signature    │
│ 2. Check dedup (X-GitHub-Delivery)   │
│ 3. Parse JSON → WebhookEvent         │
│ 4. Check repo allowlist              │
│ 5. Check workflow filter             │
│ 6. Format notification               │
│ 7. Push to MCP channel               │
│ 8. Async: fetch failed job names     │
└──────────────────────────────────────┘
        │
        ▼
   MCP notification → Claude Code session
```

### Startup Flow

```
server.ts starts
    ├── Load config (fail fast if WEBHOOK_SECRET missing)
    ├── Create MCP Server with channel capability
    ├── Connect StdioServerTransport
    ├── Create webhook handler
    ├── Start HTTP server on 127.0.0.1:{PORT}
    ├── Spawn smee-client (if SMEE_URL configured)
    └── setTimeout(5s) → runStartupReconciliation()
```

The 5-second delay ensures the MCP handshake completes before any notifications are sent. Writing to stdout before the initialize handshake corrupts the JSON-RPC stream.

## External Dependencies

| Dependency | Purpose | Required | Documentation |
|------------|---------|----------|---------------|
| GitHub Webhooks | Sends `workflow_run` events | Yes | [docs](https://docs.github.com/en/webhooks) |
| smee.io | Relays webhooks to localhost | No (but recommended) | [smee.io](https://smee.io) |
| gh CLI | Startup reconciliation + job enrichment | No (best-effort) | [cli.github.com](https://cli.github.com) |
| @modelcontextprotocol/sdk | MCP protocol implementation | Yes | [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |

## Configuration

All configuration via `~/.claude/channels/ci/.env` or environment variables (env vars take precedence):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOK_SECRET` | Yes | — | HMAC-SHA256 shared secret |
| `PORT` | No | `8789` | HTTP server port |
| `SMEE_URL` | No | — | smee.io channel URL |
| `GITHUB_REPOS` | No | — | Comma-separated repo allowlist |
| `WORKFLOW_FILTER` | No | — | Comma-separated workflow name filter |
| `RECONCILE_BRANCHES` | No | `ci,develop` | Branches to check on startup |

## Security Model

1. **HMAC-SHA256 signature validation** — Every webhook verified with timing-safe comparison. Invalid → 403.
2. **Localhost-only binding** — HTTP server on `127.0.0.1` only.
3. **Repository allowlist** — Defense-in-depth on top of HMAC.
4. **Input sanitization** — All user-controlled fields (commit messages, branch names, author names) escaped and truncated before inclusion in notifications.
5. **Deduplication** — Bounded 100-entry set prevents replay from GitHub retry logic.
6. **Subprocess isolation** — All child processes use `stdin: 'ignore'` to prevent MCP stdio corruption.

## Conventions

- **No build step**: TypeScript runs directly via `tsx`
- **Fail fast**: Missing required config throws immediately, no fallbacks
- **Async enrichment**: Never blocks the primary notification path
- **Sanitize at the boundary**: All user-controlled input sanitized in `notify.ts` before reaching MCP
- **Meta keys**: Underscore-separated only (no hyphens) per channels spec

---

*Generated from codev review and source analysis. To update: run MAINTAIN or edit directly.*
