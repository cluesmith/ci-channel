# Lessons Learned

> Extracted from `codev/reviews/`. Last updated: 2026-04-10

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
Any stdout from child processes (smee-client, gh CLI) corrupts the MCP JSON-RPC stream. **The real invariant is: no child process may inherit `process.stdin`** (which would steal bytes from the MCP transport). The simplest way to achieve this for server-path subprocesses is `stdin: 'ignore'`. When a child needs a payload written to its stdin (e.g., `gh api --input -`), use `stdio: ['pipe', 'pipe', 'pipe']` and write to the child's dedicated stdin pipe — this also satisfies the invariant because the pipe is not `process.stdin`. Use `stdout: 'pipe'` or `'ignore'` and `stderr: 'ignore'` as well for server-path subprocesses. *(Spec 1, Phase 3; refined Spec 3, Phase 2)*

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

## Interactive Installer (Spec 3)

### Subcommand dispatch in ESM: place the guard after imports, not before
Static `import` statements in ESM are hoisted and evaluated before any top-level code, regardless of textual placement. Trying to "run the subcommand guard before imports" by putting the `if` block at the top of the file is nonsense — the imports still resolve first. The correct pattern is to place the guard *after* all static imports but *before* any side-effecting top-level code (e.g., `const config = loadConfig()`). ESM also supports top-level `await`, so `await import('./lib/setup/index.js')` inside the guard works. The dynamic import is what prevents installer-only deps (`@inquirer/prompts`) from loading on the server path. *(Spec 3, Phase 1)*

### `writeFileSync({ mode: 0o600 })` only applies on file creation
POSIX file mode passed to `writeFileSync` options is only honored when the file is newly created. If the file already exists (e.g., from a previous run), the existing mode bits are preserved. For secret-containing files this is a correctness bug: a file that was ever written with permissive bits stays permissive forever. The fix is to follow the write with an explicit `chmodSync(path, 0o600)`. This introduces a small TOCTOU window on first-write only, which is acceptable for install-time tools. *(Spec 3, Phase 2)*

### Don't reuse `saveState` from the runtime for installer writes
`lib/state.ts`'s `saveState` swallows write errors with a log warning — correct for best-effort runtime persistence, wrong for an installer where a silent state-write failure followed by successful webhook creation leaves the user with unrecoverable inconsistent state. The installer must have its own write path that propagates errors. Convergent feedback from all three reviewers (Gemini/Codex/Claude) flagged this in the installer_core review — the convergence itself was a strong signal it was a real bug, not a nit. *(Spec 3, Phase 2)*

### `gh api --paginate` output format is unreliable — prefer `--slurp`
Plain `gh api --paginate` may return concatenated JSON documents rather than a single well-formed array, and the exact format varies across `gh` versions. `gh api --paginate --slurp` (available since gh 2.29, 2023-05) wraps all pages in a single top-level JSON array — always parseable with `JSON.parse`. For the ci-channel installer's idempotency check (does a matching webhook already exist?), `--slurp` is the primary path with a documented fallback to page-by-page parsing for pre-2.29 `gh`. *(Spec 3, Phase 2)*

### State-write idempotency: diff-check before writing, not just after dry-run
An idempotent re-run should leave the filesystem untouched when nothing has changed. The installer compares `existingState` (loaded at the start) to `state` (computed after secret/smee resolution) with a small `stateDiffers` helper and skips the write entirely when they match. This is a stricter form of idempotency than "don't overwrite valid state" — it also preserves mtime and avoids unnecessary disk I/O. Integration tests should assert `statSync().mtimeMs` is unchanged on re-runs, not just that the file contents are unchanged. *(Spec 3, Phase 2)*

### Matrix checks that cross multiple axes need explicit per-cell tests
The CLI parser's interactive/non-interactive matrix has 8 cells (TTY × `--yes` × `--repo`-missing). The initial implementation only checked the TTY condition inside the `--repo`-missing branch, leaving the non-TTY + `--repo` + no `--yes` cell reachable — which later failed inside `@inquirer/prompts` with a confusing error. The fix: test every cell explicitly, document the matrix as an ASCII table in the code comment, and structure the checks to mirror the matrix shape. If your parser has N × M × K behavior cells, write N × M × K tests. *(Spec 3, Phase 3)*

### Confirmation prompts via dependency injection + scripted Io
Rather than mocking `@inquirer/prompts` directly, abstract prompts behind an `Io` interface (`confirm`, `prompt`, `info`, `warn`) and provide two implementations: `createAutoYesIo` (for `--yes` and tests) and `createInteractiveIo` (wraps inquirer). Tests use a scripted `Io` that feeds canned answers from a queue. This keeps the tests fast, hermetic, and free of TTY-emulation dependencies. The orchestrator never imports inquirer — it only knows about `Io`. *(Spec 3, Phase 3)*

