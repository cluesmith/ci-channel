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

### Tight specs pay for themselves — Spec 3 → Spec 5 rebuild
Spec 5 was a rebuild of the same feature (`ci-channel setup`) under a spec that enumerated **hard caps** instead of "guidelines": single-file implementation ≤150 lines, single-file tests ≤200 lines, ≤8 tests, no DI, no new dependencies, no interactive prompts, no helper modules, no multi-shape defensive parsing, no "skip if already correct" fast path. The final implementation came in at 120 lines (20% under cap) and shipped in **2 iterations** (spec-consult → impl-consult → tests-consult, all REQUEST_CHANGES items were gap-fills not rework).

Things the tight spec prevented by construction:
- **The deepEqual helper** — Claude's iter1 plan review said "sketch shows `deepEqual(existing, desired)` while prose says 'direct compare'"; the fix was to inline the three-condition boolean in the sketch. Without the ≤150-line cap, a helper would have been the "cleaner" choice and eaten budget.
- **The `ci` truthiness check** — Codex's iter1 impl review caught `if (!mcp.mcpServers?.ci)` as too-truthy (`ci: null` is a valid user customization). The fix was `if (!('ci' in servers))`. Without an explicit "key presence, not truthiness" rule in the spec, both checks would have seemed equivalent.
- **`fetchSmeeChannel` real network in tests** — iter1 reviews all flagged that "mock only `spawn`" was unworkable because `fetchSmeeChannel` uses `fetch`. The architect's resolution: drop the `globalThis.fetch` stub and **prepopulate state.json** in every test so the fetch path is never entered. `fetchSmeeChannel` is already covered by `tests/bootstrap.test.ts`.

**The rule**: spec constraints should be written as **maxima, not minima**. "At most N lines / at most M files / at most K tests" is enforceable; "keep it simple" is not. Plan and review gates must mechanically check the caps (`wc -l`, `grep -c`, `ls`). Violations are automatic REQUEST_CHANGES, not style suggestions. *(Spec 5)*

### Never override `process.stdout.write` during node:test execution
When writing tests that need to capture setup-under-test output AND call `process.exit` from inside the setup, it's tempting to override `process.stdout.write` alongside `process.stderr.write` and `process.exit`. **Don't**. node:test emits its own TAP events (`ok N - testname`, subtest headers) to `process.stdout` DURING test execution, not just at test boundaries. An override that runs across an `await` will swallow those emissions into the test's local buffer, and the results vanish from the reporter.

Symptom: node:test reports `1..8` in its plan line but only shows the subset of tests whose `process.stdout.write` override was NOT active when their result line was emitted. Tests that override stdout appear to not exist. No error is raised — the tests simply don't show up.

Fix: capture `process.stderr.write` and `process.exit` but leave `process.stdout.write` alone. Setup code's success message ("Done. Launch Claude Code...") will leak into the test runner's output, but this is cosmetic — node:test still sees all the structured result events correctly. *(Spec 5, tests iter1)*

### Natural-seam phase split for constrained single-PR specs
Porch's state machine requires a minimum of two machine-tracked phases. A spec that says "one commit, one PR, not phased" is forbidding artificial slicing of a single implementation into 4 mini-phases of 37 lines each — it is NOT requiring literal single-git-commit delivery. The **single natural seam** for any implementation that ships with tests is: Phase 1 = implementation, Phase 2 = tests. Each is a single file, a single atomic unit of work, and a single commit. Both commits land in one PR. Squash-merge at merge time if the reviewer prefers a single final commit.

Avoid inventing additional seams (e.g., "Phase 1 = parseArgs, Phase 2 = fs operations, Phase 3 = gh calls, Phase 4 = mcp merge") — this is exactly what the "not phased" rule forbids. Stick to impl-vs-tests. *(Spec 5, plan iter1)*

### Always assert `exitCode === null` on success paths when `process.exit` is intercepted
When a test helper intercepts `process.exit(1)` by throwing a sentinel and catching it, the test code CAN keep running after a "successful" setup call that actually failed through the failure path — as long as whatever assertions come next happen to also pass on the partial state. Unless every success-path test explicitly asserts `res.exitCode === null`, a silent failure-path exit can slip through.

Example: Scenario 2 of the Spec 5 installer tests is "idempotent re-run: PATCH exactly once." Without the exit assertion, a test where `setup()` hits the list call, then fails in .mcp.json merge, then exits 1 would still satisfy the `PATCH called` assertion (because the PATCH happened before the exit) and would look like a pass. The fix is trivial — one line per test — but the cost of omitting it is non-obvious. *(Spec 5, tests iter1, caught by Codex)*

