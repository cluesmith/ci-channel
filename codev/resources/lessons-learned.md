# Lessons Learned

> Extracted from `codev/reviews/`. Last updated: 2026-04-04

## Testing

### Use temp directories for config tests
Config loading tests must not read from or write to real user directories (e.g., `~/.claude`). Use a temp directory for the env file and pass the path to `loadConfig(envFilePath)`. Discovered when tests were polluting real config during Phase 1. *(Spec 1)*

### Write tests alongside each phase, not deferred
Writing tests in the same phase as the implementation makes review feedback easier to address. When tests are deferred to a final phase, fixing issues requires re-reading code written earlier. *(Spec 1)*

### Extract handler functions for HTTP-level integration testing
`createWebhookHandler()` was extracted into `lib/handler.ts` (instead of inlining in `server.ts`) to enable true end-to-end integration tests with real HTTP requests. The pattern: handler function takes config + MCP mock, returns a request handler that can be mounted on a test server. *(Spec 1, Phase 4)*

### Use strict number parsing for port validation
`parseInt("8789abc")` returns `8789` — accepting trailing junk. Use `Number("8789abc")` which returns `NaN`, then validate with `Number.isInteger()`. This caught a real config validation gap. *(Spec 1, Phase 1)*

## Architecture

### MCP stdio pollution from child processes
Any stdout from child processes (smee-client, gh CLI) corrupts the MCP JSON-RPC stream. **All subprocess calls must use `stdin: 'ignore'`** to prevent the child from inheriting and consuming MCP stdin bytes. Use `stdout: 'pipe'` or `'ignore'` and `stderr: 'ignore'` as well. This is the single most critical architectural constraint for MCP server plugins that spawn subprocesses. *(Spec 1, Phase 3)*

### Delay startup reconciliation until after MCP handshake
Writing to stdout before the MCP `initialize` handshake completes corrupts the JSON-RPC stream. The plugin uses `setTimeout(5000)` to delay startup reconciliation. This ensures notifications are only sent after the transport is fully established. *(Spec 1)*

### Never block notifications on enrichment
The base CI failure notification must be pushed immediately (< 100ms). Job-detail enrichment via `gh api` is fire-and-forget — runs after the response is sent, pushes a follow-up notification if jobs are found, errors are swallowed silently. This ensures the latency goal is always met regardless of GitHub API availability. *(Spec 1, Phase 3)*

### Shared timeout budget for multi-branch reconciliation
Per-branch timeouts don't account for cumulative time. A shared 10s budget across all branch checks prevents the total reconciliation from exceeding expectations when many branches are configured. Track elapsed time and break early when budget is exhausted. *(Spec 1, Phase 3)*

### Extract testable functions from inline checks
Allowlist and filter checks were initially inline `if` statements. Extracting `isRepoAllowed()` and `isWorkflowAllowed()` into named functions enabled targeted unit tests and made the handler pipeline clearer. *(Spec 1, Phase 2)*

## Process

### 3-way consultation catches real issues
Using Gemini, Codex, and Claude to review specs, plans, and implementations caught distinct issues at every phase. Each reviewer had different blind spots — Codex was particularly strong on edge cases (EADDRINUSE, timeout semantics, missing fields), while Gemini caught architectural concerns (auth strategy, lifecycle management). *(Spec 1)*

### Deferred migration reduces risk
Removing existing CI monitoring hooks was intentionally deferred to a separate PR after the channel plugin was validated in production use. This avoids removing working monitoring before the replacement is proven. *(Spec 1, Phase 4)*

## Tooling

### EADDRINUSE handling varies by HTTP server
Node's `http.createServer()` emits an `'error'` event on the server object for startup errors like EADDRINUSE. This requires explicit handling — the default behavior is an uncaught exception. All three consultation reviewers caught the need for this during the original implementation. *(Spec 1, Phase 1)*

### smee-client via npx for zero-install proxying
Using `npx smee-client` auto-installs on first run, avoiding a hard dependency. The plugin spawns it as a child process with all stdio ignored, and kills it on process exit, SIGINT, SIGTERM, and stdin close. *(Spec 1, Phase 3)*

## Integration

### GitHub webhook signature validation with timing-safe comparison
Use `crypto.timingSafeEqual` for HMAC comparison. Both buffers must be the same length — compare hex digests as `Buffer.from(hex, 'hex')`. If lengths differ (malformed signature), reject immediately before calling `timingSafeEqual`. *(Spec 1, Phase 2)*

### workflow_run.head_commit is not guaranteed
GitHub's `workflow_run` webhook event does not always include `head_commit`. Use optional chaining (`run.head_commit?.message`) and degrade gracefully — show commit SHA when message is unavailable. *(Spec 1, Phase 2)*

### Deduplication with bounded memory
GitHub occasionally retries webhook delivery. Track `X-GitHub-Delivery` header values in a `Set` with FIFO eviction at 100 entries. `Set` preserves insertion order, so `set.keys().next().value` gives the oldest entry for eviction. *(Spec 1, Phase 2)*

### Meta key naming in MCP channels
Per the Claude Code channels reference, meta keys must be identifiers (letters, digits, underscores only). Keys with hyphens are silently dropped. Use `run_url` not `run-url`, `commit_sha` not `commit-sha`. *(Spec 1, Phase 2)*

---

*Generated by MAINTAIN protocol from review documents.*
*To add lessons: document them in review files, then run MAINTAIN.*
