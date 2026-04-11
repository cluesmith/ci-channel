# Specification: `ci-channel setup` (Simpler Rebuild)

## Metadata
- **ID**: spec-2026-04-11-simpler-installer
- **Status**: draft
- **Created**: 2026-04-11
- **Issue**: cluesmith/ci-channel#5
- **Supersedes**: Spec 3 (PR #4 closed unmerged). See `codev/resources/lessons-learned.md` entry "Prefer single-file implementations + real-fs tests for install/bootstrap commands" for the post-mortem.

## Context — Why This Spec Is So Constraining

An earlier attempt at this feature (Spec 3, PR #4) produced **4,385 lines** of code across **19 files** for a command that does **5 operations**:

1. Generate a random webhook secret
2. Fetch a smee.io URL
3. Write them to state.json
4. Create or update a GitHub webhook
5. Register ci-channel in .mcp.json

A reasonable implementation is ~150 lines in one file. The previous attempt went through **6 review iterations**, most of which found bugs in code that only existed because of premature optimization (a "skip if webhook already correct" fast path).

**This spec defines the MAXIMUM allowed complexity, not the minimum.** Every constraint below is a hard cap that plan-phase and review-phase gates MUST enforce. Violations are reject conditions, not style preferences.

## Problem Statement

Installing ci-channel into a new project is currently a five-step manual process. Users want one command.

That's the entire problem. Nothing more subtle. No edge cases to enumerate. No abstractions to invent.

## Desired State

```bash
ci-channel setup --repo owner/repo
```

Running that command performs all five operations and prints "Done. Launch Claude Code with `claude --dangerously-load-development-channels server:ci`."

Running it again on an already-configured project is safe: it reuses existing state.json, PATCHes the existing webhook (bringing it to canonical config), and leaves `.mcp.json` alone if `ci` is already registered.

## Success Criteria

- [ ] `ci-channel setup --repo owner/repo` completes in under 10 seconds on a fresh project
- [ ] Re-running on the same project is idempotent (no duplicate webhooks, no errors)
- [ ] Works from any subdirectory of the target project
- [ ] `ci-channel` with no args still runs the MCP server (existing behavior preserved)
- [ ] All existing tests continue to pass
- [ ] Implementation is ≤150 lines in a single file
- [ ] Tests are ≤200 lines in a single file, ≤8 tests total

## HARD CONSTRAINTS (MAX, not suggestions)

### Size

- **Implementation**: single file `lib/setup.ts`, ≤150 lines including imports and comments
- **Tests**: single file `tests/setup.test.ts`, ≤200 lines, ≤8 tests total
- **Dispatch in server.ts**: ≤5 lines added
- **No `lib/setup/` subdirectory**. No module split.
- **Maximum comment block**: 5 consecutive lines. No field audit blocks. No long rationale blocks.

### CLI Surface (this is the WHOLE CLI)

```
ci-channel setup --repo owner/repo
```

That is the entire flag set. Not a subset — the entire set.

- **No `--yes`** (there are no prompts to skip)
- **No `--dry-run`** (nobody dry-runs a once-per-project installer)
- **No `--smee-url`** (edit state.json directly if you need a custom channel)
- **No `--forge`** (GitHub only; if GitLab/Gitea users show up later, that's a new spec)
- **No `--help`** (print usage to stderr when `--repo` is missing)

### No Interactive Prompts

**Running the command is the confirmation.** The user typed `ci-channel setup --repo owner/repo`; they don't need a yes/no prompt to proceed. This removes:

- `@inquirer/prompts` dependency (not allowed)
- `readline` usage (not allowed)
- TTY detection (not needed)
- Any `Io` / `confirm` / `prompt` abstraction (not allowed)
- `UserDeclinedError` or any decline handling (not possible)

### No New Dependencies

The only allowed dependencies are what's already in `package.json`. **Do not add `@inquirer/prompts`, `commander`, `yargs`, `chalk`, or anything else.** Use Node built-ins and existing deps only.

### No Code Patterns

The following are forbidden in the implementation:

- **Dependency injection** — no `InstallDeps` bag, no `Io` interface, no "for testability" abstractions. Call `fs`, `spawn`, `fetch` directly. Tests use real temp directories.
- **Class hierarchies** — no `SetupError`, no `UserDeclinedError`. If you need to throw, throw `new Error(...)`. One top-level try/catch is fine.
- **Separate modules** — no `types.ts`, `errors.ts`, `io.ts`, `project.ts`, `state.ts`, `gitignore.ts`, `mcp-json.ts`, `orchestrator.ts`, `gh.ts`. Everything goes in `lib/setup.ts`.
- **Defensive parsing** — `JSON.parse` throwing on malformed `.mcp.json` is fine. Do not implement a multi-shape defensive matrix.
- **Pagination fallbacks** — require `gh` ≥ 2.29 (released mid-2023). Use `gh api --paginate --slurp`. Do not implement a regex-based fallback for older versions.
- **`.gitignore` ancestor walking** — if you want to warn about state.json not being gitignored, print the warning unconditionally. Do not walk the directory tree looking for `.gitignore` files.
- **Multi-hook detection / warnings** — if more than one hook matches the smee URL, just pick the first and PATCH it. No warning.
- **Legacy global state detection** — do not mention or detect `~/.claude/channels/ci/state.json`. Project-local only.
- **Helper functions that exist solely for testing** — no `promptForRepo` exported for tests. Main function is the unit of test.
- **Phased implementation** — one commit, one PR. Not four phases.

### Always-PATCH Rule

If a matching webhook exists at the expected smee URL, **always PATCH it** with the canonical ci-channel payload. Do not implement any "skip if already correct" optimization. This is the lesson from Spec 3 iterations 1–5.

### State-First Ordering

Write state.json BEFORE the webhook API call (both POST/create and PATCH/update paths). On an idempotent re-run where state is already on disk, the write still happens (unconditional); the bytes are identical so disk contents don't change. This ordering prevents orphan webhooks on partial failure: if the `gh` call fails, the secret/URL used are already persisted and the user can re-run to recover.

### Required Behaviors

These must be in the 150-line budget:

1. **Walk up from `process.cwd()` to find a project root** (reuse `findProjectRoot` from `lib/project-root.ts`). If it returns `null`, throw.
2. **Load existing state.json** if present (reuse `loadState(path)` from `lib/state.ts`, passing the project-scoped path), else start empty
3. **Generate webhook secret** via `crypto.randomBytes(32).toString('hex')` if state lacks one
4. **Fetch smee.io channel URL** via `fetchSmeeChannel` from `lib/bootstrap.ts` if state lacks one. If it returns `null`, throw `new Error('Failed to provision smee.io channel')`.
5. **Write state.json** unconditionally with `mode: 0o600` in a single `writeFileSync` call (no separate chmod). On idempotent re-runs the contents happen to be identical; this is fine — the file is rewritten with the same bytes. Do NOT add a "skip write if unchanged" optimization.
6. **List hooks** via `spawn('gh', ['api', '--paginate', '--slurp', 'repos/OWNER/REPO/hooks'])`. `--slurp` returns a JSON array of pages (an array of arrays); flatten with `.flat()` before searching.
7. **Match existing hook** by `h.config?.url === state.smeeUrl`. If multiple match, take the first. If one matches, PATCH it via `spawn('gh', ['api', '--method', 'PATCH', 'repos/OWNER/REPO/hooks/:id', '--input', '-'])`. Otherwise CREATE via `spawn('gh', ['api', '--method', 'POST', 'repos/OWNER/REPO/hooks', '--input', '-'])`. In both cases pipe the canonical payload JSON via stdin (use `stdio: ['pipe', 'pipe', 'pipe']` — don't inherit `process.stdin`).
8. **Merge .mcp.json** — if the file exists, read and `JSON.parse` it (let parse errors throw naturally); if it does not exist, start from `{}`. Ensure `mcpServers.ci` equals the canonical entry below; if absent or different, set it. Write back with 2-space indent + trailing newline.
9. **Print the next-steps message** to stdout and return/exit 0
10. **Error handling**: a single top-level `try/catch` inside `setup()`. On any thrown error, print `[ci-channel] setup failed: <message>` to stderr and `process.exit(1)`. Let `gh` subprocess non-zero exits, ENOENT (gh not installed), `JSON.parse` errors, and `findProjectRoot` nulls all flow through this one catch — no special-casing.

### Canonical Payloads (use these exact shapes)

**Webhook payload** (for both POST create and PATCH update):
```json
{
  "config": {
    "url": "<state.smeeUrl>",
    "content_type": "json",
    "secret": "<state.webhookSecret>"
  },
  "events": ["workflow_run"],
  "active": true
}
```

**`.mcp.json` `ci` entry** (identical to `INSTALL.md:17`):
```json
{"command": "npx", "args": ["-y", "ci-channel"]}
```

A re-run must only rewrite `.mcp.json` if the existing `ci` entry is missing or not deep-equal to the canonical entry above. If `.mcp.json` has other servers under `mcpServers`, they must be preserved verbatim.

## Test Scenarios (ALL in one file, ≤8 total)

Tests use real temp directories (via `fs.mkdtempSync`) and a real file system. The production code is run unmodified.

### Test Mocking Strategy (no DI)

Two external things need to be controlled in tests:

1. **`gh` CLI** — use the **PATH-override pattern**. Each test writes a fake `gh` executable to a temp bin directory and prepends that directory to `process.env.PATH` for the duration of the test (restored in a `try/finally` or `after` hook). The fake `gh` is a POSIX shell script that (a) captures its argv + stdin into a log file inside the test's temp dir and (b) prints a canned JSON response to stdout, optionally exiting non-zero. Tests inspect the log file to assert what `gh` was called with and in what order. `lib/setup.ts` itself calls `spawn('gh', …)` with no env override; the fake on PATH wins.
2. **`fetchSmeeChannel`** — stub `globalThis.fetch` for the duration of the test so `fetchSmeeChannel` does not make a real network call. This is an **explicit permitted exception** to the "only gh is faked" rule because `fetchSmeeChannel` is reused unchanged from `lib/bootstrap.ts` and the alternative (pre-seeding every test's state.json) would miss the fresh-install path. The stub returns a synthetic 302 response with a `location: https://smee.io/<test-channel>` header to keep `fetchSmeeChannel` on its happy path.

No other mocking is allowed. No `vi.mock`, no `mock.module`, no module-level indirection in `lib/setup.ts` for testability. On Windows, the PATH-override + fake-shell-script approach does not work; tests that require a fake `gh` are skipped when `process.platform === 'win32'`.

### Scenarios (8 max)

1. **Happy path fresh install**: no state.json, no hook, no .mcp.json → state.json, webhook (via `gh api POST`), and .mcp.json all created with expected contents. Verify state.json mode is `0o600` (skip the mode assertion on win32).
2. **Idempotent re-run**: state.json present with valid `webhookSecret` + `smeeUrl`, `gh` list returns one hook whose `config.url` matches state.smeeUrl, .mcp.json already has the canonical `ci` entry → `gh api PATCH` is called exactly once (always-PATCH rule), state.json file **contents** are unchanged (mtime may change — the assertion is byte-equality of contents, not file-not-rewritten), .mcp.json is left with byte-equal contents.
3. **State present, webhook missing**: state.json has both fields, `gh` list returns `[]` (no existing hook), .mcp.json already has the canonical `ci` entry → `gh api POST` is called (CREATE, not PATCH) using the existing state's secret and URL; state.json contents unchanged; .mcp.json unchanged. This exercises the load-state path and confirms CREATE is used when no matching hook exists.
4. **Re-run with existing `.mcp.json` that has other servers**: .mcp.json contains `mcpServers: { "other": {...} }`, state.json is fresh → after setup, .mcp.json contains both `other` (unchanged) and the canonical `ci` entry.
5. **CREATE failure (state-first ordering)**: fake `gh` returns `[]` for the list call, then exits non-zero on the POST call → `setup()` rejects/exits non-zero, and state.json **has been written to disk before the POST attempt**. Assertion: read state.json from disk after `setup()` returns; it must exist and contain the generated secret + smee URL. This is the single most important test — it locks in the state-first ordering that prevents orphan webhooks.
6. **Project root from subdirectory**: create `<tmp>/.git/`, run `setup` with `process.chdir(<tmp>/src/foo/)` → state.json is written to `<tmp>/.claude/channels/ci/state.json` and `.mcp.json` is written to `<tmp>/.mcp.json`. (Restore `process.cwd()` in a `finally`.)
7. **No project root**: run from a directory with no `.git/` or `.mcp.json` anywhere in ancestry → `setup()` exits non-zero with an error message mentioning "project root" on stderr.
8. **Missing `--repo`**: run `setup([])` → exits non-zero with a usage message on stderr that mentions `--repo`.

## Dispatch Integration

Add exactly these lines near the top of `server.ts` (after imports, before `loadConfig()`):

```typescript
if (process.argv[2] === 'setup') {
  const { setup } = await import('./lib/setup.js')
  await setup(process.argv.slice(3))
  process.exit(0)
}
```

5 lines max. The existing `--forge gitlab` / `--repos` / etc. passthrough is preserved because `setup` is an exact-match check on `argv[2]`.

## What This Spec Does NOT Cover

Explicit non-goals:

- **GitLab / Gitea installer**: new spec later if needed
- **Webhook rotation**: users who want to rotate manually delete state.json and re-run
- **`gh` auth automation**: user must have `gh auth login` done already
- **Multi-project install**: one command per project
- **Smee channel reuse across projects**: deliberately not done — each project gets its own channel
- **Telemetry or analytics**: no
- **Rollback**: no (the operations are idempotent; re-running is the recovery)
- **Logging beyond one "Done" line**: no

## Review Gate Enforcement

At PR review time, the reviewer MUST verify:

- [ ] `wc -l lib/setup.ts` ≤ 150
- [ ] `wc -l tests/setup.test.ts` ≤ 200
- [ ] `lib/setup.ts` is a single file; `lib/setup/` does not exist
- [ ] `tests/setup.test.ts` contains ≤ 8 test cases
- [ ] `grep -r "InstallDeps\|Io interface\|SetupError\|UserDeclinedError" lib/setup.ts` returns nothing
- [ ] `grep '"@inquirer' package.json` returns nothing
- [ ] `grep -r "readline\|confirm\|prompt" lib/setup.ts` returns nothing
- [ ] No files added under `lib/setup/`
- [ ] No `types.ts`, `errors.ts`, `io.ts`, `orchestrator.ts`, etc.
- [ ] `.mcp.json` parse errors propagate naturally (no try/catch around `JSON.parse` except at the top level of `setup()`)

**Any violation of the HARD CONSTRAINTS is an automatic REQUEST_CHANGES verdict. These are not style suggestions; they are the spec.**

## Dependencies

- `crypto.randomBytes` (Node built-in)
- `node:fs`, `node:path`, `node:child_process` (Node built-ins)
- `findProjectRoot` from `lib/project-root.ts` (existing)
- `loadState` from `lib/state.ts` (existing)
- `fetchSmeeChannel` from `lib/bootstrap.ts` (existing)
- `gh` CLI ≥ 2.29 (installed by user, not a package dep)

No new `package.json` entries. No new runtime or dev dependencies.

## Expected Review Flow

Because the spec is so tight, the review iterations should be minimal:

- **Spec review**: mostly "yes, the constraints make sense given the Spec 3 post-mortem"
- **Plan review**: mostly "the plan respects the constraints"
- **PR review**: the reviewer runs the checklist above. If all pass, APPROVE. If any fail, the fix is "delete the offending code", not "refactor it."

If the plan phase starts introducing `types.ts` or `InstallDeps` or confirms for every step, reject the plan.

## Success Looks Like

A PR that:
- Adds ≤150 lines to `lib/setup.ts`
- Adds ≤200 lines to `tests/setup.test.ts`
- Adds ≤5 lines to `server.ts`
- Modifies no other code
- Passes all 8 test scenarios
- Passes the existing 291 tests unchanged
- Is reviewable in one sitting
- Ships in one iteration (or two at most)

## Consultation Log

### Specify iteration 1 (Codex, Gemini, Claude)

All three reviewers ran on the pre-committed spec. Codex and Gemini returned REQUEST_CHANGES; Claude returned COMMENT. Every concern was a gap-fill, not a complexity-add; the tight constraint set was endorsed.

Changes made in response:

- **Canonical payloads embedded verbatim** (webhook JSON + `.mcp.json` `ci` entry). Previously the spec said "canonical payload" without showing it. Raised by all three reviewers.
- **`.mcp.json` creation path** clarified — if the file is absent (project root found via `.git/`), start from `{}` and write. Raised by Claude.
- **`fetchSmeeChannel` null handling** specified: throw `Error('Failed to provision smee.io channel')` which the top-level catch turns into a non-zero exit. Raised by Codex and Claude.
- **Error propagation** spelled out: single `try/catch` inside `setup()`, all errors (gh non-zero, ENOENT, JSON.parse, findProjectRoot null) flow through it. Raised by Codex and Claude.
- **Test mocking strategy** explicitly endorsed: PATH-override fake `gh` (unix only, skip on win32) + `globalThis.fetch` stub as the one permitted fetch exception. Raised by all three reviewers — the original "only mock spawn" rule was unworkable against ESM namespace imports and against `fetchSmeeChannel`'s real network call.
- **Scenario 3 rewritten** from the contradictory "existing hook, missing state.json" (a newly fetched smee URL cannot match an existing hook created from a prior different URL) to "state present, webhook missing → CREATE called using existing state; state-first ordering preserved." This tests the load-state path without creating a logical impossibility. Raised by Codex and Gemini.
- **Scenario 2 assertion wording** tightened from "state.json not rewritten" to "state.json **contents** unchanged (byte-equality; mtime may differ)." This keeps the write unconditional (no "skip if unchanged" fast path) while still asserting idempotency. Raised by Claude.
- **`gh api --paginate --slurp` output shape** clarified: returns a JSON array of pages; flatten with `.flat()`. Raised by Codex.
- **Webhook matching rule** made explicit: `h.config?.url === state.smeeUrl`, take first if multiple. Raised by Codex and Claude.

Not changed (explicitly rejected):

- **`--repo` regex validation** (Claude suggested `^[\w.-]+/[\w.-]+$`). Rejected — the spec's spirit is "no needless defensive validation"; a malformed `--repo` produces a perfectly comprehensible `gh` error, and a regex is one more line in a 150-line budget.
- **Complex smee URL adoption logic** (Gemini suggested: list hooks first, adopt any existing smee.io URL, then skip `fetchSmeeChannel`). Rejected — this is a fast-path optimization exactly like the "skip if webhook correct" trap from Spec 3. Scenario 3 rewrite removes the motivation.
- **Anything adding new modules, DI, or interfaces** — all three reviewers were careful to stay inside the constraint set; no such suggestions were made.
