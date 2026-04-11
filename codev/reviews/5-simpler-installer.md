# Review: `ci-channel setup` (Simpler Rebuild)

## Metadata
- **ID**: review-2026-04-11-simpler-installer
- **Spec**: `codev/specs/5-simpler-installer.md`
- **Plan**: `codev/plans/5-simpler-installer.md`
- **Issue**: cluesmith/ci-channel#5
- **Supersedes**: Spec 3 / PR #4 (closed unmerged)
- **Completed**: 2026-04-11

## Summary

Rebuilt `ci-channel setup --repo owner/repo` as a single-file, 120-line installer (`lib/setup.ts`) plus a 5-line dispatch in `server.ts` and a single-file 200-line test suite (`tests/setup.test.ts`, 8 scenarios). All constraints from the tightly-constrained Spec 5 were respected, and the implementation shipped in one plan iteration with no spec drift.

The feature does exactly five things: generate/load webhook secret, fetch/load smee.io URL, write state.json (conditionally), create/update GitHub webhook via `gh api`, and register `ci` in `.mcp.json`. Running `ci-channel setup --repo owner/repo` performs all five and prints a "Done" message. Re-running is idempotent. From any subdirectory of the project works.

## Spec Compliance

All hard constraints verified mechanically:

- [x] `wc -l lib/setup.ts` = 120 (cap 150) — **20% under cap**
- [x] `wc -l tests/setup.test.ts` = 200 (cap 200) — exactly at cap
- [x] 8 tests in `tests/setup.test.ts` (cap 8) — exactly at cap
- [x] `lib/setup.ts` is a single file; `lib/setup/` does not exist
- [x] `server.ts` dispatch is exactly 5 added lines (verified via `git diff main..HEAD -- server.ts | grep -c '^+[^+]'`)
- [x] `grep -E 'InstallDeps|SetupError|UserDeclinedError|readline|@inquirer|confirm\(|prompt\(' lib/setup.ts` returns nothing
- [x] `grep '"@inquirer' package.json` returns nothing
- [x] No new dependencies added to `package.json`
- [x] No `types.ts`, `errors.ts`, `io.ts`, `orchestrator.ts`, or other helper modules created
- [x] `.mcp.json` parse errors propagate naturally (no try/catch around `JSON.parse` except the top-level one)

All success criteria verified at runtime:

- [x] Re-running the command is idempotent (no duplicate webhooks, no errors) — verified by Scenario 2
- [x] Works from any subdirectory — verified by Scenario 6
- [x] `ci-channel` with no args still runs the MCP server — verified by the 5-line dispatch's exact-match check on `argv[2]`
- [x] All existing tests continue to pass — 173 baseline + 8 new = **181 tests, all pass**
- [x] State-first ordering — verified by Scenario 5, which seeds state with a smeeUrl only, fails the POST call, and asserts the state.json on disk has both the original smeeUrl AND a freshly-generated secret

## Deviations from Plan

None. The plan was executed as written, with one exception that was caught in plan review iter1 and applied before implementation started:

- **State unchanged check uses three conditions**: Plan iter1 sketch showed `if (!deepEqual(existing, desired))` which was immediately flagged by Claude as "don't add a helper" and by Codex as "two-field compare misses extra-field state.json files." The plan was updated to show the explicit three-condition boolean (`webhookSecret === secret && smeeUrl === smeeUrl && Object.keys(existing).length === 2`) and the implementation followed that. This was a plan-phase refinement, not an implementation deviation.

The final line count came in at 120 of the 150 allowed. The original plan projected ~134 lines. The 14-line cushion came from (a) inlining `parseArgs` more tightly than sketched, (b) using `ghApi` as a single Promise wrapper rather than two separate helpers, and (c) not needing any defensive `Array.isArray` guards beyond a single `.flat()` + `Array.isArray` check on the `--paginate --slurp` output.

## Implementation Summary

**Files created**:
- `lib/setup.ts` (120 lines) — the entire installer
- `tests/setup.test.ts` (200 lines, 8 tests) — the entire test suite
- `codev/reviews/5-simpler-installer.md` (this file)

