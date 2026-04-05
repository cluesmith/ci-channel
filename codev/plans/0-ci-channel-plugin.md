# Plan: CI Channel Plugin

## Metadata
- **ID**: plan-2026-04-02-ci-channel
- **Status**: integrated
- **Specification**: [codev/specs/0-ci-channel-plugin.md](../specs/0-ci-channel-plugin.md)
- **Created**: 2026-04-02

## Executive Summary

Implement a one-way Claude Code channel plugin that receives GitHub Actions webhook events via a local HTTP server and pushes CI notifications into the running Claude session. Uses Approach 1 from the spec: HTTP webhook receiver with smee.io proxy for local development.

## Success Metrics
- [x] All specification success criteria met
- [x] Tests cover: signature validation, event filtering, notification formatting, config loading, startup reconciliation, allowlist/filter behavior, malformed payloads
- [x] < 100ms from webhook receipt to `mcp.notification()` call (enrichment is async, never blocks)
- [x] Zero secrets leaked in channel notifications
- [x] README covers full setup flow

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Plugin Scaffold, Configuration, and MCP Channel Server"},
    {"id": "phase_2", "title": "Webhook Processing and Channel Notifications"},
    {"id": "phase_3", "title": "Smee.io, Startup Reconciliation, and Job Enrichment"},
    {"id": "phase_4", "title": "Integration Tests, Documentation, and PR"}
  ]
}
```

## Phase Breakdown

### Phase 1: Plugin Scaffold, Configuration, and MCP Channel Server
**Dependencies**: None

#### Objectives
- Create the plugin directory structure
- Implement configuration loading (needed by all subsequent phases)
- Implement the MCP server with `claude/channel` capability
- Add an HTTP server that accepts POST requests on a configurable port
- Handle `EADDRINUSE` with a clear error message

#### Deliverables
- [x] Plugin manifest at `.claude-plugin/plugin.json`
- [x] MCP config at `.mcp.json`
- [x] Main server file at `server.ts`
- [x] `.gitignore`
- [x] `package.json` with dependencies
- [x] `lib/config.ts`: configuration loading from env file + env vars
- [x] `tests/config.test.ts`: config loading tests
- [x] HTTP server listening on `127.0.0.1:PORT` accepting POST to `/webhook/github`

#### Implementation Details

**Directory structure:**
```
ci-channel/
├── .claude-plugin/
│   └── plugin.json
├── .gitignore
├── .mcp.json
├── package.json
├── server.ts          # Main entry: MCP server + HTTP listener
├── lib/
│   ├── config.ts      # Configuration loading from env
│   ├── handler.ts     # Webhook handler pipeline
│   ├── webhook.ts     # Signature validation + event parsing
│   ├── notify.ts      # Notification formatting + channel push
│   └── reconcile.ts   # Startup reconciliation via gh CLI
└── tests/
    ├── config.test.ts
    ├── webhook.test.ts
    ├── notify.test.ts
    ├── reconcile.test.ts
    ├── integration.test.ts
    ├── stdio-lifecycle.test.ts
    └── fixtures/
        └── workflow-run-failure.json
```

**`lib/config.ts`:**
```ts
interface Config {
  webhookSecret: string        // WEBHOOK_SECRET (required)
  port: number                 // PORT (default: 8789)
  smeeUrl: string | null       // SMEE_URL (optional)
  githubRepos: string[] | null // GITHUB_REPOS (optional, comma-separated)
  workflowFilter: string[] | null // WORKFLOW_FILTER (optional, comma-separated)
  reconcileBranches: string[]  // RECONCILE_BRANCHES (default: "ci,develop")
}

