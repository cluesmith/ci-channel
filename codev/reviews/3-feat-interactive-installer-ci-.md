# Review: feat-interactive-installer-ci-

**Project**: 3 — feat: Interactive installer (`ci-channel setup`)
**Spec**: `codev/specs/3-feat-interactive-installer-ci-.md`
**Plan**: `codev/plans/3-feat-interactive-installer-ci-.md`
**Date**: 2026-04-10

## Summary

Added a `ci-channel setup` subcommand that replaces the previous five-step manual install flow with a single command. The installer detects the project root, provisions a smee.io channel, generates a webhook secret, creates the GitHub webhook via `gh api`, and registers the `ci` MCP server in `.mcp.json` — all idempotently, with `--yes` / `--dry-run` flags and optional interactive prompts backed by `@inquirer/prompts`. GitHub-only in v1; GitLab/Gitea users fall back to the manual flow in INSTALL.md (now retained as the secondary install path).

The feature is a pure addition: no existing `lib/` file was modified (other than a ~10-line subcommand dispatch insertion at the top of `server.ts`). All 170 pre-existing tests still pass; 121 new tests were added across 8 new test files, bringing the suite to **291 tests / 19 files**.

## Spec Compliance

Every success criterion from the spec has been met:

- [x] `npx ci-channel setup --repo owner/repo` runs end-to-end on a fresh project → covered by `tests/setup-integration.test.ts`.
- [x] `ci-channel setup` without subcommand args runs the MCP server (existing behavior preserved) → verified by `tests/stdio-lifecycle.test.ts` which spawns the server with no args.
- [x] Interactive mode prompts before each side-effecting step → `tests/setup-interactive.test.ts` covers all four mutation prompts.
- [x] `--yes` flag suppresses all prompts → covered by orchestrator and integration tests.
- [x] `--dry-run` prints planned actions without executing mutating ops → `tests/setup-orchestrator.test.ts` and `tests/setup-integration.test.ts` both assert zero file writes / zero POSTs.
- [x] Non-TTY without `--yes` → fail fast → `tests/setup-args.test.ts` + `tests/setup-io-tty.test.ts`.
- [x] `--forge github` works; `--forge gitlab`/`gitea` fail fast with v1-scoping message → `tests/setup-args.test.ts`.
- [x] Idempotency: re-run doesn't duplicate webhooks, overwrite valid state, or duplicate `.mcp.json` entries → `tests/setup-orchestrator.test.ts` covers every row of the matrix.
- [x] `gh` missing → `SetupError` with install hint → `tests/setup-gh.test.ts`.
- [x] Works from any subdirectory → `tests/setup-integration.test.ts` has a dedicated sub-test exercising `findProjectRoot` from a nested `src/foo/` directory.
- [x] Works with both source and npm install paths → `tests/setup-dispatch.test.ts` includes a built-binary smoke test that runs `npm run build` then spawns `dist/server.js`.
- [x] Unit tests cover state-file, `.mcp.json` update, and webhook-creation logic with mocks → `setup-mcp-json.test.ts`, `setup-gh.test.ts`, `setup-orchestrator.test.ts`.
- [x] Existing 170 tests continue to pass → verified at every phase boundary.
- [x] README.md and INSTALL.md updated → documentation phase.

## Deviations from Plan

None of substance. Two minor adjustments:

- **`mergeCiServer` return shape** locked to `{ updated, action }` (no `changed` field) during the plan review — Claude caught a signature drift between the deliverable list and the implementation block. Locked at plan-rebuttal time, implemented correctly.
- **`promptForRepo` exported as a testable helper** from `lib/setup/index.ts`. Plan described it as a private helper inside `runSetup`, but a private helper couldn't be unit-tested without depinjection. Exporting it enables direct unit tests for the 3-strike retry loop without having to spawn the full `runSetup`. Documented in `tests/setup-io-tty.test.ts`.

## Architecture Updates

`codev/resources/arch.md` was updated in Phase 4 to document the new installer:

