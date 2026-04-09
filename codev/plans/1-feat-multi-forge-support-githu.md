# Plan: Multi-Forge Support (GitHub, GitLab, Gitea)

## Metadata
- **ID**: plan-2026-04-05-multi-forge-support
- **Status**: draft
- **Specification**: codev/specs/1-feat-multi-forge-support-githu.md
- **Created**: 2026-04-05

## Executive Summary

Implement multi-forge support using the Forge Strategy Pattern (Spec 1, Approach 1). The work is split into four phases:

1. **Foundation**: Define Forge interface, add CLI arg parsing, refactor existing GitHub code into `GitHubForge`, update server for port 0 and route alias. All 83 existing tests must pass.
2. **GitLab**: Implement `GitLabForge` with pipeline webhook parsing, token validation, glab-based reconciliation/enrichment.
3. **Gitea**: Implement `GiteaForge` with workflow_run parsing, HMAC validation, fetch-based API reconciliation/enrichment.
4. **Documentation**: Update README, arch.md, CLAUDE.md, and .mcp.json examples.

## Success Metrics
- [ ] All specification criteria met
- [ ] All 83 existing tests pass after Phase 1 refactor (regression)
- [ ] New tests for GitLab and Gitea forges
- [ ] Each forge has unit tests for signature validation, event parsing, reconciliation, enrichment
- [ ] Integration tests for each forge's full webhook pipeline
- [ ] Documentation complete

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "forge_abstraction", "title": "Forge abstraction + GitHub refactor + config"},
    {"id": "gitlab_forge", "title": "GitLab forge implementation"},
    {"id": "gitea_forge", "title": "Gitea forge implementation"},
    {"id": "documentation", "title": "Documentation updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Forge abstraction + GitHub refactor + config
**Dependencies**: None

#### Objectives
- Define the `Forge` interface
- Add CLI arg parsing to `config.ts`
- Extract all GitHub-specific code into `GitHubForge`
- Refactor handler, reconciler, and server to use the Forge interface
- Change default port to 0, spawn smee after server starts
- Add `/webhook` route alias alongside `/webhook/github`
- All 83 existing tests must still pass

#### Deliverables
- [ ] `lib/forge.ts` — Forge interface definition
- [ ] `lib/forges/github.ts` — GitHubForge implementation (extracted from webhook.ts, reconcile.ts)
- [ ] `lib/config.ts` — CLI arg parsing, all `--flag` args, backward-compat env vars
- [ ] `lib/bootstrap.ts` — Auto-provisioning: secret generation, smee channel, .env writing, setup notification
- [ ] `lib/handler.ts` — Refactored to use Forge interface instead of hardcoded GitHub headers
- [ ] `lib/reconcile.ts` — Refactored: generic orchestration, forge-specific logic in GitHubForge
- [ ] `server.ts` — Port 0 default, bootstrap after listen, `/webhook` + `/webhook/github` routes, forge selection
- [ ] `lib/webhook.ts` — Retains `WebhookEvent` interface, dedup, and filter functions. GitHub-specific parsing/validation moves to GitHubForge.
- [ ] Updated tests — existing tests adapted for new config shape (port default, `repos` field name)
- [ ] `tests/config.test.ts` — New tests for CLI arg parsing and precedence
- [ ] `tests/bootstrap.test.ts` — Tests for auto-provisioning with injected deps (no real filesystem/network)

#### Implementation Details

**Forge interface** (`lib/forge.ts`):
```typescript
import type { ParseResult, WebhookEvent } from './webhook.js';  // reuse existing types from Spec 0
import type { Config } from './config.js';

export interface Forge {
  readonly name: string;
  validateSignature(payload: string, headers: Headers, secret: string): boolean;  // Web API Headers
  parseWebhookEvent(headers: Headers, body: string): ParseResult;  // existing ParseResult from webhook.ts
  runReconciliation(config: Config, branch: string, timeoutMs: number): Promise<WebhookEvent | null>;
  fetchFailedJobs(config: Config, repoFullName: string, runId: number): Promise<string[] | null>;
}
```

`ParseResult` is the existing discriminated union from `webhook.ts` (`type: "event" | "irrelevant" | "malformed"`). `Headers` is the Web API `Headers` class (already constructed in `server.ts` from Node's `IncomingMessage`).

**CLI arg parsing** (`lib/config.ts`):
- Parse `process.argv.slice(2)` by iterating `--flag value` pairs
- Unknown flags → throw at startup (fail fast)
- Precedence: CLI args > env vars > `.env` file
- All supported flags:
  - `--forge` (default `github`; validates against `github | gitlab | gitea`)
  - `--repos` (comma-separated; replaces `GITHUB_REPOS`/`REPOS` with backward compat)
  - `--port` (default `0`; was `8789`)
  - `--workflow-filter` (comma-separated; replaces `WORKFLOW_FILTER`)
  - `--reconcile-branches` (comma-separated; replaces `RECONCILE_BRANCHES`, default `ci,develop`)
  - `--gitea-url` (Gitea instance base URL; replaces `GITEA_URL`)
  - `--smee-url` (smee.io channel URL; replaces `SMEE_URL`)
- Config type changes:
  - `githubRepos` → `repos` (type unchanged: `string[] | null`)
  - Add `forge: string` (`"github" | "gitlab" | "gitea"`)
  - Add `giteaUrl: string | null`
  - Add `giteaToken: string | null` (from `GITEA_TOKEN` env var only — secret, not a CLI arg)
- **Remove fail-fast throw for missing `WEBHOOK_SECRET`** from `loadConfig()`. The secret is no longer required at config load time — it will be auto-generated in the bootstrap phase if missing. `loadConfig()` returns `webhookSecret: string | null`; the bootstrap module handles generation before any webhook processing starts.
- Update port validation error message: "between 0 and 65535" (was "between 1 and 65535") since 0 is now a valid default.

**Handler refactor** (`lib/handler.ts`):
- `createWebhookHandler(config, mcp, forge)` — receives forge as parameter
- Calls `forge.validateSignature()` instead of reading `x-hub-signature-256` directly
- Calls `forge.parseWebhookEvent()` instead of `parseWebhookEvent()` with GitHub headers
- Repo allowlist uses `config.repos` instead of `config.githubRepos`

**Bootstrap module** (`lib/bootstrap.ts`):

New module that handles all first-run auto-provisioning. Extracted from `server.ts` for testability — each side effect (filesystem, network, MCP) is injectable.

```typescript
export interface BootstrapDeps {
  readEnvFile(path: string): string | null;       // read existing .env
  writeEnvFile(path: string, content: string): void;  // write/append .env
  fetchSmeeChannel(): Promise<string | null>;     // GET smee.io/new
  createSmeeClient(source: string, target: string): void;  // start relay
  pushNotification(content: string, meta: Record<string, string>): Promise<void>;
}

export async function bootstrap(config: Config, deps: BootstrapDeps): Promise<{
  webhookSecret: string;
  smeeUrl: string | null;
}>;
```

Flow:
1. If `config.webhookSecret` is null → generate `crypto.randomBytes(32).toString('hex')`, call `deps.writeEnvFile()` to append `WEBHOOK_SECRET=...` to `~/.claude/channels/ci/.env` (create dir/file if needed via `mkdirSync` + append). Idempotent: checks if `WEBHOOK_SECRET=` line already exists before appending.
2. If `config.smeeUrl` is null → call `deps.fetchSmeeChannel()` to auto-provision. On failure → return null (continue without relay).
3. If smeeUrl available → call `deps.createSmeeClient(smeeUrl, target)` wrapped in try/catch for graceful degradation if SmeeClient crashes in-process.
4. If any auto-provisioning happened → call `deps.pushNotification()` with setup instructions.
5. Return resolved secret and smeeUrl.

**Server changes** (`server.ts`):
- Import forge implementations, select based on `config.forge`
- Listen on port 0 by default
- Both `POST /webhook` and `POST /webhook/github` hit the same handler
- For `--forge github`, the smee relay target uses `/webhook/github` to preserve backward compatibility with existing webhook senders. For other forges, use `/webhook`.
- Remove `EADDRINUSE` special handling (port 0 doesn't conflict)
- After `listen` callback fires:
  1. Call `bootstrap(config, realDeps)` with real implementations
  2. Start smee-client in-process via `new SmeeClient({source, target})` (through bootstrap deps)
  3. Push setup notification if auto-provisioned
- Add `smee-client` to `package.json` dependencies
- SmeeClient instantiation wrapped in try/catch — runtime errors in smee don't crash the server

**Reconciliation refactor** (`lib/reconcile.ts`):
- `runStartupReconciliation(mcp, config, forge)` — generic loop over branches
- Calls `forge.runReconciliation(config, branch, timeoutMs)` per branch
- `fetchFailedJobs()` becomes `forge.fetchFailedJobs(config, repo, runId)`
- `runCommand()` helper stays in reconcile.ts (shared utility for CLI-based forges)

#### Acceptance Criteria
- [ ] All 83 existing tests pass (with expected assertion updates for intentional changes: port default 0, `config.repos` field name, `webhookSecret` nullable). Behavioral parity preserved — same webhook pipeline, same notifications.
- [ ] `--forge github` produces identical behavior to no `--forge` arg
- [ ] `--repos` CLI arg works; `GITHUB_REPOS` env var still works as fallback
- [ ] `--port 0` assigns random port; smee uses actual port
- [ ] Auto-generates `WEBHOOK_SECRET` when not set, writes to `~/.claude/channels/ci/.env`
- [ ] Auto-provisions smee channel when `--smee-url` not set
- [ ] Pushes setup instructions via channel notification
- [ ] Both `/webhook` and `/webhook/github` routes work
- [ ] For `--forge github`, smee relay targets `/webhook/github` (backward compat)
- [ ] Invalid `--forge bitbucket` fails fast at startup
- [ ] Unknown `--badarg` fails fast at startup
- [ ] Config precedence: CLI args > env vars > .env

#### Test Plan
- **Unit Tests**: CLI arg parsing (all flags), config precedence, forge selection, port 0 behavior
- **Unit Tests (bootstrap)**: Secret generation with injected deps, .env write (mocked fs), smee provisioning (mocked fetch), setup notification (mocked MCP), SmeeClient crash graceful degradation, idempotent .env append
- **Integration Tests**: Full webhook pipeline through forge abstraction (GitHub forge)
- **Regression**: All 83 existing tests pass (with assertion updates for config shape changes documented above)

#### Rollback Strategy
Git revert the phase commit. **External state**: auto-generated `.env` file and smee channel are not reverted by git — manual cleanup may be needed. The `.env` write is idempotent (won't duplicate on re-run).

---

### Phase 2: GitLab forge implementation
**Dependencies**: Phase 1

#### Objectives
- Implement `GitLabForge` supporting Pipeline Hook webhooks
- Token-based signature validation (timing-safe)
- Pipeline payload parsing into `WebhookEvent`
- glab CLI-based reconciliation and job enrichment
- Full test coverage

#### Deliverables
- [ ] `lib/forges/gitlab.ts` — GitLabForge implementation
- [ ] `tests/forges/gitlab.test.ts` — Unit tests for GitLab forge
- [ ] `tests/fixtures/gitlab-pipeline-failure.json` — Realistic GitLab webhook payload
- [ ] `tests/integration-gitlab.test.ts` — Integration test for GitLab webhook pipeline

#### Implementation Details

**Signature validation**:
- Read `X-Gitlab-Token` header
- Compare with `config.webhookSecret` using `crypto.timingSafeEqual` on UTF-8 buffers
- Length mismatch → immediate `false`
- Missing header → `false`

**Event parsing**:
- Read `X-Gitlab-Event` header; only `Pipeline Hook` is relevant
- Terminal states: `success`, `failed`, `canceled`, `skipped` — others are irrelevant
- Synthetic delivery ID: `gitlab-{project.id}-{object_attributes.id}-{object_attributes.status}`
- Map fields per spec's WebhookEvent Field Mapping table
- `runUrl` constructed from project web_url + `/-/pipelines/{id}`
- `workflowName` from `object_attributes.name` (pipeline name) or `"pipeline"` fallback. **Note**: spec's field mapping table says `detailed_status`, but that's a status string (e.g., "failed"), not a name. `object_attributes.name` is the correct field for pipeline name. This is an intentional deviation from the spec table — the spec table entry is inaccurate.

**Reconciliation**:
- `glab ci list --branch {b} --per-page 1 --output json`
- Parse JSON, filter for `status === "failure"`
- Map to `WebhookEvent`
- Uses `runCommand()` from reconcile.ts

**Job enrichment**:
- `glab api /projects/{url_encoded_path}/pipelines/{id}/jobs --per-page 100`
- Filter for jobs with `status === "failed"`
- Return job names

#### Acceptance Criteria
- [ ] GitLab webhook with valid token → notification pushed
- [ ] GitLab webhook with invalid/missing token → 403
- [ ] Non-terminal pipeline states → silently dropped
- [ ] Non-pipeline events → silently dropped
- [ ] Synthetic dedup key includes status (different states not suppressed)
- [ ] Nested namespace repos work in allowlist (`group/subgroup/project`)
- [ ] glab missing → reconciliation skipped with warning

#### Test Plan
- **Unit Tests**: Token validation (valid, invalid, length mismatch, missing), event parsing (all terminal states, non-terminal, non-pipeline), dedup key generation
- **Integration Tests**: Full HTTP pipeline with GitLab headers and payload
- **Fixtures**: Based on GitLab Pipeline Hook documentation

#### Rollback Strategy
Delete `lib/forges/gitlab.ts` and test files. Also revert the forge registry entry (import/map in the module that maps `"gitlab"` → `GitLabForge`).

---

### Phase 3: Gitea forge implementation
**Dependencies**: Phase 1

#### Objectives
- Implement `GiteaForge` supporting workflow_run webhooks
- HMAC-SHA256 signature validation (raw hex, no prefix)
- Workflow_run payload parsing (GitHub-like structure)
- fetch-based API reconciliation and job enrichment
- Full test coverage

#### Deliverables
- [ ] `lib/forges/gitea.ts` — GiteaForge implementation
- [ ] `tests/forges/gitea.test.ts` — Unit tests for Gitea forge
- [ ] `tests/fixtures/gitea-workflow-run-failure.json` — Realistic Gitea webhook payload
- [ ] `tests/integration-gitea.test.ts` — Integration test for Gitea webhook pipeline

#### Implementation Details

**Signature validation**:
- Read `X-Gitea-Signature` header (raw hex, no `sha256=` prefix)
- HMAC-SHA256 with timing-safe comparison (same algorithm as GitHub, just no prefix)
- Missing header → `false`

**Event parsing**:
- Read `X-Gitea-Event` header; only `workflow_run` is relevant
- Read `X-Gitea-Delivery` header for dedup
- Payload structure mirrors GitHub's `workflow_run` — reuse similar parsing logic
- `action === "completed"` filter (same as GitHub)

**Reconciliation** (API-based):
- Requires `config.giteaUrl` (from `--gitea-url` arg)
- `GET {giteaUrl}/api/v1/repos/{owner}/{repo}/actions/runs?branch={b}&limit=1`
- Optional `GITEA_TOKEN` for auth via `Authorization: token {token}` header
- Uses Node's built-in `fetch` with timeout via `AbortController`
- If `--gitea-url` not configured → skip with warning

**Job enrichment** (API-based):
- `GET {giteaUrl}/api/v1/repos/{owner}/{repo}/actions/runs/{id}/jobs`
- Filter for `conclusion === "failure"`
- Same auth and timeout as reconciliation

#### Acceptance Criteria
- [ ] Gitea webhook with valid HMAC → notification pushed
- [ ] Gitea webhook with invalid/missing signature → 403
- [ ] `action !== "completed"` → silently dropped
- [ ] API-based reconciliation works with mock HTTP
- [ ] `--gitea-url` missing → reconciliation skipped with warning
- [ ] `GITEA_TOKEN` used in API requests when set

#### Test Plan
- **Unit Tests**: HMAC validation (valid, invalid, missing), event parsing, API reconciliation/enrichment (mocked fetch)
- **Integration Tests**: Full HTTP pipeline with Gitea headers and payload
- **Fixtures**: Based on Gitea webhook documentation

#### Rollback Strategy
Delete `lib/forges/gitea.ts` and test files. Also revert the forge registry entry.

---

### Phase 4: Documentation updates
**Dependencies**: Phases 1-3

#### Objectives
- Update all documentation to reflect multi-forge support
- Update .mcp.json examples for each forge
- Update architecture document

#### Deliverables
- [ ] `README.md` — Multi-forge setup instructions with per-forge guides, configuration reference, examples per forge
- [ ] `codev/resources/arch.md` — Updated architecture reflecting forge abstraction, new directory structure, updated data flow diagrams
- [ ] `CLAUDE.md` — Updated key components, configuration, and development instructions
- [ ] `.mcp.json` — Updated default example
- [ ] E2E validation on cluesmith/ci-channel repo

#### Acceptance Criteria
- [ ] README covers setup for all three forges with copy-pasteable .mcp.json examples
- [ ] README includes per-forge webhook configuration steps (GitHub Settings, GitLab Settings, Gitea Settings)
- [ ] README documents zero-config setup flow (auto-generated secret + auto-provisioned smee)
- [ ] README documents `npx smee-client --new` for persistent channels
- [ ] arch.md reflects the forge abstraction layer and new file structure
- [ ] CLAUDE.md reflects new config model and key components
- [ ] All existing documentation references updated (no stale GitHub-only language)
- [ ] Plugin configured on cluesmith/ci-channel — real GitHub Actions failure triggers notification

#### Test Plan
- **Manual Testing**: Review documentation for accuracy and completeness
- **E2E**: Configure plugin on cluesmith/ci-channel, trigger a real GitHub Actions workflow, verify notification received

#### Rollback Strategy
Git revert the documentation commit.

## Dependency Map
```
Phase 1 (Foundation) ──→ Phase 2 (GitLab)
                    └──→ Phase 3 (Gitea)
                    └──→ Phase 4 (Docs) [after 2+3]
```

Phases 2 and 3 are independent of each other (both depend only on Phase 1).

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Refactoring breaks existing tests | Low | High | Run full test suite after each change in Phase 1 |
| GitLab payload differs from docs | Medium | Medium | Use documented payload schema; degrade gracefully for optional fields |
| Gitea API not available/different | Medium | Low | Best-effort; skip with warning if unavailable |
| Port 0 breaks existing test infrastructure | Low | Medium | Tests can use explicit port override |
| smee-client in-process crash propagates | Low | Medium | Wrap SmeeClient in try/catch; graceful degradation (relay stops, server continues) |
| Auto-generated .env file write fails (permissions) | Low | Low | Log warning, continue without persisted secret (user must configure manually) |

## Expert Review

**Date**: 2026-04-05
**Models Consulted**: Codex (GPT-5), Claude
**Gemini**: Skipped (API key not configured)

**Codex verdict**: REQUEST_CHANGES (HIGH confidence)
**Claude verdict**: COMMENT (HIGH confidence)

**Key feedback addressed**:
- Removed impossible "no assertion changes" regression criterion; explicitly listed expected test updates (port default, field names)
- Added `lib/bootstrap.ts` module with injectable deps for testable auto-provisioning
- Fixed rollback strategy: acknowledged external state (`.env` file, smee channel)
- Specified GitHub route backward compat in smee relay targeting
- Enumerated all CLI args in Phase 1 config details (was missing `--workflow-filter`, `--reconcile-branches`, `--gitea-url`, `--smee-url`)
- Clarified `ParseResult` and `Headers` types in Forge interface (reuse existing types)
- Acknowledged GitLab `workflowName` field mapping deviation from spec (intentional: `name` > `detailed_status`)
- Added smee-client crash isolation strategy (try/catch, graceful degradation)
- Added bootstrap test plan with mocking strategy (injected deps, no real fs/network)
- Documented `WEBHOOK_SECRET` fail-fast removal from `loadConfig()` and new bootstrap flow

## Validation Checkpoints
1. **After Phase 1**: All 83 existing tests pass. `/webhook` and `/webhook/github` both work. Port 0 assigns correctly. CLI arg parsing works.
2. **After Phase 2**: GitLab webhook pipeline works end-to-end in tests.
3. **After Phase 3**: Gitea webhook pipeline works end-to-end in tests.
4. **After Phase 4**: All docs accurate. `npm test` passes with full coverage.
