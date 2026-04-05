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
- Must maintain the existing `WebhookEvent` interface as the common type — all forge parsers produce this same shape
- Must preserve the MCP stdio isolation pattern (`stdin: 'ignore'` on all subprocesses)
- Must preserve the 5-second startup delay for reconciliation
- Must preserve the fire-and-forget async enrichment pattern
- Must not change the MCP channel notification format or metadata keys
- HTTP server still binds to `127.0.0.1` only

### Business Constraints
- Backward compatibility is non-negotiable — existing GitHub users must not need to change anything
- No Bitbucket support in this version

## Assumptions
- GitLab users have `glab` CLI installed (best-effort, same as `gh` for GitHub)
- Gitea users have `tea` CLI installed (best-effort, same as `gh` for GitHub)
- Each deployment targets a single forge (no mixed-forge mode)
- smee.io relay works for all three forges (it's just HTTP POST proxying)

## Solution Approaches

### Approach 1: Forge Strategy Pattern

**Description**: Create a `Forge` interface that encapsulates all forge-specific behavior. Each forge (GitHub, GitLab, Gitea) implements this interface. The handler, reconciler, and server select the forge implementation based on config.

The interface covers:
- Extracting headers (signature, event type, delivery ID) from the request
- Validating the signature against the webhook secret
- Parsing the payload into a `WebhookEvent`
- Running startup reconciliation CLI commands
- Fetching failed job details

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
- [x] Should `GITHUB_REPOS` be renamed? → Keep it for backward compatibility, add a generic `REPOS` alias that takes precedence when set. The forge-specific name (`GITHUB_REPOS`) remains valid for GitHub forge.
- [x] Webhook route path → Change to `/webhook` (generic). The forge is known from config, not from the URL path.

### Nice-to-Know (Optimization)
- [ ] Should dedup key extraction differ per forge? → Probably not needed. Each forge has a unique delivery/request ID header. The dedup logic itself is forge-agnostic (it just tracks string IDs).

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
- **Signature**: `X-Gitlab-Token` header, direct string comparison (not HMAC)
- **Event type header**: `X-Gitlab-Event` (value: `Pipeline Hook`)
- **Delivery ID**: Not provided by GitLab — generate a synthetic ID from `project_id + pipeline_id`
- **Payload structure**: `{ object_kind: "pipeline", object_attributes: { id, status, ref, sha, detailed_status }, project: { path_with_namespace }, commit: { message, author: { name } }, builds: [...] }`
- **Status filter**: `object_attributes.status === "failed"` (or `"success"` — alert on all completions to match GitHub behavior)
- **Reconciliation CLI**: `glab ci list --branch <b> --per-page 1 --output json`
- **Job enrichment**: `glab api /projects/{id}/pipelines/{id}/jobs`

### Gitea Actions
- **Signature**: `X-Gitea-Signature` header, HMAC-SHA256 (same algorithm as GitHub, no `sha256=` prefix — raw hex)
- **Event type header**: `X-Gitea-Event` (value: `workflow_run`)
- **Delivery ID header**: `X-Gitea-Delivery` (UUID)
- **Payload structure**: Very similar to GitHub's `workflow_run` — `{ action, workflow_run: { name, conclusion, head_branch, head_sha, head_commit, html_url, id }, repository: { full_name } }`
- **Reconciliation CLI**: `tea ci ls` (limited — may need direct Gitea API via curl)
- **Job enrichment**: Gitea API via curl: `GET /api/v1/repos/{owner}/{repo}/actions/runs/{id}/jobs`

## Performance Requirements
- **Webhook response time**: <100ms p95 (same as current — signature check + JSON parse + notification push)
- **Startup reconciliation**: 10s total budget (unchanged)
- **Job enrichment timeout**: 3s per call (unchanged)
- No new external dependencies beyond forge-specific CLIs

## Security Considerations
- **GitHub**: HMAC-SHA256 signature with timing-safe comparison (existing)
- **GitLab**: Token comparison must also be timing-safe (use `timingSafeEqual` on buffers)
- **Gitea**: HMAC-SHA256 signature with timing-safe comparison (same as GitHub, different header format)
- All forge implementations must validate signatures before processing payloads
- All user-controlled input continues to flow through `sanitize()` in `notify.ts`
- Subprocess isolation (`stdin: 'ignore'`) applies to all forge CLI calls

## Test Scenarios

### Functional Tests
1. **GitHub forge**: All 83 existing tests pass with `FORGE=github` (regression)
2. **GitLab forge**: Signature validation with `X-Gitlab-Token` (timing-safe)
3. **GitLab forge**: Parse `Pipeline Hook` payload into `WebhookEvent`
4. **GitLab forge**: Reject non-pipeline events as irrelevant
5. **GitLab forge**: Synthetic delivery ID for deduplication
6. **Gitea forge**: HMAC-SHA256 validation via `X-Gitea-Signature` (no `sha256=` prefix)
7. **Gitea forge**: Parse `workflow_run` payload (GitHub-like structure)
8. **Gitea forge**: Startup reconciliation with `tea` CLI
9. **Invalid forge**: `FORGE=bitbucket` throws at config load time
10. **Backward compatibility**: No `FORGE` env var → defaults to `github`, all existing behavior preserved

### Non-Functional Tests
1. **Performance**: Webhook handling latency unchanged with forge abstraction layer
2. **Security**: Timing-safe comparison for all forge signature schemes

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

## Notes

The `WebhookEvent` interface and `notify.ts` module are already forge-agnostic. The refactoring primarily affects:
- `webhook.ts` → extract GitHub logic into a forge implementation, create GitLab/Gitea implementations
- `handler.ts` → call forge methods instead of hardcoded GitHub headers
- `reconcile.ts` → extract GitHub CLI calls into forge implementations
- `config.ts` → add `FORGE` env var, keep backward-compatible `GITHUB_REPOS`
- `server.ts` → change route to `/webhook`, select forge from config
