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

## Multi-Forge Support (Spec 1)

### Strategy Pattern for multi-variant webhook handling
When the same pipeline must handle webhooks from different sources with different signatures, payload structures, and CLI tools, the Strategy Pattern (shared interface + per-source implementation) keeps the pipeline clean. The handler never knows which forge it's talking to — it calls `forge.validateSignature()` and `forge.parseWebhookEvent()` generically. *(Spec 1)*

### Injectable deps for testable auto-provisioning
Side-effect-heavy startup code (filesystem writes, network calls, MCP notifications) should use injectable dependencies from the start. The `BootstrapDeps` pattern enables testing with mocked fs/network/MCP without touching real state. Don't defer this — adding it during review costs more than designing it upfront. *(Spec 1, Phase 1)*

### CLI arg parsing is structural config, env vars are secrets
Separating structural config (forge, repos, filters) into CLI args in `.mcp.json` and secrets into `.env` gives users a single-file view of their full config alongside the MCP server registration. Precedence: CLI args > env vars > .env file. *(Spec 1)*

### Port 0 eliminates EADDRINUSE for MCP plugins
MCP channel plugins that run HTTP servers should default to port 0 (OS-assigned) since multiple Claude Code sessions may run concurrently. This removes the need for EADDRINUSE error handling for the default case. *(Spec 1)*

### GitLab synthetic dedup keys must include state
GitLab doesn't provide a delivery ID header. A synthetic key using only `project_id + pipeline_id` would suppress legitimate state transitions (running → failed). Include the status in the key: `gitlab-{project_id}-{pipeline_id}-{status}`. *(Spec 1, Phase 2)*

### smee-client in-process via Node.js API
Using smee-client's Node.js API (`new SmeeClient({source, target})`) in-process eliminates subprocess management and MCP stdio isolation concerns. The relay startup is async (dynamic import) but this is harmless — a few ms delay before the relay is active doesn't affect webhook delivery. *(Spec 1)*

### Never use process.stdin events in MCP stdio servers
In MCP stdio mode, `process.stdin` is owned by `StdioServerTransport`. Attaching `process.stdin.on("close", ...)` handlers will fire prematurely when the transport manages the stream, killing any long-lived connections (like smee-client's EventSource) started in-process. Use only `process.on("exit")`, `SIGINT`, and `SIGTERM` for cleanup. *(Self-hosting, 2026-04-09)*

### Each installation needs a dedicated smee channel
Sharing a smee.io URL across multiple projects causes cross-talk — all webhook events from all projects arrive at the same endpoint. Each ci-channel installation should provision its own smee channel. The auto-provisioning in bootstrap handles this, but pre-existing `.env` files with shared URLs will bypass it. *(Self-hosting, 2026-04-09)*

### Test the full pipeline end-to-end, not just unit tests
Unit tests passed for months while the actual webhook → smee → local server → channel notification pipeline was broken in production (smee-client dying on startup). A manual integration test — triggering a real webhook and verifying the notification arrives — would have caught this immediately. *(Self-hosting, 2026-04-09)*

## Process

### Prefer single-file implementations + real-fs tests for install/bootstrap commands
For commands that run once per project (installers, bootstrappers, scaffolders), prefer a flat single-file implementation with real-filesystem integration tests over dependency-injected orchestrators. The cost of DI abstraction outweighs the testability benefit when the logic is mostly "call this API with this payload, write this file, merge this JSON".

Spec 3's `ci-channel setup` installer grew to 4,385 lines (1,450 impl + 2,935 test) across 19 files for a feature that does 5 operations: generate secret, fetch smee URL, write state, create webhook, merge .mcp.json. A ~150-line single-file implementation with temp-dir integration tests would have covered the same behavior.

Contributors to the bloat:
- DI interface (`InstallDeps` with 12 members + `Io` with 4) forced every edge case into a mocked unit test
- 7-shape `.mcp.json` defensive matrix for a user-editable JSON file that's almost always valid
- `gh api --paginate` custom fallback parser for `gh < 2.29` when the project already requires modern `gh`
- 4 separate confirm prompts (provision → state → webhook → mcp-json) when one "install ci-channel for X into Y?" at the top matches user mental model
- 6 iterations of bug fixes in the webhook "skip if already correct" fast path that was a premature optimization on a once-per-project command

The iter5 structural fix — removing the skip path and always PATCH-ing — proved the optimization was never worth the correctness cost. **Rule of thumb: if a code area keeps producing edge cases across review iterations, simplify the abstraction rather than patching the edge cases.** *(Spec 3, iter5)*

---

*Generated by MAINTAIN protocol from review documents.*
*To add lessons: document them in review files, then run MAINTAIN.*