export function loadConfig(envFilePath?: string): Config
// 1. Read ~/.claude/channels/ci/.env (if exists)
// 2. Merge with process.env (env vars take precedence)
// 3. Validate WEBHOOK_SECRET is present — fail fast with clear error
// 4. Parse PORT as integer, default 8789
// 5. Split GITHUB_REPOS, WORKFLOW_FILTER, RECONCILE_BRANCHES on commas
```

**`server.ts` structure:**
- Load config via `loadConfig()` — fail fast if `WEBHOOK_SECRET` is missing
- Create MCP `Server` with `capabilities.experimental['claude/channel']`
- Set `instructions` telling Claude how to interpret CI failure events
- Connect via `StdioServerTransport`
- Start HTTP server on `127.0.0.1:PORT` with single route: `POST /webhook/github`
- Handle `EADDRINUSE` error with clear message
- All other routes return 404

---

### Phase 2: Webhook Processing and Channel Notifications
**Dependencies**: Phase 1

#### Objectives
- Validate GitHub webhook signatures (HMAC-SHA256)
- Parse and filter events: only `workflow_run.completed`
- Format and push structured notifications via channel protocol — immediately, never blocked by enrichment
- Sanitize user-controlled fields against prompt injection
- Implement deduplication via `X-GitHub-Delivery` header

#### Deliverables
- [x] `lib/webhook.ts`: signature validation, JSON parsing, event filtering, dedup, allowlist/filter
- [x] `lib/notify.ts`: notification formatting, content sanitization, `mcp.notification()` call
- [x] `lib/handler.ts`: webhook handler pipeline
- [x] `tests/webhook.test.ts`: signature, parsing, dedup, malformed JSON, allowlist/filter tests
- [x] `tests/notify.test.ts`: formatting, sanitization tests

#### Implementation Details

**HTTP handler flow:**
1. Read `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery` headers
2. Read body as text
3. `validateSignature(body, signature, config.webhookSecret)` → **403** if invalid/missing
4. Check delivery ID dedup → **200** if duplicate
5. `parseWebhookEvent(eventType, deliveryId, body)`:
   - `type === 'malformed'` → **400**
   - `type === 'irrelevant'` → **200** (silently dropped)
   - `type === 'event'` → continue
6. Check `event.repoFullName` against allowlist → **200** drop if not listed
7. Check `event.workflowName` against filter → **200** drop if not matching
8. `formatNotification(event)` → push via `mcp.notification()` **immediately**
9. Return **200**

**Critical: notification is never blocked by enrichment.** The base notification is emitted immediately. Job-detail enrichment runs as a separate async operation.

**Sanitization:**
- Replace `<` with `&lt;` and `>` with `&gt;`
- Strip control characters (except newline/tab)
- Truncate: commit messages 200 chars, branch names 100 chars, author 100 chars

**Deduplication:**
- `Set<string>` of recent `X-GitHub-Delivery` IDs (keep last 100)
- Evict oldest via `set.keys().next().value` (Set preserves insertion order)

---

### Phase 3: Smee.io, Startup Reconciliation, and Job Enrichment
**Dependencies**: Phase 2

#### Objectives
- Spawn smee-client as child process when `SMEE_URL` is configured
- Run startup reconciliation (`gh run list`) on configurable branches
- Add async job-detail enrichment via `gh api` (never blocks the notification)

#### Deliverables
- [x] smee-client child process management (spawn on start, kill on exit/stdin close)
- [x] `lib/reconcile.ts`: startup reconciliation logic with configurable branches
- [x] Async job-detail enrichment in notification flow (best-effort, 3s timeout)
- [x] `tests/reconcile.test.ts`: reconciliation and enrichment tests

#### Implementation Details

**smee-client management:**
- Spawn `npx smee-client` with target `http://127.0.0.1:{port}/webhook/github`
- All stdio set to `'ignore'` to prevent MCP stream pollution
- Kill on process exit, SIGINT, SIGTERM, and stdin close

**Startup reconciliation:**
- For each branch in `reconcileBranches`, run `gh run list --branch {branch} --limit 1`
- If most recent run has `conclusion: failure`, push notification
- Apply workflow filter if configured (match live webhook behavior)
- Shared 10s total budget across all branches
- Non-fatal: if `gh` unavailable, log warning and continue

**Async job enrichment:**
- After pushing initial notification, fire-and-forget: `gh api /repos/{repo}/actions/runs/{id}/jobs`
- 3-second timeout, errors swallowed silently
- If jobs found, push follow-up notification with job names

**CRITICAL**: All `gh` subprocess calls use `stdin: 'ignore', stdout: 'pipe', stderr: 'ignore'` — never pollute MCP stdio.

---

### Phase 4: Integration Tests, Documentation, and PR
**Dependencies**: Phase 3

#### Deliverables
- [x] `tests/integration.test.ts`: full HTTP pipeline end-to-end
- [x] `tests/stdio-lifecycle.test.ts`: MCP stdio stability regression test
- [x] `tests/fixtures/workflow-run-failure.json`: real webhook payload fixture
- [x] `README.md`: complete setup and usage guide
- [x] End-to-end verification

---

## Dependency Map
```
Phase 1 (Scaffold + Config) → Phase 2 (Webhook + Notifications) → Phase 3 (Smee/Reconciliation) → Phase 4 (Tests/Docs)
```

## Integration Points
- **GitHub Webhooks**: Sends `workflow_run` events via HTTP POST
- **smee.io**: Proxies GitHub webhooks to localhost
- **gh CLI**: Startup reconciliation and job enrichment (best-effort)

## Risk Analysis
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Channels API changes in research preview | Medium | Medium | Pin MCP SDK version; minimal surface area |
| Port conflict on 8789 | Low | Low | PORT is configurable |
| smee-client crashes or disconnects | Low | Medium | Log warning; developer restarts session |
| MCP stdio pollution from subprocesses | Medium | High | All subprocesses use `stdin: 'ignore', stderr: 'ignore'` |

## Validation Checkpoints
1. **After Phase 1**: Plugin starts, MCP channel registers, HTTP endpoint responds
2. **After Phase 2**: Signed webhook → notification pushed; invalid webhook → rejected
3. **After Phase 3**: smee spawns, startup reconciliation catches offline failures
4. **After Phase 4**: All tests pass (83), README complete, end-to-end verified
