# Specification: Multi-Forge Support (GitHub, GitLab, Gitea)

## Metadata
- **ID**: spec-2026-04-04-multi-forge-support
- **Status**: draft
- **Created**: 2026-04-04

## Clarifying Questions Asked

The issue (#1) is comprehensive. Key decisions extracted from it:

1. **Q**: Should forge be auto-detected from the webhook payload? **A**: No. The issue explicitly states "No forge auto-detection from webhook payload (explicit config)" — use `FORGE` env var.
2. **Q**: Should Bitbucket be supported? **A**: Not in v1. The issue says "No support for Bitbucket in v1 (can be added later)."
3. **Q**: Should the notification format change? **A**: No. The issue states "No changes to the MCP channel protocol or notification format."
4. **Q**: Should existing GitHub-only configs work without changes? **A**: Yes. `FORGE` defaults to `github`, maintaining backward compatibility.

## Problem Statement

The CI channel plugin currently only supports GitHub Actions. It hardcodes GitHub-specific webhook headers (`x-github-event`, `x-github-delivery`, `x-hub-signature-256`), GitHub payload structures (`workflow_run`), and GitHub CLI commands (`gh run list`, `gh api`). Teams using GitLab CI or Gitea Actions cannot use this plugin.

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

The plugin supports three forges — GitHub Actions, GitLab CI, and Gitea Actions — selected via a `FORGE` environment variable. Each forge has its own:

- Webhook signature validation logic
- Webhook payload parsing (extracting the common `WebhookEvent` fields)
- CLI commands for startup reconciliation
- CLI/API commands for failed job enrichment

The rest of the system (notification formatting, deduplication, allowlist/filter checks, MCP push) remains unchanged because it already works with the forge-agnostic `WebhookEvent` interface.

Existing GitHub-only configurations work without any changes (the `FORGE` env var defaults to `github`).

**Timing clarification**: The server delays 5 seconds after MCP handshake before starting reconciliation (`setTimeout` in `server.ts`). Reconciliation itself has a 10-second total execution budget (`totalBudgetMs` in `reconcile.ts`). Both values are preserved.

## Stakeholders
- **Primary Users**: Developers using Claude Code with GitLab CI or Gitea Actions
- **Secondary Users**: Existing GitHub Actions users (must not break)
- **Technical Team**: CI channel plugin maintainers

## Success Criteria
- [ ] `FORGE=github` (or unset): existing behavior is identical, all 83 existing tests pass
- [ ] `FORGE=gitlab`: GitLab CI pipeline webhooks are received, validated (token header), parsed, and pushed as notifications
- [ ] `FORGE=gitea`: Gitea Actions webhooks are received, validated (HMAC-SHA256), parsed, and pushed as notifications
- [ ] Each forge has startup reconciliation using its native CLI (`gh`, `glab`, `tea`)
- [ ] Each forge has failed-job enrichment using its native CLI/API
- [ ] Invalid `FORGE` value causes a clear error at startup (fail fast)
- [ ] Backward compatibility: existing configs with `GITHUB_REPOS` continue to work
- [ ] Test coverage for all three forges (unit + integration)
- [ ] Documentation updated (README, arch.md, CLAUDE.md)

## Constraints

### Technical Constraints
- Must maintain the existing `WebhookEvent` interface as the common type — all forge parsers produce this same shape. All forge run/pipeline IDs are numeric (GitHub `id`, GitLab `object_attributes.id`, Gitea `id`), so `runId: number` is safe across all forges.
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
- Gitea users have `tea` CLI installed (best-effort). If `tea` lacks CI features, the Gitea forge uses direct HTTP API calls via Node's built-in `fetch` (not curl) to `GITEA_URL` (required for Gitea forge).
- Each deployment targets a single forge (no mixed-forge mode)
- smee.io relay works for all three forges — it proxies raw HTTP POSTs and preserves all headers (signature, event type, delivery ID). This is how smee works by design.

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
- [x] Forge selection mechanism → Answered: `FORGE` env var, default `github`

### Important (Affects Design)
- [x] Repo allowlist configuration → Simplified: Use a single `REPOS` env var (maps to `config.repos`). `GITHUB_REPOS` is kept as a backward-compatible alias — if `REPOS` is not set and `GITHUB_REPOS` is set, use `GITHUB_REPOS`. If both are set, `REPOS` takes precedence. `GITHUB_REPOS` is accepted regardless of forge (it's just a repo list — the name is legacy). No forge-specific `GITLAB_REPOS` or `GITEA_REPOS` vars.
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
- **Reconciliation**: Uses Gitea API via Node's built-in `fetch` (not `tea` CLI, which has limited CI support). Requires `GITEA_URL` config (e.g., `https://gitea.example.com`). Optional `GITEA_TOKEN` for auth. API endpoint: `GET {GITEA_URL}/api/v1/repos/{owner}/{repo}/actions/runs?branch={b}&limit=1`. If `GITEA_URL` is not configured when `FORGE=gitea`, reconciliation is skipped with a warning (same best-effort pattern as `gh` missing for GitHub).
- **Job enrichment**: Gitea API via `fetch`: `GET {GITEA_URL}/api/v1/repos/{owner}/{repo}/actions/runs/{id}/jobs`. Filter for jobs with `conclusion === "failure"`. Uses the same `GITEA_URL` and `GITEA_TOKEN` config.

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
11. **Config**: `REPOS` takes precedence over `GITHUB_REPOS`
12. **Config**: `GITHUB_REPOS` works as fallback when `REPOS` not set
13. **Config**: Invalid `FORGE` value throws at config load time
14. **Config**: `FORGE=gitea` without `GITEA_URL` — reconciliation skipped with warning
15. **Route**: Both `/webhook` and `/webhook/github` accepted
16. **Backward compat**: No `FORGE` env var → defaults to `github`, all existing behavior preserved
17. **Reconciliation**: CLI missing (gh/glab not installed) → skipped with warning, startup continues

### Non-Functional Tests
1. **Performance**: Webhook handling latency unchanged with forge abstraction layer
2. **Security**: Timing-safe comparison for all forge signature schemes

### Fixture Requirements
Test fixtures for GitLab and Gitea must be based on documented webhook payload schemas (GitLab docs, Gitea docs), not invented shapes. Each forge needs at least one realistic fixture for a completed/failed pipeline/workflow.

## Dependencies
- **External CLIs**: `gh` (GitHub), `glab` (GitLab), `tea` (Gitea) — all optional, best-effort
- **No new npm dependencies**: Forge implementations use Node.js built-ins (`crypto`, `child_process`)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| GitLab webhook format differs from docs | Medium | Medium | Test against real GitLab webhook payloads; degrade gracefully for optional fields |
| Gitea `tea` CLI has limited CI features | Medium | Low | Fall back to Gitea API via curl for enrichment |
| Refactoring breaks existing GitHub tests | Low | High | Run existing test suite continuously during development |
| GitLab token comparison not timing-safe | Low | Medium | Use `crypto.timingSafeEqual` with fixed-length buffer padding |

## Configuration Changes

New and changed environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FORGE` | No | `github` | Forge type: `github`, `gitlab`, or `gitea` |
| `REPOS` | No | — | Comma-separated repo/project allowlist (all forges) |
| `GITHUB_REPOS` | No | — | Legacy alias for `REPOS` (backward compat) |
| `GITEA_URL` | Gitea only | — | Gitea instance base URL (for API-based reconciliation/enrichment) |
| `GITEA_TOKEN` | No | — | Gitea API token for authentication |

Precedence: `REPOS` > `GITHUB_REPOS`. Both resolve to `config.repos`.

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

## Notes

The `WebhookEvent` interface and `notify.ts` module are already forge-agnostic. The refactoring primarily affects:
- `webhook.ts` → extract GitHub logic into a forge implementation, create GitLab/Gitea implementations
- `handler.ts` → call forge methods instead of hardcoded GitHub headers
- `reconcile.ts` → extract GitHub CLI calls into forge implementations
- `config.ts` → add `FORGE` env var, `REPOS` alias, Gitea-specific config, keep backward-compatible `GITHUB_REPOS`
- `server.ts` → add `/webhook` route alias, select forge from config

## Expert Consultation

**Date**: 2026-04-04
**Models Consulted**: Codex (GPT-5), Claude

**Codex verdict**: REQUEST_CHANGES (HIGH confidence)
**Claude verdict**: COMMENT (HIGH confidence)
**Gemini**: Skipped (GEMINI_API_KEY not configured)

**Key feedback addressed**:
- GitLab completion semantics: Clarified terminal states (success, failed, canceled, skipped)
- GitLab dedup key: Now includes status to prevent suppressing legitimate state transitions
- Gitea reconciliation: Specified API-based approach with `GITEA_URL`/`GITEA_TOKEN` config instead of underspecified `tea` CLI
- Route backward compatibility: `/webhook/github` kept as alias, `/webhook` added as generic route
- Repo allowlist: Simplified to `REPOS` with `GITHUB_REPOS` as legacy fallback, works for all forges
- GitLab token validation: Clarified length-mismatch behavior (immediate reject, no padding)
- GitLab nested namespaces: Acknowledged, no code change needed, documented
- Timing clarification: Separated 5s startup delay from 10s reconciliation budget
- Test fixtures: Required to be based on documented webhook schemas
- Missing test scenarios: Added config precedence, CLI-missing, route alias, nested namespace tests