### Inline small helpers when the single file has a hard line cap
For cap-sensitive single-file implementations, a helper called from exactly one place and under ~30 lines should be inlined into its call site. Spec 8's iter1 plan proposed a top-level `codevRevert` helper (~25 lines) mirroring the existing `codevIntegrate`. Inlining it into `remove()` saved ~7 lines (function signature, closing brace, call-site, `return` statements), which was load-bearing for landing under the 400-line cap (final landing: 396). The local `try/catch` pattern is preserved — inlining doesn't mean losing error-containment semantics, it just means losing the function boilerplate. Rule: for `≤30` line single-call-site helpers under a hard cap, inline; above 30 or 2+ call sites, extract. *(Spec 8, impl iter1)*

### Plan phase must count line budgets from the actual current baseline, not hypothetical worst case
Spec 8's iter1 plan claimed "parseCommandArgs merge saves 18 lines" but the savings were counted against a hypothetical duplicated `parseRemoveArgs` that never existed in the codebase. The real savings vs. the actual current `parseArgs` was ~2 lines (just adding a `command` parameter). Claude's iter1 plan review caught this and rewrote the budget math honestly. Final landing was ~22 lines over the plan's iter1 projection — exactly the amount the hypothetical-duplicate framing had hidden.

Plan-phase budget math must always count from `wc -l` of the current file, not from imaginary duplicated code that "would have existed" under a naive implementation. The rule: open the file, count sections, add the diff from the sketch. Don't compare against a straw-man bloated version. *(Spec 8, plan iter1, caught by Claude)*

### Plan-phase 3-way review catches factual errors about existing code
Spec 8's iter1 plan described `runSetup` as "spawning `dist/server.js` with `remove` as the first arg" — but the actual `runSetup` helper (tests/setup.test.ts:8 + 64–76) imports `setup` from `../lib/setup.js` at the top of the file and invokes it in-process, stubbing `process.exit` and capturing `process.stderr.write`. It doesn't spawn anything. Similarly, the plan called for extending `mkFakeCli` with "a DELETE branch" — but the fake CLI (tests/setup.test.ts:19–36) is counter-based, returning `responses[i]` for the `i`th call regardless of HTTP method. It has no method dispatch to extend.

Both Codex and Claude independently flagged both errors in their iter1 plan reviews. Without the plan-phase 3-way review, Phase 2 would have started with a broken `runRemove` helper (requiring a build step the test runner doesn't do) and an unnecessary `mkFakeCli` edit that would have broken all existing tests. The plan-phase review pays for itself whenever the plan makes factual claims about existing code the builder hasn't verified. Verify against actual source before committing to a plan. *(Spec 8, plan iter1, caught by Codex + Claude)*

### Behavior-change specs must trace the default through every existing test that asserts the old behavior
Spec 13 was a one-line intent change ("default to failures only"), but implementing it naively broke two existing integration tests that explicitly asserted the pre-filter behavior (`success event → notification`, `running pipeline → notification`). The iter1 plan said "existing tests continue to pass as a regression guard" without examining whether those tests would still be satisfiable under the new default. Codex and Claude both caught this in the plan review: the regression guard was structurally invalid until the plan was expanded to include mechanical test-fixture updates in Phase 1 (integration `testConfig` set to `conclusions: ['all']` to preserve intent).

The lesson generalizes: whenever a spec changes a **default**, the plan must enumerate every existing test that asserts the old default. Grep for values the new default would exclude (`success`, `running`, etc.), and decide per-test whether to (a) preserve old behavior via an explicit override or (b) rewrite the assertion to the new default. Treat "existing tests pass" as a *claim* that needs evidence, not an assumption. *(Spec 13, plan iter1, caught by Codex + Claude)*

### Exclusion-list semantics resolve the "failures only vs. unknowns forwarded" contradiction cleanly
Spec 13 iter1 had a logical inconsistency: "default forwards only failures" plus "unknown conclusions are forwarded (fail-open)." With the existing parsers coercing in-progress events to strings like `requested`, `in_progress`, `running`, the naive fail-open default would leak every non-terminal event through the filter — exactly what the spec aimed to prevent. Codex flagged this as REQUEST_CHANGES in the spec review.

The resolution was a semantic inversion: make the **default** an explicit exclusion list (drop `success`, `skipped`, and the named in-progress set) and forward everything else, including unknown strings. This satisfies both intents: known non-failures are dropped, truly novel forge outcomes aren't silently lost. The **explicit** list is still inclusion-based, since a user who passes `--conclusions failure` has opted into scoped output and wants unknowns dropped.

The broader pattern: when a filter has competing intents (strictness vs. forward-compatibility), check whether switching the default mode from inclusion to exclusion resolves the contradiction. Fail-open-on-unknown *and* strict-by-default can coexist if the default is "drop these explicitly" rather than "keep these explicitly." *(Spec 13, spec iter1, caught by Codex)*

---

*Generated by MAINTAIN protocol from review documents.*
*To add lessons: document them in review files, then run MAINTAIN.*