1. **Directory tree** — added the full `lib/setup/` subdirectory with per-file descriptions and the 8 new test files.
2. **Technology Stack** table — added `@inquirer/prompts` at pinned version `8.4.1` (no caret).
3. **MCP Server (`server.ts`)** section — added the subcommand dispatch as the first responsibility, explaining that the dispatch runs after static imports are hoisted but before `loadConfig()`, and that the dynamic `import('./lib/setup/index.js')` keeps installer-only deps off the server path.
4. **New section: Interactive Installer (`lib/setup/`)** — a full module-by-module breakdown plus the end-to-end install flow diagram (detect root → load state → resolve secret → resolve smee URL → write state → check `.gitignore` → list hooks → create hook → merge `.mcp.json` → print next steps).
5. **Configuration** section — updated to describe project-local paths (`<project-root>/.claude/channels/ci/`) as canonical with the legacy global path as backward-compat fallback. The previous wording incorrectly described `~/.claude/channels/ci/` as the primary location.
6. **Bootstrap** section — aligned with the new model: auto-provisioned state goes to project-local `state.json`, and the `.env` file is never written by the plugin or installer.
7. **Security Model** — corrected the subprocess isolation entry to reflect the real invariant ("don't inherit `process.stdin`"), noting both the `stdin: 'ignore'` pattern (server path) and the `stdio: ['pipe', 'pipe', 'pipe']` pattern (installer's `ghCreateHook`) as valid.
8. **Footer** — bumped from "Spec 1 (multi-forge support)" to "Spec 3 (interactive installer)".

## Lessons Learned Updates

`codev/resources/lessons-learned.md` was updated to add a new **Interactive Installer (Spec 3)** section with 10 new entries, plus a refinement to the existing **MCP stdio pollution from child processes** entry (which previously stated the rule as absolute `stdin: 'ignore'` but now correctly identifies the underlying invariant as "don't inherit `process.stdin`"). New entries:

1. Subcommand dispatch in ESM: place the guard after imports, not before.
2. `writeFileSync({ mode: 0o600 })` only applies on file creation (TOCTOU warning).
3. Don't reuse `saveState` from the runtime for installer writes (convergent-reviewer catch).
4. `gh api --paginate` output format is unreliable — prefer `--slurp`.
5. State-write idempotency: diff-check before writing, not just after dry-run.
6. Matrix checks that cross multiple axes need explicit per-cell tests.
7. Confirmation prompts via dependency injection + scripted `Io`.
8. `UserDeclinedError extends SetupError` with `exitCode 0`.
9. Minimal `.gitignore` matcher is enough for a warning.
10. Dependency-inject `detectProjectRoot` in integration tests instead of mutating `process.cwd()`.

## Lessons Learned

### What Went Well

- **Pure-addition architecture** — The entire installer lives under `lib/setup/`. The only modification to existing code was a ~10-line dispatch block at the top of `server.ts`. This made rollback trivial at every phase and meant the MCP server tests were unaffected throughout.
- **Dependency injection in the orchestrator** — Abstracting all I/O through `InstallDeps` and `Io` made every non-trivial test a simple mock setup. No real filesystem, subprocess, or network was needed for the bulk of the test suite. The one "real filesystem" integration test is focused and small (verifies `chmod 0o600`, idempotent re-run, `.mcp.json` merge).
- **Phase boundary discipline** — Each phase was committable in isolation, and the build-test cycle stayed green at every boundary. Phase 1 was scaffolding-only; Phase 2 was non-interactive core; Phase 3 layered prompts on top; Phase 4 was docs. This ordering let the 3-way review catch issues early (e.g., the `saveState` swallowing bug was caught after Phase 2 and fixed before Phase 3 layered anything on top).
- **Matrix documentation in code comments** — After Codex caught the TTY-matrix bug in Phase 3, I rewrote the parser's matrix check as an ASCII table comment alongside the code. Future readers can verify cell-by-cell which branches are reachable without reconstructing it from the code flow.
- **Convergent reviewer feedback as a signal** — All three reviewers (Gemini, Codex, Claude) flagged the `saveState` + TOCTOU issue in the Phase 2 review. That convergence was strong evidence the bug was real (not reviewer nit-picking), and the fix was unambiguous. Reviewers disagreeing is normal; reviewers agreeing is load-bearing.

### Challenges Encountered

- **ESM import hoisting misconception** — My initial plan described the dispatch as needing to run "before imports because `loadConfig` throws on unknown flags." This was wrong on two counts: (1) imports don't *call* `loadConfig`, they only bind the name; and (2) ESM hoists all static imports before any top-level code regardless of textual placement. Both Claude and Gemini caught this in the plan-phase review. Fixed in the rebuttal and the code ended up placing the dispatch after imports but before `loadConfig()` on line 20, which is the correct location.
- **`chmod 600` TOCTOU on existing files** — The plan called for `writeFileSync({ mode: 0o600 })`, which I assumed would handle both create and overwrite. On POSIX, the mode option is only honored on file creation — an existing file keeps its old mode. Codex caught this in the Phase 2 review. Fix: follow the write with an explicit `chmodSync(path, 0o600)` (skipped on Windows). Added a regression integration test that pre-creates the file with `0o644` and asserts the mode after a run.
- **Non-TTY + `--repo` + no `--yes` matrix cell missed** — The parser's TTY check was nested inside the `repoRaw === null` branch, so non-TTY runs with `--repo` but without `--yes` parsed successfully and then failed later inside `@inquirer/prompts` with a confusing error. Codex caught this in the Phase 3 review. Fix: lifted the TTY check out of the `repoRaw === null` branch so it applies whenever `!yes`. Two new regression tests added.
- **`.env` story in docs drifted** — Phase 4 (docs) initially updated only the top-level install section but left the per-forge sections saying `.env` was "auto-generated on first run" — the old model that the spec explicitly moved away from. Codex caught this in the Phase 4 review. Fix: rewrote the State bullet in all three per-forge sections (GitHub, GitLab, Gitea) to correctly describe state.json as the auto-provisioned source of truth with `.env` as user-managed only.
- **Stale internal anchor links** — Two `[Quick Start](#zero-config-quick-start)` references in README.md broke when the section was renamed to `## Installation`. Codex and Claude both caught this in the Phase 4 review. Fix: replaced with `#installation` and rewrote one reference to remove the stale "step 4" pointer.

### What Would Be Done Differently

- **Start with the matrix table as an ASCII comment**. The TTY matrix bug would have been much harder to introduce if I had started with the 8-cell table as a comment above the check, then written the code to mirror the cells. Instead, I wrote the check as a nested `if` that only enforced the TTY condition inside the missing-`--repo` branch. Recommendation: whenever a parser has N × M × K behavior cells, write the table first.
- **Include `chmod` semantics in the plan's security section**. The TOCTOU bug would have been caught pre-implementation if the plan had said "`writeFileSync({ mode })` only applies on create, so also call `chmodSync`." It was a POSIX foot-gun I didn't know about at plan time.
- **Write per-forge doc updates at the same time as the install-section rewrite**. Splitting "update primary install docs" into "top-level section" and "per-forge sections" as separate mental passes is what caused the `.env`-auto-generated leftover wording. Next time: grep for every mention of the old model before concluding the doc rewrite.

### Methodology Improvements

- **Multi-reviewer convergence should get a dedicated call-out in rebuttals.** When all three reviewers independently flag the same issue, that's a strong signal. The rebuttal for `installer_core` had a "Convergent issues" section that made the pattern explicit. I'd recommend adding "Convergent issues (flagged by multiple reviewers)" as a standard heading in rebuttal templates — it helps prioritize fixes and builds shared vocabulary.
- **Plan-phase implementation snippets should be compile-checked.** The `helpRequested` vs. discriminated-union inconsistency between the plan's deliverable list and its runner pseudocode would have been caught by a pre-commit check that parses the snippets as TypeScript. Out of scope for this project to implement, but worth considering for the SPIR protocol.

## Technical Debt

- **`promptForRepo` is exported from `lib/setup/index.ts`** purely so it can be unit-tested. It's not a stable public API — the right long-term fix is to refactor `runSetup` to accept an optional `deps` parameter (as the orchestrator already does) so the entire function can be tested without exposing internals. Low priority; current tests are sufficient.
- **Dry-run placeholder secret `[redacted]` briefly lives in the `state` object** during dry-run execution. It never reaches the writer (dry-run short-circuits before `writeState`), but the placeholder value is present in the in-memory state object for the rest of the flow. Not a correctness issue, just a minor aesthetic.
- **`ghListHooks` fallback for pre-2.29 `gh` is untested against a real gh binary**. The fallback path is covered by unit tests with mocked spawn output, but no integration test runs against an actual old `gh` version. The risk is low (`gh` 2.29 shipped mid-2023) but documented.
- **The `.gitignore` matcher is minimal** — it does simple prefix matching, not full gitignore pattern semantics. This is intentional (it's a warning-only feature, and full semantics would require a gitignore-parsing dependency), but a clever user with a `!` negation pattern could get a false positive/negative. Documented in the code comment.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini — APPROVE
- **Stdio isolation vs. stdin payload contradiction**: `stdin: 'ignore'` can't pipe a payload to `gh api --input -`. **Addressed**: Rewrote the subprocess constraint to describe the real invariant ("don't inherit `process.stdin`") and allow both the pipe and temp-file approaches.
- **Dynamic import for subcommand dispatch**: Should use `await import('./lib/setup/index.js')` to avoid loading installer-only deps on the server path. **Addressed**: Added to technical constraints.
- **`.env` writing utility would be needed**: **N/A** — the `.env` write was removed entirely in response to Codex issue 1.

#### Codex — REQUEST_CHANGES
- **`.env` ownership conflict with existing runtime model**: **Addressed** — removed `.env` writes from the installer entirely; state.json is the only auto-provisioned source of truth.
- **Non-interactive flag semantics inconsistent across `--yes`/`--dry-run`/missing `--repo`**: **Addressed** — added an explicit 8-cell matrix to the spec.
- **Idempotency rules contradict `--smee-url` override behavior**: **Addressed** — rewrote the idempotency table with explicit override semantics (reuse secret, new webhook, leave old in place).
- **`.mcp.json` malformed/non-object handling unspecified**: **Addressed** — added 7-row fail-fast matrix.
- **Legacy global-state compatibility not addressed**: **Addressed** — clarifying question #11 states installer never reads/migrates/deletes global state.

#### Claude — COMMENT
- **`stdin: 'ignore'` contradicts `gh api --input -`**: Same as Gemini issue 1. **Addressed**.
- **TTY handling for interactive mode unspecified**: **Addressed** — clarifying question #10, success criterion, and interactive matrix added.
- **`.env` + `state.json` duplication**: Same as Codex issue 1. **Addressed**.
- **"Not yet implemented" wording for GitLab/Gitea misleading**: **Addressed** — corrected to say the MCP server still supports all three forges; only the installer is GitHub-only.
- **`--smee-url` vs idempotency contradiction**: Same as Codex issue 3. **Addressed**.
- **Webhook list pagination**: **Addressed** — step 6 now requires `gh api --paginate`.
- **`ensureSecretReal` has no path parameter**: **Addressed** — noted in constraints that the installer must handle explicit project-local paths.
- **`lib/setup/` vs flat layout**: **Addressed** — one-line justification added.

### Plan Phase (Round 1)

#### Gemini — COMMENT
- **ESM import hoisting misconception**: **Addressed** — rewrote dispatch snippet placement + executive summary.
- **`saveState` error swallowing**: **Addressed** — plan now requires direct `writeFileSync` with error propagation.
- **Integration test CWD vs `detectProjectRoot`**: **Addressed** — test injects `detectProjectRoot` as a dep.

#### Codex — REQUEST_CHANGES
- **`saveState` is unsafe for installer writes**: **Addressed** — planned to write directly, not via `saveState`.
- **`gh api --paginate` parsing fragility**: **Addressed** — planned to use `--slurp` with documented fallback.
- **CLI parser contract inconsistencies (`helpRequested` missing, repeated-flag semantics undecided)**: **Addressed** — discriminated union return type, repeated-flag throws.
- **`.gitignore` ancestor warning missing from deliverables**: **Addressed** — added `lib/setup/gitignore.ts` deliverable and orchestrator integration.
- **`dist/server.js` smoke test missing**: **Addressed** — Phase 1's dispatch test now includes a built-path variant.

#### Claude — COMMENT
- **ESM import hoisting misconception**: Same as Gemini. **Addressed**.
- **`chmod 600` TOCTOU**: Same as Codex. **Addressed**.
- **`.gitignore` warning missing**: Same as Codex. **Addressed**.
- **Missing spec test scenarios 10, 11, 18, 24**: **Addressed** — added explicit coverage for scenarios 10, 11, 24 in the plan's test sections; scenario 18 kept in Phase 3 via mock `Io`.
- **Conditional next-steps reminder**: **Addressed** — output now conditional on `.mcp.json` action.
- **`mergeCiServer` signature drift**: **Addressed** — locked to `{ updated, action }`.
- **Dry-run blanket skip of `ghListHooks`**: **Addressed** — dry-run now calls the read-only `ghListHooks`.
- **`@inquirer/prompts` version pinning**: **Addressed** — requires exact pin.
- **Interactive Io created twice**: **Addressed** — single Io instance passed through.

### Implement → cli_dispatch (Phase 1, Round 1)

#### Gemini — APPROVE (after retry; first attempt returned empty)
- No concerns raised — "CLI dispatch and arg parsing scaffolding phase implemented flawlessly".

#### Codex — APPROVE
- No concerns — "matches the phase scope ... exact-match subcommand guard in place, phase-1 scaffold exists, parser covers the planned flag set, duplicate-flag policy, and TTY/`--yes` matrix".

#### Claude — APPROVE
- No concerns. Observed the canonical-form duplicate detection (`--yes` then `-y` flagged as duplicate) as a nice strictness beyond the plan's minimum.

### Implement → installer_core (Phase 2, Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Idempotent re-run still rewrites `state.json`**: **Addressed** — added `stateDiffers` helper; state write is now skipped entirely when the resolved state matches the read state. Test updated from `writeStateCalls === 1` to `=== 0` for the idempotent row.
- **`writeFileSync({ mode: 0o600 })` doesn't enforce 0o600 on existing files**: **Addressed** — explicit `chmodSync(path, 0o600)` after write, skipped on Windows. New regression test pre-creates the file with `0o644` and asserts `0o600` after run.

#### Claude — APPROVE with minor observations
- **Dead code in `orchestrator.ts` REDACTED delete branch**: **Addressed** incidentally when the state-write restructure for Codex issue 1 removed the whole block.
- **`skipped_exists` log could show current value**: **N/A** — kept current brief wording; opening the file directly is a cleaner UX.
- **Phase 2 scope guard** (non-`--yes` throws "not yet implemented"): **N/A** — intentional scope guard for Phase 2; removed in Phase 3 as planned.

### Implement → interactive_prompts (Phase 3, Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **Non-TTY + `--repo` + no `--yes` doesn't fail fast**: **Addressed** — lifted the TTY check out of the `repoRaw === null` branch so it applies whenever `!yes`. Two new regression tests added. Expanded matrix comment documents all 8 cells.

#### Claude — APPROVE with minor observations
- **`input()` doesn't trim whitespace**: **N/A** — regex catches trailing/leading spaces and re-prompt loop handles it.
- **`--smee-url` override's interactive confirmation flow not explicitly tested**: **N/A** — covered transitively through orchestrator tests; the override path doesn't touch confirm prompts (it happens inside `resolveSmeeUrl` which runs before the smee-provision prompt, and the prompt only fires for fresh provisioning).
- **Optional subprocess integration test with scripted `y\\n`**: **N/A** — plan explicitly marked as optional due to flakiness.

### Implement → documentation (Phase 4, Round 1)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — REQUEST_CHANGES
- **`AGENTS.md` + `CLAUDE.md` say `stdin: 'ignore'` as an absolute rule**: **Addressed** — rewrote to describe the real invariant ("don't inherit `process.stdin`") with both the ignore and pipe patterns as valid. `arch.md` Security Model entry aligned.
- **README says `.env` "auto-generated on first run"** in per-forge sections: **Addressed** — rewrote the State bullet in GitHub, GitLab, and Gitea sections to correctly describe state.json as auto-provisioned and `.env` as user-managed only.
- **Broken `#zero-config-quick-start` anchors**: **Addressed** — replaced with `#installation`; rewrote the "step 4" reference to point at `ci-channel setup` or `INSTALL.md`.
- **`arch.md` describes `~/.claude/channels/ci/` as canonical**: **Addressed** — Configuration and Bootstrap sections updated to show project-local as primary with legacy global as fallback.

#### Claude — COMMENT
- **Broken anchors**: Same as Codex. **Addressed**.
- **Stale test count (173 tests, 12 files)**: **Addressed** — updated to `291 tests across 19 files`.
- **`stdin: 'ignore'` rule**: Same as Codex. **Addressed**.
- **Optional: README install section could note `setup` doesn't write `.env`**: **Addressed** via the per-forge section rewrites (which now explicitly say "The installer does **not** write `.env`").

## Flaky Tests

No flaky tests encountered during this project. All 291 tests pass deterministically on every run locally. The pre-existing `stdio-lifecycle.test.ts` test (which spawns a real server subprocess and exercises the full webhook pipeline) continues to pass.

## Follow-up Items

- **GitLab/Gitea `setup` support** — Out of scope for v1. A follow-up spec should extend the installer to provision webhooks via `glab` for GitLab and the Gitea API for Gitea, reusing the existing `fetchSmeeChannel`, `state.ts`, and `mcp-json.ts` modules. The forge-specific code would live in new files under `lib/setup/` (e.g., `lib/setup/glab.ts`, `lib/setup/gitea-api.ts`).
- **`--rotate` flag** — Explicitly deferred from v1. Rotation would let a user regenerate the secret and update the existing webhook in place.
- **E2E validation against `cluesmith/ci-channel` itself** — Once the PR merges, run `npx ci-channel setup --dry-run --repo cluesmith/ci-channel` inside this repo as a real-world smoke test. Spec 1 set the precedent of "we are our own first user."
- **Consider exposing `deps` on `runSetup`** — The current pattern exports `promptForRepo` from `lib/setup/index.ts` purely for testing. A cleaner shape is `runSetup(argv, deps?)` so the entire function can be tested with injected deps. Low priority; current tests are sufficient.