### `UserDeclinedError extends SetupError` with exitCode 0
A clean user decline ("no, don't create that webhook") is not an error — it's an expected path. Model it as a subclass of your error type with `exitCode = 0` so the `try/catch` pattern in the runner can handle it uniformly with regular errors while still exiting cleanly. The catch branch detects the subclass and prints a "(stopped by user)" suffix to distinguish it from a crash. *(Spec 3, Phase 3)*

### Minimal `.gitignore` matcher is enough for a warning
Full gitignore pattern matching is surprisingly complex (negation, anchored patterns, double-star globs, character classes). For a warning-only feature ("is `.claude/channels/ci/` mentioned in any ancestor `.gitignore`?"), a minimal implementation — walk ancestors, read each `.gitignore`, check for prefix/exact match after stripping leading/trailing slashes — is sufficient. Don't pull in a gitignore-parsing dependency for a warning that doesn't need pattern correctness. *(Spec 3, Phase 2)*

### Dependency-inject `detectProjectRoot` in integration tests instead of mutating `process.cwd()`
Changing `process.cwd()` in a test is unsafe under Node's concurrent test runner and can bleed into unrelated tests. Instead, inject the project root as a dep: `detectProjectRoot: () => tmpDir`. The `.git/` marker in the temp dir can still be created if you want to exercise the real `findProjectRoot` helper in a separate, cwd-independent sub-test. *(Spec 3, Phase 2)*

### URL-match idempotency is not enough — track whether the local secret was freshly generated
A naive "if webhook at our URL already exists, skip create" idempotency check has a silent failure mode: if state.json was deleted but the webhook was left in place, the installer generates a fresh secret, sees the URL match, skips creation — and the webhook keeps signing with the old (now-lost) secret. Every event then fails HMAC validation on the runtime side. Fix: track whether the secret was reused from valid prior state vs. freshly generated in this run, and if the secret is fresh AND a matching URL exists, PATCH the hook to rotate it to the new secret (`gh api --method PATCH repos/.../hooks/{id}`). "Existing URL" does not imply "existing secret matches" — the HMAC correctness depends on both. *(Spec 3, PR review iter1)*

### State must be persisted AFTER the network mutation, not before
Follow-on bug from the URL-match idempotency fix: the original implementation wrote state.json BEFORE the webhook PATCH, so a subsequent decline or failure at the PATCH prompt left state.json with a fresh secret that didn't match anything on GitHub. The next run would see `secretWasGenerated === false` (state already has a secret), skip the PATCH path as idempotent, and silently break HMAC validation forever. Fix: reorder so the webhook step runs BEFORE the state-write step. A decline/failure then throws before state.json is touched, and the next run correctly re-enters the fresh-secret-PATCH branch. General pattern: **persist local state only after the corresponding remote/network mutation has committed**, not before. The same logic applies to any installer that has both a local artifact and a remote artifact that must stay in sync — always commit the less-reversible side (the remote) first, then record it locally. *(Spec 3, PR review iter2)*

### Legacy global config fallback can silently override project-scoped state
`lib/config.ts` originally had a fallback: when a project root was detected but `<project-root>/.claude/channels/ci/.env` didn't exist, fall back to `~/.claude/channels/ci/.env`. This was added for backward compat with pre-project-scope installs, but combined with the installer's "never write `.env`" rule, it meant a stale global `WEBHOOK_SECRET`/`SMEE_URL` from an older install would silently override freshly-written project state. Fix: once a project root is detected, never fall back to the global path — return the project-local path even if it doesn't exist. The global fallback only applies when no project root is found. Unit tests must exercise `getDefaultEnvPath()` directly; `loadConfig()` tests that pass explicit paths don't catch this. *(Spec 3, PR review)*

### Node engine floor should match the strictest transitive dep, not just the top-level dep
When adding `@inquirer/prompts@8.4.1` (engine `>=20.12.0`), the transitive `mute-stream` required `^20.17.0 || >=22.9.0`. `package.json`'s `engines.node` was still `>=20` — too permissive. Users on Node 20.0-20.16 would hit install failures under `engine-strict`. Always check the full transitive dep graph when bumping engines: `node -e "console.log(require('./node_modules/{pkg}/package.json').engines)"`. *(Spec 3, PR review)*

---

*Generated by MAINTAIN protocol from review documents.*
*To add lessons: document them in review files, then run MAINTAIN.*