**Files modified**:
- `server.ts` — 5 added lines (exact dispatch block from spec)
- `codev/resources/arch.md` — added Installer section + updated directory tree + updated "last updated" date
- `codev/resources/lessons-learned.md` — added 4 new lessons from Spec 5 (see Lessons Learned Updates below)

**Files NOT touched** (confirming scope):
- `lib/bootstrap.ts`, `lib/state.ts`, `lib/project-root.ts` — reused as-is
- `lib/forges/*`, `lib/config.ts`, `lib/handler.ts`, `lib/notify.ts`, `lib/reconcile.ts` — untouched
- `package.json` (no new deps), `tsconfig.json`, CI workflow — all untouched

## Lessons Learned

### What Went Well

- **The spec pre-committed the post-mortem as the constraint set**. Instead of guidelines, Spec 5 enumerated hard caps with mechanical checks (`wc -l`, `grep -c`, `ls`). Every reviewer in iter1 of every phase saw these as REQUIREMENTS, not suggestions, and the implementation stayed tight. Zero line-budget violations in the final artifact.
- **Architect intervention after iter1 consult was decisive**. Three reviewers flagged the "mock only `spawn`" test strategy as unworkable (real `fetch` in `fetchSmeeChannel`). The architect's response — "drop the `fetch` stub, prepopulate state.json in every test, lean on `tests/bootstrap.test.ts` for `fetchSmeeChannel` coverage" — removed the problem entirely rather than inventing a workaround.
- **The PATH-override fake `gh` strategy was the right call**. It requires zero code changes in the implementation, zero DI, and zero module indirection. Each test writes a POSIX shell script to a temp bin dir, prepends it to `process.env.PATH`, and inspects per-invocation log files. The only cost is a win32 skip on Scenarios 1–6 (shell scripts don't work on Windows out of the box).
- **Multi-agent 3-way consultation caught real issues at every phase**. Spec iter1: canonical payloads not embedded (Codex+Gemini+Claude), Scenario 3 contradictory (Codex+Gemini), `fetchSmeeChannel` null undefined (Codex+Claude). Plan iter1: state unchanged check too narrow (Codex), `.mcp.json` truthiness check (Codex), `deepEqual` sketch vs prose inconsistency (Claude), off-by-one grep (Claude). Impl iter1: server.ts dispatch added 6 raw lines not 5 (Codex). Tests iter1: missing `exitCode` assertions (Codex), missing state.json byte-equal (Codex). Every substantive concern was legitimate, not style noise.

### Challenges Encountered

- **Node:test stdout override swallowed TAP emissions**. My first pass at `runSetup` overrode `process.stdout.write` alongside `process.stderr.write` and `process.exit`. Only tests 6, 7, 8 showed up in the reporter — tests 1–5 were silently missing. Running with `--test-reporter=tap` revealed `1..8` (plan line says 8) but only `ok 6`, `ok 7`, `ok 8` emitted. The fix was to leave `process.stdout.write` alone; `node:test` emits subtest headers and `ok N` result lines via stdout DURING test execution (not just at boundaries), and any override that runs across an `await setup(...)` call swallows them. This cost ~10 minutes of head-scratching before I ran with the tap reporter; if I had started there I'd have seen the `1..8` mismatch immediately.
- **`exitCode === null` omission on success paths**. I added the exit-code assertion in Scenario 1 with the intent of copying it to 2/3/4/6 and then forgot. Codex caught this in tests iter1 review. The fix was mechanical (+1 line per test, +4 total) but the CLASS of bug — success-path tests that can silently pass through a failure-path exit — is worth remembering in general for any test helper that intercepts `process.exit`.
- **Porch's "min two phases" vs spec's "one commit, one PR"**. These are in tension: porch requires two machine-tracked phases, the spec forbids phased implementation. I resolved by interpreting the spec's intent as "don't slice the 150-line installer into 4 tiny phases" and using the single natural seam (impl vs. tests). Claude independently endorsed this interpretation in the plan review. Codex initially flagged it as a spec violation but accepted the interpretation after the Executive Summary was expanded.
- **The blank line in server.ts dispatch**. I added the 5-line dispatch block with a blank separator before `const initialConfig = loadConfig();`, which made the raw diff show 6 added lines. `grep -c '^+[^+]'` returned 5 (because the blank line matches `^+` but not `^+[^+]`), so I thought I was fine. Codex strictly interpreted "≤5 added lines" as raw diff count (including the blank) and requested changes. The fix was to drop the blank line so `}` abuts `const initialConfig` directly. Stylistically ugly but spec-compliant.

### What Would Be Done Differently

- **Run `--test-reporter=tap` from the very first test run** when writing tests that interact with node:test internals. The default reporter hides the `1..N` plan line that immediately tells you whether all your tests are being registered.
- **Compute `stateBefore = readFileSync(...)` in every success-path scenario by default**, not just the ones where the plan explicitly called for a byte-equal check. The omission in Scenario 1 was a carelessness bug; a template would have prevented it.
- **Write the exit-code assertion as a small helper function in the test file**. Something like `assertOk(res, msg?)` that enforces `res.exitCode === null` with a standardized error message. This would have caught the Scenario 2/3/4/6 oversight in one mechanical rename. The budget would have supported it (I had 2 lines of headroom before the Codex fixes).

### Methodology Improvements

- **The Spec 3 post-mortem lesson directly shaped Spec 5**. Without the `codev/resources/lessons-learned.md` entry "Prefer single-file implementations + real-fs tests for install/bootstrap commands," Spec 5 would have been another set of guidelines. With it, the architect could write a spec that said "hard cap, mechanically checked, reject conditions not style preferences" — and reviewers took it at face value. **SPIR protocols benefit enormously from explicit post-mortems feeding forward into the next spec's constraint set.**
- **Multi-agent 3-way consult at EVERY phase was worth the time cost**. Spec review caught 9 substantive issues. Plan review caught 9 more. Impl review caught 2 (blank line, untracked file). Tests review caught 2 (exit code, state byte-equal). That's 22 catches across 4 review rounds. A single-reviewer pass at each phase would have missed at least 30% of these — the three models disagree on enough things that parallel review is genuinely complementary, not just redundant.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Test strategy (`mock only spawn`) conflicts with `fetchSmeeChannel`'s real network call; tests would be flaky and non-deterministic.
  - **Addressed**: Architect intervention replaced the fetch-stub approach with "prepopulate state.json in every test." `fetchSmeeChannel` is covered by existing `tests/bootstrap.test.ts`.
- **Concern**: Scenario 3 ("existing hook, missing state.json") is logically impossible — a newly fetched smee URL cannot match an existing hook's URL.
  - **Addressed**: Scenario 3 was rewritten to "state present, webhook missing → CREATE using existing state" which tests the load-state path without contradiction.
- **Concern**: Canonical `.mcp.json` payload not embedded in spec.
  - **Addressed**: Added verbatim `{"command":"npx","args":["-y","ci-channel"]}` in the spec.

#### Codex (REQUEST_CHANGES)
- **Concern**: Test strategy conflicts with required fetchSmeeChannel behavior (same as Gemini).
  - **Addressed**: See above.
- **Concern**: State write requirements internally inconsistent — "unconditional write" vs "state.json not rewritten on idempotent re-run."
  - **Addressed**: Architect intervention specified the three-condition conditional write (deep-equal check against disk).
- **Concern**: `.mcp.json` output shape underspecified.
  - **Addressed**: Canonical entry embedded in spec.
- **Concern**: GitHub webhook matching and payload shape need exact definition.
  - **Addressed**: Spec now embeds the webhook payload verbatim and specifies `h.config?.url === state.smeeUrl` as the match rule.
- **Concern**: Smee failure behavior missing.
  - **Addressed**: Added explicit `throw new Error('Failed to provision smee.io channel')` on `fetchSmeeChannel` null return.
- **Concern**: Error exit behavior not tied down (setup catches internally vs. throws).
  - **Addressed**: Added Required Behavior 10: single top-level `try/catch` inside `setup()`, all errors → `[ci-channel] setup failed: <message>` to stderr + `process.exit(1)`.

#### Claude (COMMENT, non-blocking)
- **Concern**: Canonical webhook payload and `.mcp.json` `ci` entry not embedded.
  - **Addressed**: Embedded verbatim.
- **Concern**: `.mcp.json` creation path undefined when project root found via `.git/`.
  - **Addressed**: Required Behavior 8 now says "if the file exists, read and JSON.parse; if not, start from `{}`."
- **Concern**: Test 2 assertion ambiguous ("state.json not rewritten" vs unconditional write).
  - **Addressed**: Architect intervention resolved this with conditional write + byte-equal assertion.
- **Concern**: `.mcp.json` mock strategy needs endorsement.
  - **Addressed**: PATH-override pattern explicitly endorsed in spec.
- **Concern**: `--repo` regex validation would be cheap.
  - **Rebutted**: Spec ethos is "no needless defensive validation." A bad `--repo` produces a comprehensible `gh` error. Regex is one more line in a tight budget.

### Plan Phase (Round 1)

#### Gemini (APPROVE)
- No concerns raised.

#### Codex (REQUEST_CHANGES)
- **Concern**: Plan contradicts spec's "one commit, one PR" rule by proposing two phases.
  - **Addressed**: Executive Summary expanded to reconcile porch's machine-tracking requirement with the spec's "no phased implementation" rule. Two commits in one PR is the minimum-deviation answer; squash-merge at merge time is available if the reviewer prefers one commit.
- **Concern**: State unchanged check reduced to two fields; extra-field state.json files would false-positive as "unchanged."
  - **Addressed**: Added `Object.keys(existing).length === 2` as a third condition. If state has extras, the check fails and the write proceeds, dropping the extras on rewrite.
- **Concern**: `.mcp.json` truthiness check `if (!mcp.mcpServers?.ci)` would overwrite `ci: null`.
  - **Addressed**: Replaced with key-presence check `if (!('ci' in servers))`.
- **Concern**: Fake `gh` helper response shape `{ stdout, exitCode }` is missing `stderr` support; Scenario 5's stderr assertion is unreachable.
  - **Addressed**: Expanded shape to `{ stdout, stderr, exit }`. Scenario 5 now has a seam for the "API error" stderr.
- **Concern**: Scenario 7 (no project root) changes cwd but doesn't explicitly restore it.
  - **Addressed**: Added explicit `finally` restoration to Scenario 7's description.

#### Claude (APPROVE with minor nits)
- **Concern**: `git diff server.ts | grep '^+' | wc -l ≤ 5` has an off-by-one because `^+` matches the `+++ b/server.ts` header.
  - **Addressed**: Replaced with `grep -c '^+[^+]'`.
- **Concern**: Hardcoded "291 tests" baseline will drift.
  - **Addressed**: Removed the literal count; acceptance now says "record baseline at Phase 1 start." Actual count turned out to be **173**, not 291 — the spec's number was from an earlier snapshot.
- **Concern**: `deepEqual` in sketch vs "prefer direct compare" in prose is inconsistent guidance.
  - **Addressed**: Rewrote the sketch to show the explicit three-condition boolean.
- **Concern**: Manual smoke run listed in acceptance AND described as "not required for commit."
  - **Addressed**: Removed from acceptance; now described only as optional commit-message documentation.

### Implement Phase (Phase: impl, Round 1)

#### Gemini (APPROVE)
- No concerns raised.

#### Codex (REQUEST_CHANGES)
- **Concern**: `server.ts` dispatch added 6 raw diff lines, not 5, due to a blank separator before `const initialConfig = loadConfig()`.
  - **Addressed**: Removed the blank line so `}` abuts `const initialConfig`. Now exactly 5 added lines (verified with `git diff main..HEAD -- server.ts | grep -c '^+[^+]'` → 5, and raw `grep -c '^+'` → 6 only because of the `+++ b/server.ts` diff header).
- **Concern**: `lib/setup.ts` is on disk but untracked in git; the phase deliverable is incomplete without it staged.
  - **Addressed**: Staged via `git add lib/setup.ts server.ts`. The commit followed immediately after the rebuttal.

#### Claude (APPROVE)
- No concerns raised. Did a thorough per-constraint walkthrough and marked every spec requirement as ✓. Noted the `server.ts` static imports still evaluate in setup mode (known trade-off, acceptable under the ≤5-line dispatch cap).

### Implement Phase (Phase: tests, Round 1)

#### Gemini (APPROVE)
- No concerns raised. "Phase 'tests' fully and flawlessly implemented according to the plan and tight spec limits."

#### Codex (REQUEST_CHANGES)
- **Concern**: Scenarios 2, 3, 4, 6 call `runSetup(...)` but never assert `res.exitCode === null`. A silently-failing setup could still satisfy the other assertions and the test would pass.
  - **Addressed**: Added `const res = await runSetup(...)` + `assert.equal(res.exitCode, null, ` unexpected exit: ${res.stderr} `)` to all four scenarios. Error message includes `res.stderr` for diagnostic clarity.
- **Concern**: Scenario 1 doesn't assert state.json byte-equality, even though the spec explicitly requires it for the happy path.
  - **Addressed**: Added `const stateBefore = readFileSync(statePath, 'utf-8')` before `runSetup` and `assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)` after.

Line budget for these fixes: +6 lines. Saved +4 lines elsewhere by (a) collapsing Scenario 5's multi-line `assert.ok` into one line (−3) and (b) shortening the `runSetup` stdout-comment from 2 lines to 1 line (−1). Net +2. Final count: exactly 200/200.

#### Claude (APPROVE)
- No concerns raised. Verified all 8 scenarios match the spec, constraint caps are met, 181 tests pass. Noted the spec-compliant test helpers and the good decision to leave stdout uncaptured.

## Architecture Updates

Updated `codev/resources/arch.md`:

- **"Last updated" date** bumped to 2026-04-11
- **Directory tree** now includes:
  - `lib/setup.ts` — `ci-channel setup --repo owner/repo` installer (Spec 5)
  - `lib/project-root.ts` — walk-up project root discovery (this file existed but was missing from the tree; added for completeness)
  - `tests/setup.test.ts` — installer tests (8 scenarios, PATH-override fake gh)
- **New "Installer" component section** under Key Components, describing:
  - Purpose and design philosophy (single-file, non-DI, ≤150 lines)
  - State-first ordering invariant
  - Conditional write correctness check (not an optimization)
  - Key-presence `.mcp.json` merge rule
  - Always-PATCH rule for existing webhooks
  - The 5-line `server.ts` dispatch mechanism

## Lessons Learned Updates

Added four new entries to `codev/resources/lessons-learned.md`:

1. **"Tight specs pay for themselves — Spec 3 → Spec 5 rebuild"** — documents how Spec 5's hard-cap constraint style (lines, files, tests, patterns, all mechanically checked) prevented drift that Spec 3's guideline style didn't. Lists the specific issues the tight spec prevented by construction (deepEqual helper, `ci` truthiness check, fetch-stub test strategy).
2. **"Never override `process.stdout.write` during node:test execution"** — captures the debugging trap where overriding stdout swallows node:test's own TAP emissions, making tests silently disappear from the reporter with no error message. Recommends running with `--test-reporter=tap` to surface the `1..N` plan-line mismatch.
3. **"Natural-seam phase split for constrained single-PR specs"** — documents the impl-vs-tests split as the only legitimate phase boundary when a spec forbids "phased implementation" but porch requires `min_two_phases`. Avoid inventing additional seams.
4. **"Always assert `exitCode === null` on success paths when `process.exit` is intercepted"** — warns that success-path tests can silently pass through a failure-path exit unless every test explicitly asserts the exit code. Includes a concrete example (Scenario 2 in this project).

## Technical Debt

None introduced. The implementation is at the ceiling of the spec's complexity budget and has no TODO comments, no commented-out code, no feature-flag shims, and no deferred work.

One known trade-off (documented in the Phase 1 commit message and Claude's impl review): `server.ts`'s static imports (forges, bootstrap, reconcile, smee-client) still evaluate in `setup` mode because the 5-line dispatch happens after them. Refactoring the imports to lazy-load would blow the ≤5-line dispatch cap. The init side effects of those modules are non-destructive; setup() exits before they matter. Acceptable.

## Flaky Tests

No flaky tests encountered. All 181 tests pass consistently across multiple runs.

## Follow-up Items

None required for this spec. Possible future work (explicit non-goals of Spec 5, not planned):

- **GitLab / Gitea installer variants** — Spec 5 is GitHub-only. If users show up asking for `ci-channel setup --forge gitlab`, that's a new spec.
- **Webhook rotation** — currently handled by manually deleting `state.json` and re-running setup. A `--rotate` flag was considered and rejected.
- **Multi-project install** — one command per project is the intended UX.
