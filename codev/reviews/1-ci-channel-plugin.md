# Review: CI Channel Plugin

## Summary

Implemented a one-way Claude Code channel plugin that receives GitHub Actions webhook events via a local HTTP server and pushes CI notification into the running Claude Code session. Uses smee.io as a webhook forwarding proxy, HMAC-SHA256 signature validation, and includes startup reconciliation for offline failures.

## Spec Compliance

- [x] Channel plugin receives GitHub webhook events and pushes CI notifications into Claude session within 5 seconds
- [x] Notification includes: workflow name, branch, commit message (when available), commit author (when available), run URL
- [x] Failed job names included as best-effort async enrichment via gh API
- [x] GitHub webhook signature validation (HMAC-SHA256) prevents unauthorized event injection
- [x] Repository allowlisting validates `repository.full_name` from signed payload
- [x] Only `workflow_run.completed` events generate notifications
- [x] On startup, plugin runs one-shot `gh run list` check for offline failures
- [x] Documentation covers full setup flow

## Deviations from Plan

- **Phase 1**: Added `loadConfig(envFilePath?)` parameter for test safety — avoid writing to real `~/.claude` in tests
- **Phase 2**: Extracted `isRepoAllowed()` and `isWorkflowAllowed()` into testable functions
- **Phase 2**: JSON is parsed before checking event type, so malformed non-workflow_run events return 400 (stricter error handling)
- **Phase 3**: Reconciliation uses shared 10s total budget instead of per-branch timeout (correct timeout semantics)
- **Phase 4**: Extracted `createWebhookHandler()` into `lib/handler.ts` for true end-to-end HTTP testing

## Lessons Learned

### What Went Well
- 3-way consultation (Gemini, Codex, Claude) caught real issues at every phase — EADDRINUSE handling, meta sanitization, JSON parsing order, timeout semantics
- Writing tests alongside each phase (instead of deferring) made review feedback easier to address
- The Claude Code channels reference documentation was thorough enough to implement from

### Challenges Encountered
- **Bun.serve() EADDRINUSE**: The `error` callback only handles per-request errors. All three reviewers caught this independently. Fix: try/catch around server startup.
- **workflow_run.head_commit availability**: Not guaranteed on all events. Fix: optional chaining with graceful degradation.
- **MCP stdio pollution**: Any stdout from child processes (smee-client, gh CLI) corrupts the MCP JSON-RPC stream. Fix: `stdin: 'ignore', stdout: 'pipe'/'ignore', stderr: 'ignore'` for all subprocesses.

### What Would Be Done Differently
- Would have extracted `createWebhookHandler()` from the start instead of having server.ts own the handler directly. This pattern enables testing at the HTTP boundary without needing to import the full server.
- Would have used a temp directory for config tests from the start.

## Technical Debt
- `runStartupReconciliation` is not directly unit-tested (requires mocking subprocess spawning). Tested indirectly via `fetchFailedJobs` and notification formatting tests.
- smee-client lifecycle management is verified via manual testing only.
- The plugin requires `--dangerously-load-development-channels` during the channels research preview.

## Consultation Feedback

### Specification Phase

#### Gemini (COMMENT)
- Missing auth strategy for GitHub API enrichment → Use `gh` CLI (existing auth)
- Configuration management needs concrete definition → Added full env var table
- smee.io lifecycle should be managed by plugin → Plugin spawns smee-client as child process

#### Codex (REQUEST_CHANGES)
- Sender IP allowlist unworkable with smee.io → Replaced with repo allowlist from signed payload
- "No API calls" contradicts job enrichment → Explicit auth via gh CLI, enrichment is best-effort
- Offline gap when removing existing hooks → Added startup reconciliation

#### Claude (COMMENT)
- Sender allowlist is security theater in localhost architecture → Replaced with repo allowlist
- Missing port configuration → PORT env var with default 8789
- Document offline behavior → Explicit documentation in spec

### Plan Phase

#### Codex (REQUEST_CHANGES)
- Enrichment blocks notification, violates latency goal → Enrichment is async fire-and-forget
- Malformed JSON should return 400, not 200 → Parse JSON before checking event type
- head_commit fields may be absent → Optional chaining with graceful degradation
- Startup reconciliation hard-coded to ci/develop → RECONCILE_BRANCHES env var

### Phase 1 Implementation

All three (REQUEST_CHANGES):
- EADDRINUSE in wrong callback → try/catch around server startup
- Config tests write to real ~/.claude → Use temp directory
- PORT accepts trailing junk via parseInt → Use Number() for strict validation

### Phase 2 Implementation

Codex (REQUEST_CHANGES):
- Meta values unsanitized → Sanitize workflow/branch meta values
- Non-workflow_run malformed JSON returns 200 → Parse JSON before checking event type
- No allowlist/filter tests → Extracted and tested isRepoAllowed/isWorkflowAllowed

### Phase 3 Implementation

Codex (REQUEST_CHANGES):
- Reconciliation timeout is per-branch, not total → Shared 10s total budget
- gh failures are silent → console.error warnings

### Phase 4 Implementation

Gemini + Codex (REQUEST_CHANGES):
- Integration test doesn't hit HTTP handler → Rewrote with real HTTP server + fetch() + mock MCP
- README says "silently skipped" but code logs → Fixed README to match behavior

## Test Results

83 tests across 6 files, all passing:
- `tests/webhook.test.ts` — Signature validation, event parsing, deduplication, filtering
- `tests/notify.test.ts` — Sanitization, formatting
- `tests/config.test.ts` — Config loading from env files and variables
- `tests/reconcile.test.ts` — Job fetching, reconciliation formatting
- `tests/integration.test.ts` — Full HTTP pipeline end-to-end
- `tests/stdio-lifecycle.test.ts` — MCP stdio stability regression test

## Follow-up Items
- Submit plugin to marketplace when channels exit research preview
- Consider adding workflow filter to startup reconciliation
