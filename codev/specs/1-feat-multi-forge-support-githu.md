# Specification: Multi-Forge Support (GitHub, GitLab, Gitea)

## Metadata
- **ID**: spec-2026-04-04-multi-forge-support
- **Status**: draft
- **Created**: 2026-04-04

## Clarifying Questions Asked

The issue (#1) is comprehensive. Key decisions extracted from it:

1. **Q**: Should forge be auto-detected from the webhook payload? **A**: No. The issue explicitly states "No forge auto-detection from webhook payload (explicit config)" — use `--forge` CLI arg.
2. **Q**: Should Bitbucket be supported? **A**: Not in v1. The issue says "No support for Bitbucket in v1 (can be added later)."
3. **Q**: Should the notification format change? **A**: No. The issue states "No changes to the MCP channel protocol or notification format."
4. **Q**: Should existing GitHub-only configs work without changes? **A**: Yes. `--forge` defaults to `github`, maintaining backward compatibility.
5. **Q**: Where should configuration live? **A**: Structural config (forge, repos, workflow-filter, reconcile-branches) via CLI args in `.mcp.json`. Secrets (WEBHOOK_SECRET, GITEA_TOKEN) stay in `.env` file. CLI args > env vars > `.env` file precedence.

## Problem Statement

The CI channel plugin (Spec 0) currently only supports GitHub Actions. It hardcodes GitHub-specific webhook headers (`x-github-event`, `x-github-delivery`, `x-hub-signature-256`), GitHub payload structures (`workflow_run`), and GitHub CLI commands (`gh run list`, `gh api`). Teams using GitLab CI or Gitea Actions cannot use this plugin.

The plugin was renamed from `github-ci-channel` to `ci-channel` to reflect the intended broader scope, but the implementation remains GitHub-only.

## Current State

Every layer of the plugin is tightly coupled to GitHub:

| Layer | GitHub-Specific Code |
|-------|---------------------|
| **Signature validation** (`webhook.ts`) | Expects `sha256=` prefix, HMAC-SHA256 only |
| **Event parsing** (`webhook.ts`) | Reads `workflow_run` payload structure |
| **Header extraction** (`handler.ts`) | Reads `x-github-event`, `x-github-delivery`, `x-hub-signature-256` |
| **Repo allowlist config** (`config.ts`) | `GITHUB_REPOS` env var, `githubRepos` field |
| **Startup reconciliation** (`reconcile.ts`) | Spawns `gh run list` |
| **Job enrichment** (`reconcile.ts`) | Spawns `gh api /repos/.../actions/runs/.../jobs` |
| **HTTP route** (`server.ts`) | Hardcoded `/webhook/github` path |
| **smee target** (`server.ts`) | smee-client points to `/webhook/github` |
| **Tests** | All fixtures and assertions use GitHub payload shapes |

The `notify.ts` module is already forge-agnostic — it accepts a `WebhookEvent` interface and doesn't reference any GitHub-specific concepts.

## Desired State

The plugin supports three forges — GitHub Actions, GitLab CI, and Gitea Actions — selected via the `--forge` CLI arg (configured in `.mcp.json`). Each forge has its own:

- Webhook signature validation logic
- Webhook payload parsing (extracting the common `WebhookEvent` fields)
- CLI commands for startup reconciliation
- CLI/API commands for failed job enrichment

The rest of the system (notification formatting, deduplication, allowlist/filter checks, MCP push) remains unchanged because it already works with the forge-agnostic `WebhookEvent` interface.

Existing GitHub-only configurations work without any changes (`--forge` defaults to `github`).

**Configuration model**: Structural config (forge, repos, workflow-filter, reconcile-branches) is passed as CLI args in `.mcp.json`, keeping the full server config in one place. Secrets (WEBHOOK_SECRET, GITEA_TOKEN) remain in `~/.claude/channels/ci/.env`. Precedence: CLI args > env vars > `.env` file.

Example `.mcp.json` for GitLab:
```json
{
  "mcpServers": {
    "ci": {
      "command": "npx",
      "args": ["tsx", "server.ts", "--forge", "gitlab", "--repos", "mygroup/myproject"],
      "cwd": "/path/to/ci-channel"
    }
  }
}
```

**Port assignment**: The HTTP server defaults to port 0 (OS-assigned random port), so multiple Claude Code sessions can coexist without `EADDRINUSE` conflicts. The `--port` CLI arg is an optional override only.

**smee-client integration**: Use smee-client's Node.js API (`new SmeeClient({source, target})`) in-process instead of spawning a subprocess. This eliminates child process management and stdio isolation concerns for smee. Add `smee-client` as a `package.json` dependency (currently spawned via npx).

**First-run auto-provisioning**: On startup, the plugin auto-generates missing configuration:

1. **Webhook secret**: If `WEBHOOK_SECRET` is not set (env var or `.env` file):
   - Generate: `crypto.randomBytes(32).toString('hex')`
   - Write to `~/.claude/channels/ci/.env` (create file/directory if needed)
   - If `WEBHOOK_SECRET` already exists in `.env` or env vars, skip generation

2. **smee channel**: If `--smee-url` is not provided:
   - `fetch('https://smee.io/new', {redirect:'manual'})` → extract channel URL from `Location` header
   - If smee.io unreachable → log warning, continue without relay
   - If `--smee-url` IS provided, use that URL directly (for stable/persistent channels)

3. **HTTP server**: Starts on port 0 (or `--port` if specified). Read actual port from `httpServer.address().port`.

4. **smee-client**: Start in-process via Node.js API: `new SmeeClient({source: channelUrl, target: 'http://127.0.0.1:{port}/webhook'})`

5. **Setup notification**: Push a **channel notification** via `mcp.notification()` with setup instructions:
   ```
   CI channel ready. Configure your forge webhook:
     URL: https://smee.io/abc123
     Secret: a1b2c3d4...
     Events: Workflow runs (GitHub/Gitea) or Pipeline events (GitLab)
   ```
   Claude sees this directly and can relay it to the user. Also log to stderr as backup.

6. Start reconciliation after 5-second delay.

This means the full zero-config setup is:
1. Add MCP server to `.mcp.json` (just `--forge` if not GitHub)
2. Start Claude Code — plugin generates secret, provisions smee, sends notification
3. User pastes URL + secret into forge webhook settings (the only manual step)

**Timing clarification**: The server delays 5 seconds after MCP handshake before starting reconciliation (`setTimeout` in `server.ts`). Reconciliation itself has a 10-second total execution budget (`totalBudgetMs` in `reconcile.ts`). Both values are preserved.

## Stakeholders
- **Primary Users**: Developers using Claude Code with GitLab CI or Gitea Actions
- **Secondary Users**: Existing GitHub Actions users (must not break)
- **Technical Team**: CI channel plugin maintainers

## Success Criteria
- [ ] `--forge github` (or no `--forge` arg): existing behavior is identical, all 83 existing tests pass
- [ ] `--forge gitlab`: GitLab CI pipeline webhooks are received, validated (token header), parsed, and pushed as notifications
- [ ] `--forge gitea`: Gitea Actions webhooks are received, validated (HMAC-SHA256), parsed, and pushed as notifications
- [ ] Each forge has startup reconciliation using its native CLI (`gh`, `glab`) or API (`fetch` for Gitea)
- [ ] Each forge has failed-job enrichment using its native CLI/API
- [ ] Invalid `--forge` value causes a clear error at startup (fail fast)
- [ ] Structural config works via CLI args (`--forge`, `--repos`, `--workflow-filter`, `--reconcile-branches`)
- [ ] Default port 0 allows multiple concurrent sessions without `EADDRINUSE`
- [ ] smee-client runs in-process via Node.js API (not subprocess)
- [ ] Auto-provisions smee channel when `--smee-url` not provided
- [ ] Explicit `--smee-url` uses that URL directly (stable/persistent channels)
- [ ] Auto-generates `WEBHOOK_SECRET` on first run, writes to `~/.claude/channels/ci/.env`
- [ ] Pushes setup instructions (URL + secret) via channel notification to Claude
- [ ] Backward compatibility: existing env-var-only configs (including `GITHUB_REPOS`) continue to work
- [ ] Test coverage for all three forges (unit + integration)
- [ ] Documentation updated (README with per-forge setup guides, arch.md, CLAUDE.md)
- [ ] End-to-end validation: plugin configured on the ci-channel repo itself (cluesmith/ci-channel) — verify a real GitHub Actions failure triggers a channel notification. We are our own first user.

## Constraints

### Technical Constraints
- Must maintain the existing `WebhookEvent` interface (from Spec 0) as the common type — all forge parsers produce this same shape. All forge run/pipeline IDs are numeric (GitHub `id`, GitLab `object_attributes.id`, Gitea `id`), so `runId: number` is safe across all forges.
- Must preserve the MCP stdio isolation pattern (`stdin: 'ignore'` on all subprocesses)
- Must preserve the 5-second startup delay before reconciliation and the 10-second reconciliation execution budget
- Must preserve the fire-and-forget async enrichment pattern
- Must not change the MCP channel notification format or metadata keys
- HTTP server still binds to `127.0.0.1` only

### Business Constraints
- Backward compatibility is non-negotiable — existing GitHub users must not need to change anything
- No Bitbucket support in this version

## Assumptions
- GitLab users have `glab` CLI installed (best-effort, same as `gh` for GitHub). If missing, startup reconciliation and job enrichment are skipped with a warning — the same behavior as `gh` missing today.
- Gitea forge uses direct HTTP API calls via Node's built-in `fetch` to `--gitea-url`. The `tea` CLI is not used (limited CI support). `GITEA_TOKEN` env var provides optional authentication.
- Each deployment targets a single forge (no mixed-forge mode)
- smee.io relay works for all three forges — it proxies raw HTTP POSTs and preserves all headers (signature, event type, delivery ID). This is how smee works by design.
- smee.io is reachable on startup for auto-provisioning (if not, log warning and continue without relay — user must configure `--smee-url` manually or use another proxy)

## Solution Approaches

### Approach 1: Forge Strategy Pattern

**Description**: Create a `Forge` interface that encapsulates all forge-specific behavior. Each forge (GitHub, GitLab, Gitea) implements this interface. The handler, reconciler, and server select the forge implementation based on config.

The interface covers:
- Extracting headers (signature, event type, delivery ID) from the request
- Validating the signature against the webhook secret
- Parsing the payload into a `WebhookEvent`
- Running startup reconciliation (CLI or API calls)
- Fetching failed job details (CLI or API calls)

The reconciliation and enrichment methods receive the full `Config` object so they can access forge-specific config like `GITEA_URL` and `GITEA_TOKEN`.

**Pros**:
- Clean separation of concerns — each forge is isolated
- Easy to add new forges later (implement the interface)
- The handler pipeline logic stays unchanged — it just calls forge methods
- Testable in isolation per forge

**Cons**:
- Requires restructuring existing code into the interface shape
- Some duplication between GitHub and Gitea (very similar webhook formats)

**Estimated Complexity**: Medium
**Risk Level**: Low — the refactoring is mechanical, existing tests anchor the behavior

### Approach 2: Conditional Branching

**Description**: Add `if/else` branches in the existing modules based on a `forge` config value. Keep all code in the same files.

**Pros**:
- Minimal file changes
- Fastest to implement

**Cons**:
- Code becomes harder to read and maintain as forges grow
- Testing individual forges requires navigating conditional paths
- Adding a fourth forge makes it worse
- Violates open-closed principle

**Estimated Complexity**: Low
**Risk Level**: Medium — technical debt accumulates quickly

### Recommended Approach

**Approach 1 (Forge Strategy Pattern)** is recommended. It matches the reference implementation in the codev project (`packages/codev/src/lib/forge.ts`), scales cleanly to future forges, and keeps the handler pipeline simple.

## Open Questions

### Critical (Blocks Progress)
- [x] Forge selection mechanism → Answered: `--forge` CLI arg (default `github`). Also accepted as `FORGE` env var for backward compat (CLI arg takes precedence).
- [x] Configuration model → Answered: Structural config via CLI args in `.mcp.json`, secrets in `.env`. Precedence: CLI args > env vars > `.env` file.

### Important (Affects Design)
- [x] Repo allowlist configuration → Use `--repos` CLI arg (maps to `config.repos`). Also accepted via `REPOS` or `GITHUB_REPOS` env vars. Precedence: `--repos` > `REPOS` > `GITHUB_REPOS`. `GITHUB_REPOS` is accepted regardless of forge (it's just a repo list — the name is legacy). No forge-specific `GITLAB_REPOS` or `GITEA_REPOS` vars.
- [x] Webhook route path → Keep `/webhook/github` as the primary route for backward compatibility. Add `/webhook` as an alias that works for all forges. Both routes go to the same handler. This avoids breaking existing webhook senders and smee configurations. The smee target URL uses the forge-appropriate route (`/webhook/github` for github, `/webhook` for others).
- [x] GitLab nested namespaces → `isRepoAllowed()` uses exact string match, which already handles `group/subgroup/project` — users just need to configure the exact `path_with_namespace` value from GitLab. No code change needed, but document this in README.

### Nice-to-Know (Optimization)
- [x] Dedup key extraction per forge → Each forge extracts its own delivery ID via the Forge interface. The dedup logic is forge-agnostic (tracks string IDs). GitLab uses a synthetic key (see below).

## Forge-Specific Technical Details

### GitHub Actions
- **Signature**: `X-Hub-Signature-256` header, HMAC-SHA256, `sha256=<hex>` format
- **Event type header**: `X-GitHub-Event` (value: `workflow_run`)
- **Delivery ID header**: `X-GitHub-Delivery` (UUID)
- **Action filter**: `payload.action === "completed"`
- **Payload structure**: `{ action, workflow_run: { name, conclusion, head_branch, head_sha, head_commit, html_url, id }, repository: { full_name } }`
- **Reconciliation CLI**: `gh run list --branch <b> --limit 1 --json conclusion,name,headBranch,headSha,url,databaseId`
- **Job enrichment**: `gh api /repos/{owner/repo}/actions/runs/{id}/jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'`

### GitLab CI
- **Signature**: `X-Gitlab-Token` header, direct string comparison (not HMAC). Validation uses `crypto.timingSafeEqual` — both the received token and the configured secret are UTF-8 encoded to buffers. If lengths differ, reject immediately (timing-safe compare requires equal-length buffers). No padding or hashing needed — length mismatch is an immediate `false`.
- **Event type header**: `X-Gitlab-Event` (value: `Pipeline Hook`)
- **Delivery ID**: GitLab does not provide a delivery ID header. Generate a synthetic dedup key: `gitlab-{project.id}-{object_attributes.id}-{object_attributes.status}`. Including `status` ensures that different status transitions for the same pipeline (e.g., `running` → `failed`) are not suppressed by dedup, while true redeliveries of the same status are caught.
- **Payload structure**: `{ object_kind: "pipeline", object_attributes: { id, status, ref, sha, detailed_status }, project: { id, path_with_namespace }, commit: { message, author: { name } }, builds: [...] }`
- **Completion semantics**: Alert on terminal pipeline states only: `success`, `failed`, `canceled`, `skipped`. This matches GitHub's behavior where `action === "completed"` fires for all conclusions (success, failure, cancelled). Non-terminal states (`running`, `pending`, `created`) are filtered as irrelevant.
- **Reconciliation CLI**: `glab ci list --branch <b> --per-page 1 --output json`. Expected fields to map: `status`, `ref` (branch), `sha`, `web_url`, `id` (pipeline ID), `source` (pipeline trigger). The `repoFullName` is not available from `glab ci list` (same limitation as `gh run list`).
- **Job enrichment**: `glab api /projects/{encoded_path}/pipelines/{id}/jobs --per-page 100`. Filter for `status === "failed"`. The project path must be URL-encoded for the API.

### Gitea Actions
- **Signature**: `X-Gitea-Signature` header, HMAC-SHA256 (same algorithm as GitHub, but raw hex — no `sha256=` prefix). The validation logic is shared with GitHub except for prefix stripping.
- **Event type header**: `X-Gitea-Event` (value: `workflow_run`)
- **Delivery ID header**: `X-Gitea-Delivery` (UUID)
- **Payload structure**: Very similar to GitHub's `workflow_run` — `{ action, workflow_run: { name, conclusion, head_branch, head_sha, head_commit, html_url, id }, repository: { full_name } }`
- **Completion semantics**: Same as GitHub — `action === "completed"`, all conclusions reported.
- **Reconciliation**: Uses Gitea API via Node's built-in `fetch` (not `tea` CLI, which has limited CI support). Requires `--gitea-url` config (e.g., `https://gitea.example.com`). Optional `GITEA_TOKEN` env var for auth. API endpoint: `GET {GITEA_URL}/api/v1/repos/{owner}/{repo}/actions/runs?branch={b}&limit=1`. If `--gitea-url` is not configured when `--forge gitea`, reconciliation is skipped with a warning (same best-effort pattern as `gh` missing for GitHub).
- **Job enrichment**: Gitea API via `fetch`: `GET {GITEA_URL}/api/v1/repos/{owner}/{repo}/actions/runs/{id}/jobs`. Filter for jobs with `conclusion === "failure"`. Uses the same `--gitea-url` and `GITEA_TOKEN` config.

## Performance Requirements
- **Webhook response time**: <100ms p95 (same as current — signature check + JSON parse + notification push)
- **Startup reconciliation**: 10s total budget (unchanged)
- **Job enrichment timeout**: 3s per call (unchanged)
- No new external dependencies beyond forge-specific CLIs

## Security Considerations
- **GitHub**: HMAC-SHA256 signature with timing-safe comparison (existing)
- **GitLab**: Token comparison uses `crypto.timingSafeEqual` on UTF-8 buffers. Length mismatch → immediate reject (no padding). Absent `X-Gitlab-Token` header → reject.
- **Gitea**: HMAC-SHA256 signature with timing-safe comparison (same algorithm as GitHub, raw hex without `sha256=` prefix). Absent `X-Gitea-Signature` header → reject.
- All forge implementations must validate signatures before processing payloads
- All user-controlled input continues to flow through `sanitize()` in `notify.ts`
- Subprocess isolation (`stdin: 'ignore'`) applies to all forge CLI calls
- Gitea API calls use optional `GITEA_TOKEN` for authentication (passed via `Authorization: token {GITEA_TOKEN}` header)

## Test Scenarios

### Functional Tests
1. **GitHub forge**: All 83 existing tests pass with `FORGE=github` (regression)
2. **GitLab forge**: Signature validation with `X-Gitlab-Token` (timing-safe, length mismatch, missing header)
3. **GitLab forge**: Parse `Pipeline Hook` payload into `WebhookEvent` (terminal states: success, failed, canceled, skipped)
4. **GitLab forge**: Reject non-terminal pipeline states (running, pending) as irrelevant
5. **GitLab forge**: Reject non-pipeline events (e.g., `Push Hook`) as irrelevant
6. **GitLab forge**: Synthetic delivery ID includes status for correct dedup behavior
7. **GitLab forge**: Nested namespace repos (`group/subgroup/project`) in allowlist
8. **Gitea forge**: HMAC-SHA256 validation via `X-Gitea-Signature` (raw hex, no prefix)
9. **Gitea forge**: Parse `workflow_run` payload (GitHub-like structure)
10. **Gitea forge**: API-based reconciliation and job enrichment (mock HTTP responses)
11. **Config**: `--repos` CLI arg takes precedence over `REPOS` env var over `GITHUB_REPOS`
12. **Config**: `GITHUB_REPOS` env var works as fallback when `--repos` and `REPOS` not set
13. **Config**: Invalid `--forge` value throws at config load time
14. **Config**: `--forge gitea` without `--gitea-url` — reconciliation skipped with warning
15. **Config**: CLI args parsed correctly from `process.argv`
15. **Route**: Both `/webhook` and `/webhook/github` accepted
16. **Backward compat**: No `FORGE` env var → defaults to `github`, all existing behavior preserved
17. **Reconciliation**: CLI missing (gh/glab not installed) → skipped with warning, startup continues
18. **smee**: Auto-provision when `--smee-url` not set → channel URL in notification
19. **smee**: Explicit `--smee-url` → uses that URL directly, no auto-provision
20. **smee**: smee.io unreachable → logs warning, continues without relay
21. **Secret**: Auto-generate `WEBHOOK_SECRET` when not set → written to `~/.claude/channels/ci/.env`
22. **Secret**: Existing `WEBHOOK_SECRET` → used as-is, no generation
23. **Notification**: Setup instructions pushed via channel notification on first run
24. **E2E**: Real GitHub Actions failure on cluesmith/ci-channel triggers notification

### Non-Functional Tests
1. **Performance**: Webhook handling latency unchanged with forge abstraction layer
2. **Security**: Timing-safe comparison for all forge signature schemes

### Fixture Requirements
Test fixtures for GitLab and Gitea must be based on documented webhook payload schemas (GitLab docs, Gitea docs), not invented shapes. Each forge needs at least one realistic fixture for a completed/failed pipeline/workflow.

## Dependencies
- **External CLIs**: `gh` (GitHub), `glab` (GitLab) — optional, best-effort for reconciliation/enrichment
- **Gitea**: Uses Node.js built-in `fetch` against `--gitea-url` API (no external CLI needed)
- **smee-client**: Added as `package.json` dependency (was previously spawned via `npx`). Used via Node.js API in-process.
- **No other new npm dependencies**: Forge implementations use Node.js built-ins (`crypto`, `child_process`, `fetch`)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| GitLab webhook format differs from docs | Medium | Medium | Test against real GitLab webhook payloads; degrade gracefully for optional fields |
| Gitea `tea` CLI has limited CI features | Medium | Low | Fall back to Gitea API via curl for enrichment |
| Refactoring breaks existing GitHub tests | Low | High | Run existing test suite continuously during development |
| GitLab token comparison not timing-safe | Low | Medium | Use `crypto.timingSafeEqual` with fixed-length buffer padding |

## Configuration Changes

Configuration is split between CLI args (structural) and env vars/`.env` (secrets).

### CLI args (structural config, in `.mcp.json`)

| Arg | Default | Description |
|-----|---------|-------------|
| `--forge` | `github` | Forge type: `github`, `gitlab`, or `gitea` |
| `--repos` | — | Comma-separated repo/project allowlist |
| `--workflow-filter` | — | Comma-separated workflow names to monitor |
| `--reconcile-branches` | `ci,develop` | Branches to check on startup |
| `--port` | `0` (OS-assigned) | HTTP server port (0 = random available port) |
| `--gitea-url` | — | Gitea instance base URL (required for Gitea reconciliation/enrichment) |
| `--smee-url` | — | smee.io channel URL (if omitted, auto-provisions a new channel) |

### Env vars / `.env` (secrets only)

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | No (auto-generated) | HMAC-SHA256 shared secret (or GitLab token). Auto-generated on first run if missing. |
| `GITEA_TOKEN` | No | Gitea API token for authentication |

### Backward-compatible env vars

These env vars continue to work for users who haven't migrated to CLI args:

| Env var | Maps to | Notes |
|---------|---------|-------|
| `FORGE` | `--forge` | CLI arg takes precedence |
| `REPOS` | `--repos` | CLI arg takes precedence |
| `GITHUB_REPOS` | `--repos` | Legacy alias, lowest precedence |
| `PORT` | `--port` | CLI arg takes precedence. Legacy default was 8789; new default is 0 |
| `SMEE_URL` | `--smee-url` | CLI arg takes precedence |
| `WORKFLOW_FILTER` | `--workflow-filter` | CLI arg takes precedence |
| `RECONCILE_BRANCHES` | `--reconcile-branches` | CLI arg takes precedence |
| `GITEA_URL` | `--gitea-url` | CLI arg takes precedence |

### Precedence

CLI args > env vars > `.env` file. For repos specifically: `--repos` > `REPOS` > `GITHUB_REPOS`.

### Arg parsing

Simple `process.argv` iteration — no heavy CLI framework. The server iterates `process.argv.slice(2)` and consumes `--flag value` pairs. Unknown flags cause a startup error (fail fast).

## WebhookEvent Field Mapping

All forges produce the same `WebhookEvent` interface. Field sources per forge:

| WebhookEvent field | GitHub | GitLab | Gitea |
|--------------------|--------|--------|-------|
| `workflowName` | `workflow_run.name` | `object_attributes.detailed_status` or pipeline source | `workflow_run.name` |
| `conclusion` | `workflow_run.conclusion` | `object_attributes.status` | `workflow_run.conclusion` |
| `branch` | `workflow_run.head_branch` | `object_attributes.ref` | `workflow_run.head_branch` |
| `commitSha` | `workflow_run.head_sha` | `object_attributes.sha` | `workflow_run.head_sha` |
| `commitMessage` | `workflow_run.head_commit.message` | `commit.message` | `workflow_run.head_commit.message` |
| `commitAuthor` | `workflow_run.head_commit.author.name` | `commit.author.name` | `workflow_run.head_commit.author.name` |
| `runUrl` | `workflow_run.html_url` | Constructed from project URL + pipeline ID | `workflow_run.html_url` |
| `runId` | `workflow_run.id` | `object_attributes.id` | `workflow_run.id` |
| `repoFullName` | `repository.full_name` | `project.path_with_namespace` | `repository.full_name` |
| `deliveryId` | `X-GitHub-Delivery` header | Synthetic: `gitlab-{proj_id}-{pipeline_id}-{status}` | `X-Gitea-Delivery` header |

All fields marked as `string | null` in the interface remain nullable — forge parsers use `?? null` for missing optional fields (commitMessage, commitAuthor).

## Documentation Requirements

The README must include **per-forge setup guides** with forge-specific webhook configuration steps:

- **GitHub**: Settings > Webhooks — content type, secret, events to subscribe, webhook URL
- **GitLab**: Settings > Webhooks — URL, secret token, Pipeline events trigger
- **Gitea**: Settings > Webhooks — URL, secret, workflow_run event

Each guide should include:
1. `.mcp.json` configuration example for that forge
2. `.env` file contents (WEBHOOK_SECRET, forge-specific secrets)
3. Forge-specific webhook configuration steps (with screenshots or links to forge docs)
4. Which webhook events to enable

Also document:
- Auto-provisioned smee channels (the default — no `--smee-url` needed)
- Manual smee channel creation (`npx smee-client --new`) for persistent channels
- The simplified setup flow (npm install → add to .mcp.json → start Claude → paste webhook URL)

## References
- **Spec 0**: `codev/specs/0-ci-channel-plugin.md` — the original CI channel plugin spec. Defines the `WebhookEvent` interface, webhook handler pipeline, notification format, and reconciliation pattern that this spec extends.
- **Codev forge abstraction**: `packages/codev/src/lib/forge.ts` in the codev project — reference implementation for the strategy pattern approach.

## Notes

The `WebhookEvent` interface (Spec 0) and `notify.ts` module are already forge-agnostic. The refactoring primarily affects:
- `webhook.ts` → extract GitHub logic into a forge implementation, create GitLab/Gitea implementations
- `handler.ts` → call forge methods instead of hardcoded GitHub headers
- `reconcile.ts` → extract GitHub CLI calls into forge implementations
- `config.ts` → add `--forge` CLI arg parsing, `--repos` arg, Gitea-specific config, backward-compatible env var fallbacks
- `server.ts` → add `/webhook` route alias, pass `process.argv` to config, select forge from config

## Expert Consultation

**Date**: 2026-04-04
**Models Consulted**: Codex (GPT-5), Claude

**Codex verdict**: REQUEST_CHANGES (HIGH confidence)
**Claude verdict**: COMMENT (HIGH confidence)
**Gemini**: Skipped (GEMINI_API_KEY not configured)

**Key feedback addressed**:
- GitLab completion semantics: Clarified terminal states (success, failed, canceled, skipped)
- GitLab dedup key: Now includes status to prevent suppressing legitimate state transitions
- Gitea reconciliation: Specified API-based approach with `--gitea-url`/`GITEA_TOKEN` config instead of underspecified `tea` CLI
- Route backward compatibility: `/webhook/github` kept as alias, `/webhook` added as generic route
- Repo allowlist: Simplified to `--repos` with `REPOS`/`GITHUB_REPOS` as legacy fallbacks
- GitLab token validation: Clarified length-mismatch behavior (immediate reject, no padding)
- GitLab nested namespaces: Acknowledged, no code change needed, documented
- Timing clarification: Separated 5s startup delay from 10s reconciliation budget
- Test fixtures: Required to be based on documented webhook schemas
- Missing test scenarios: Added config precedence, CLI-missing, route alias, nested namespace tests

**Architect feedback (2026-04-05)**:
- Added Spec 0 reference throughout (original CI channel plugin spec)
- Configuration model changed: structural config via CLI args in `.mcp.json`, secrets in `.env`
- Added CLI arg parsing specification (`process.argv` iteration)
- Backward-compatible env var fallbacks documented with precedence rules
- Default port changed from 8789 to 0 (OS-assigned random port) for multi-session coexistence
- smee-client runs in-process via Node.js API instead of subprocess spawn
- Auto-provisions smee channel when `--smee-url` not provided; logs relay URL
- smee-client added as package.json dependency
- Eliminates EADDRINUSE failure mode when multiple sessions run concurrently
- README must include per-forge setup guides (GitHub, GitLab, Gitea webhook config steps)
- Document `npx smee-client --new` for manual persistent channel creation
- Auto-generate WEBHOOK_SECRET on first run, write to ~/.claude/channels/ci/.env
- Push setup instructions (URL + secret) via channel notification, not just stderr
- E2E validation: configure plugin on cluesmith/ci-channel repo itself
