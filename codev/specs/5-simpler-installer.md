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

Write state.json BEFORE the webhook API call, on both create and PATCH paths. This prevents orphan webhooks on partial failure.

### Required Behaviors

These must be in the 150-line budget:

1. **Walk up from `process.cwd()` to find a project root** (reuse `findProjectRoot` from `lib/project-root.ts`)
2. **Load existing state.json** if present (reuse `loadState` from `lib/state.ts`), else start empty
3. **Generate webhook secret** via `crypto.randomBytes(32).toString('hex')` if state lacks one
4. **Fetch smee.io channel URL** via `fetchSmeeChannel` from `lib/bootstrap.ts` if state lacks one
5. **Write state.json** with `mode: 0o600` in a single `writeFileSync` call (no separate chmod)
6. **List hooks** via `spawn('gh', ['api', '--paginate', '--slurp', 'repos/OWNER/REPO/hooks'])`
7. **Create or PATCH hook** via `spawn('gh', ['api', ...])`, piping the JSON payload via stdin (use `stdio: ['pipe', 'pipe', 'pipe']` — don't inherit `process.stdin`)
8. **Merge .mcp.json** — read, parse, add `mcpServers.ci` if absent, write. Let `JSON.parse` throw on bad JSON.
9. **Print the next-steps message** and exit

## Test Scenarios (ALL in one file, ≤8 total)

Tests use real temp directories (via `fs.mkdtempSync`). Mock only `spawn` — intercept `gh` calls and return canned responses. Everything else is real fs.

1. **Happy path fresh install**: no state.json, no hook, no .mcp.json → all three created with expected contents. Verify state.json mode is 0o600 (skip on win32).
2. **Idempotent re-run**: state.json already correct, hook already present with matching URL, .mcp.json has `ci` entry → PATCH called once (always-PATCH), state.json not rewritten, .mcp.json unchanged.
3. **Re-run with existing hook, missing state.json**: PATCH called with freshly generated secret, state.json created with that secret.
4. **Re-run with existing .mcp.json that has other servers**: `ci` merged in; `other-server` preserved.
5. **CREATE failure**: mock `spawn` to make `gh api POST` exit non-zero → verify state.json was written BEFORE the POST attempt.
6. **Project root from subdirectory**: run from `<tmp>/src/foo/` with `.git/` at `<tmp>/` → state/mcp-json written at `<tmp>/.claude/...` and `<tmp>/.mcp.json`.
7. **No project root**: run from a directory with no `.git/` or `.mcp.json` anywhere → error exit with clear message.
8. **Missing `--repo`**: run without `--repo` → error exit with usage message.

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
