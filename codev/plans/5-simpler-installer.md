# Plan: `ci-channel setup` (Simpler Rebuild)

## Metadata
- **ID**: plan-2026-04-11-simpler-installer
- **Status**: draft
- **Specification**: codev/specs/5-simpler-installer.md
- **Created**: 2026-04-11

## Executive Summary

Implement `ci-channel setup --repo owner/repo` as a single-file TypeScript module (`lib/setup.ts`, ≤150 lines) plus a 5-line dispatch in `server.ts` and a single test file (`tests/setup.test.ts`, ≤200 lines, ≤8 tests). The spec explicitly forbids module splits, DI, class hierarchies, new dependencies, interactive prompts, and "skip if already correct" optimizations.

The spec's "one commit, one PR, not four phases" rule is a constraint on splitting the 150-line implementation into multiple small phases — it is NOT a ban on separating implementation from tests. This plan uses the single natural seam (implementation vs. tests) to satisfy porch's minimum-two-phases requirement while still producing exactly two commits and one PR.

**Phase 1** delivers a working installer: `lib/setup.ts` + `server.ts` dispatch + a manual smoke run. **Phase 2** adds the automated test suite (`tests/setup.test.ts`) using the PATH-override fake-`gh` strategy from the spec.

## Success Metrics

Copied from `codev/specs/5-simpler-installer.md`:

- [ ] `ci-channel setup --repo owner/repo` completes in under 10 seconds on a fresh project
- [ ] Re-running on the same project is idempotent (no duplicate webhooks, no errors)
- [ ] Works from any subdirectory of the target project
- [ ] `ci-channel` with no args still runs the MCP server (existing behavior preserved)
- [ ] All existing tests continue to pass (291 tests from main as of Spec 3 post-mortem; actual count verified before merge)
- [ ] `wc -l lib/setup.ts` ≤ 150
- [ ] `wc -l tests/setup.test.ts` ≤ 200
- [ ] `tests/setup.test.ts` contains ≤ 8 test cases
- [ ] `lib/setup.ts` is a single file; `lib/setup/` does not exist
- [ ] No new `package.json` dependencies
- [ ] No `types.ts`, `errors.ts`, `io.ts`, `orchestrator.ts`, `InstallDeps`, `SetupError`, `UserDeclinedError`, `readline`, `@inquirer`, `confirm`, or `prompt` anywhere in `lib/setup.ts` or `package.json`
- [ ] `server.ts` dispatch addition is ≤5 lines

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "impl", "title": "Implementation: lib/setup.ts + server.ts dispatch"},
    {"id": "tests", "title": "Automated tests: tests/setup.test.ts"}
  ]
}
```

## Phase Breakdown

### Phase 1: Implementation (`lib/setup.ts` + `server.ts` dispatch)

**Dependencies**: None

#### Objective

Produce a working `ci-channel setup --repo owner/repo` command that performs the five operations in the spec (generate secret, fetch smee URL, write state, create/update webhook, register `.mcp.json`) in ≤150 lines of a single file, plus a ≤5-line dispatch in `server.ts`.

#### Files

- **Create**: `lib/setup.ts` — the entire installer, hard cap 150 lines including imports and comments
- **Modify**: `server.ts` — add exactly the 5-line dispatch block from spec "Dispatch Integration" section

No other files touched.

#### Implementation Sketch

`lib/setup.ts` structure (line budget is illustrative, not binding — total must stay ≤150):

```
imports from node:fs, node:path, node:child_process, node:crypto           ~6 lines
imports from ./project-root.js, ./state.js, ./bootstrap.js                 ~3 lines
constants: canonical .mcp.json ci entry, canonical webhook payload builder ~8 lines
parseArgs(args: string[]): { repo: string }                                ~12 lines
  - minimal loop / --repo extraction
  - throws 'Usage: ci-channel setup --repo owner/repo' when missing
ghApi(args: string[], stdinBody: string | null): Promise<string>           ~22 lines
  - wraps spawn('gh', args) with stdio ['pipe', 'pipe', 'pipe']
  - writes stdinBody to child.stdin if provided, then ends
  - collects stdout, rejects on non-zero exit with stderr in message
export async function setup(argv: string[]): Promise<void>                 ~75 lines
  try {
    const { repo } = parseArgs(argv)
    const root = findProjectRoot(); if (!root) throw Error('No project root')
    const statePath = join(root, '.claude', 'channels', 'ci', 'state.json')
    const existing = loadState(statePath)
    const secret = existing.webhookSecret ?? randomBytes(32).toString('hex')
    let smeeUrl = existing.smeeUrl
    if (!smeeUrl) {
      smeeUrl = await fetchSmeeChannel()
      if (!smeeUrl) throw Error('Failed to provision smee.io channel')
    }
    const desired = { webhookSecret: secret, smeeUrl }
    if (!deepEqual(existing, desired)) {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(desired, null, 2) + '\n', { mode: 0o600 })
    }
    const listOut = await ghApi(['api', '--paginate', '--slurp', `repos/${repo}/hooks`], null)
    const hooks = JSON.parse(listOut).flat()
    const existingHook = hooks.find((h: any) => h?.config?.url === smeeUrl)
    const payload = JSON.stringify({ config: { url: smeeUrl, content_type: 'json', secret }, events: ['workflow_run'], active: true })
    if (existingHook) {
      await ghApi(['api', '--method', 'PATCH', `repos/${repo}/hooks/${existingHook.id}`, '--input', '-'], payload)
    } else {
      await ghApi(['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'], payload)
    }
    const mcpPath = join(root, '.mcp.json')
    const mcp = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf-8')) : {}
    if (!mcp.mcpServers?.ci) {
      mcp.mcpServers = { ...(mcp.mcpServers ?? {}), ci: { command: 'npx', args: ['-y', 'ci-channel'] } }
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
    }
    console.log('Done. Launch Claude Code with `claude --dangerously-load-development-channels server:ci`.')
  } catch (err) {
    console.error(`[ci-channel] setup failed: ${(err as Error).message}`)
    process.exit(1)
  }
deepEqual(a, b) helper — use JSON.stringify with sorted keys, OR rely on only two fields (webhookSecret, smeeUrl) and compare directly. Prefer direct compare to avoid a sort helper. ~8 lines
```

Total: ≈134 lines with blank lines and light comments. Safely under the 150-line cap with headroom for formatting.

**`server.ts` dispatch** (exact block from spec, inserted after the existing imports and before `loadConfig()`):

```typescript
if (process.argv[2] === 'setup') {
  const { setup } = await import('./lib/setup.js')
  await setup(process.argv.slice(3))
  process.exit(0)
}
```

5 lines. No change to existing behavior when `argv[2]` is anything else.

#### Acceptance Criteria

- [ ] `wc -l lib/setup.ts` reports ≤ 150
- [ ] `git diff server.ts | grep '^+' | wc -l` reports ≤ 5 net added lines (the dispatch block)
- [ ] `ls lib/setup/` fails (directory does not exist)
- [ ] `grep -E 'InstallDeps|SetupError|UserDeclinedError|readline|@inquirer|confirm\(|prompt\(' lib/setup.ts` returns nothing
- [ ] `grep '"@inquirer' package.json` returns nothing
- [ ] `npm run build` succeeds (TypeScript compiles; `dist/server.js` is produced and chmod'd)
- [ ] Manual smoke: in a throwaway temp directory with `.git/`, `gh auth status` passing, and a disposable repo, run `npx tsx server.ts setup --repo <disposable/repo>` → expect state.json + .mcp.json + a webhook created on the disposable repo. Then run again → expect the same exit code, `gh api` PATCH invoked, .mcp.json untouched. (This is a sanity check, not part of the automated suite.)
- [ ] All 291 existing tests pass (`npm test`). Baseline count verified against `main` before committing.

#### Test Plan

Phase 1 produces no automated tests. The TypeScript compiler + existing test suite is the regression gate. The manual smoke run above is evidence the command works end-to-end; its details are recorded in the commit message. Full automated coverage comes in Phase 2.

#### Rollback Strategy

Revert the Phase 1 commit. `server.ts` returns to its current state; `lib/setup.ts` disappears. No migrations, no schema changes, no external state to unwind.

#### Risks

- **Risk**: Line budget overshoot. The sketch projects ~134 lines but formatting choices (Prettier width, comment blocks, trailing commas) can push it over 150.
  - **Mitigation**: Check `wc -l lib/setup.ts` before each commit. If over cap, tighten by removing redundant destructures, collapsing single-use helpers, or shortening error messages. Do NOT extract to a second file.
- **Risk**: `gh api --paginate --slurp` output shape surprises. If `gh` versions differ, the array-of-arrays shape could be an array-of-objects on some setups.
  - **Mitigation**: Spec fixes `gh` ≥ 2.29. `.flat()` on an already-flat array is a no-op, so the code is safe in either shape. Document the `gh` version requirement in the commit message.
- **Risk**: Top-level `await` in `server.ts` breaks some build path.
  - **Mitigation**: `tsconfig.json` is `target: ES2022`, `module: NodeNext`; TLA is supported. Verify with `npm run build` and by running the compiled `dist/server.js`.
- **Risk**: `fetchSmeeChannel` makes a live network call during manual smoke. If smee.io is down, manual smoke fails.
  - **Mitigation**: The automated tests in Phase 2 do not depend on smee.io (they prepopulate state.json). The manual smoke is a belt-and-suspenders check, not required for commit.

---

### Phase 2: Automated tests (`tests/setup.test.ts`)

**Dependencies**: Phase 1 (committed)

#### Objective

Produce `tests/setup.test.ts` with the 8 scenarios from the spec, using the PATH-override fake-`gh` strategy and state.json prepopulation (no `globalThis.fetch` stubbing). Hard cap 200 lines, ≤8 tests.

#### Files

- **Create**: `tests/setup.test.ts` — the entire test suite, hard cap 200 lines, ≤8 `test(...)` calls

No other files touched. In particular, no `lib/setup.ts` modifications "for testability."

#### Test Helpers (inline in `tests/setup.test.ts`, NOT in a separate helpers file)

The test file contains two small helpers defined at the top, inside the same file, above the `describe`:

1. `mkFakeGh(dir, responses)` — writes an executable POSIX shell script to `<dir>/gh`. The script reads stdin, writes a JSON lines log to `<dir>/gh.log` (one entry per invocation with `argv` + `stdin`), and prints a canned response from the `responses` array (consumed in order). Each response is `{ stdout, exitCode }`. Implementation: the test pre-serializes responses into files inside `dir` (e.g., `<dir>/gh.response.1`, `<dir>/gh.response.2`) and the shell script reads the N-th file based on a counter in `<dir>/gh.counter`.
2. `withFakeGh(dir, fn)` — saves `process.env.PATH`, prepends `dir`, runs `fn()`, restores `PATH` in a `finally`.

Both helpers are ~20 lines total. They do not escape the file.

#### The 8 Scenarios (verbatim from spec)

1. **Happy path with prepopulated state**: seed state.json with fake `smeeUrl` + `webhookSecret`, no hook, no .mcp.json. Fake `gh`: list returns `[]`, POST succeeds. Assert: POST was called with the canonical payload containing the seeded secret + URL; .mcp.json was created with the canonical `ci` entry; state.json contents byte-equal to seed; state.json mode is `0o600` (skip on win32).
2. **Idempotent re-run**: seed state.json, seed .mcp.json with `mcpServers.ci` (canonical), fake `gh` list returns `[{ id: 42, config: { url: seed.smeeUrl } }]`, PATCH succeeds. Assert: PATCH was called exactly once on `/hooks/42` with the canonical payload; state.json byte-equal; .mcp.json byte-equal.
3. **State present, webhook missing**: seed state.json, seed .mcp.json with canonical `ci` entry, fake `gh` list returns `[]`, POST succeeds. Assert: POST called (not PATCH); state.json byte-equal; .mcp.json byte-equal.
4. **Re-run with existing .mcp.json that has other servers**: seed state.json, seed .mcp.json with `mcpServers: { other: { command: "foo" } }` (no `ci` key), fake `gh` list returns `[]`, POST succeeds. Assert: after setup, .mcp.json contains both `other` (byte-equal under `mcpServers.other`) and the canonical `ci` entry.
5. **CREATE failure (state-first ordering)**: seed state.json with `{ smeeUrl: "..." }` only (no secret), fake `gh` list returns `[]`, POST exits non-zero with stderr "API error". Catch the `process.exit(1)` via `t.mock.method(process, 'exit', ...)` or wrap the call in a try/catch that expects rejection. Assert: state.json on disk now contains both the original `smeeUrl` and a non-empty `webhookSecret` (proves the state write happened before the POST attempt).
6. **Project root from subdirectory**: mkdtemp, create `<tmp>/.git/`, create `<tmp>/src/foo/`, prepopulate `<tmp>/.claude/channels/ci/state.json`, `process.chdir(<tmp>/src/foo/)`, fake `gh` list returns `[]`, POST succeeds. Assert: `<tmp>/.mcp.json` exists with canonical entry. Restore `process.cwd()` in a `finally`.
7. **No project root**: mkdtemp, `process.chdir(tmp)` (no `.git`, no `.mcp.json`, no ancestors with either), call `setup(['--repo', 'foo/bar'])`. Assert: `process.exit(1)` called and stderr contains "project root".
8. **Missing `--repo`**: call `setup([])`. Assert: `process.exit(1)` called and stderr contains "--repo".

#### Implementation Details

- Use `node:test` — same as the rest of the suite (`tests/integration.test.ts`, `tests/reconcile.test.ts`, etc.). Import `{ describe, test, before, after }` and `assert` from `node:assert/strict`.
- Capture stderr/stdout by replacing `process.stderr.write` / `process.stdout.write` in a `before` hook and restoring in an `after` hook. Push writes to an array the tests can assert against.
- Intercept `process.exit` the same way — replace it with a function that throws a sentinel error, catch it in the test, then assert on the captured exit code. Restore in `after`.
- `mkdtempSync(join(tmpdir(), 'setup-test-'))` for each test's temp root. Clean up with `rmSync` in a `finally`.
- Skip Scenarios 1–6 when `process.platform === 'win32'` because the PATH-override fake `gh` is a POSIX shell script. Scenarios 7 and 8 are platform-independent and always run.

#### Acceptance Criteria

- [ ] `wc -l tests/setup.test.ts` reports ≤ 200
- [ ] `grep -cE '^ *(test|it)\(' tests/setup.test.ts` reports ≤ 8
- [ ] `npm test` passes (all 291 existing + 8 new = 299 tests, platform-dependent skips excluded)
- [ ] No files under `lib/setup/`
- [ ] No changes to `lib/setup.ts` relative to Phase 1 (the test suite does not require production-code tweaks)
- [ ] On unix CI, scenarios 1–6 run (not skipped); on win32 CI, scenarios 1–6 report as skipped

#### Test Plan

Phase 2 IS the test plan. Meta-validation:

- Run `node --import tsx/esm --test tests/setup.test.ts` to verify the new file runs in isolation
- Run `npm test` to verify no regressions in the existing suite
- On failure, read the captured stdout/stderr and gh.log from the temp dir of the failing scenario

#### Rollback Strategy

Revert the Phase 2 commit. `tests/setup.test.ts` disappears. Phase 1's implementation remains functional but untested by the new suite.

#### Risks

- **Risk**: Line budget overshoot (200 lines). Eight scenarios + helpers + setup/teardown is tight.
  - **Mitigation**: Extract the repetitive "mkdtemp + mkFakeGh + withFakeGh" sequence into a local helper `runSetupWithFakeGh({ state, hooks, responses, mcpJson })`. Keep scenario bodies to ~15 lines each. If still over cap, compress error-case scenarios (5, 7, 8) since their bodies are small.
- **Risk**: `process.exit` / `process.stderr.write` patching leaks between tests if an assertion throws before the restore runs.
  - **Mitigation**: Use `t.after` / `after` hooks rather than manual `try/finally`, so Node's test runner restores on failure. Alternatively wrap the core of each test in a try/finally that restores explicitly.
- **Risk**: Shell script permissions or `sh` availability fails on some unix CI images.
  - **Mitigation**: Use `#!/bin/sh` (POSIX) not `#!/bin/bash`. Set mode `0o755` when writing. On any failure, skip the test with a diagnostic naming the host platform so debugging is easy.
- **Risk**: Scenario 5's `process.exit(1)` assertion is brittle. If `setup()` refactors to throw instead of exit, the test breaks.
  - **Mitigation**: The spec mandates `process.exit(1)` in Required Behavior 10. Any refactor away from that is a spec violation; the brittle test is a feature, not a bug.

---

## Dependency Map

```
Phase 1 (impl) ──→ Phase 2 (tests)
```

Phase 2 strictly depends on Phase 1. Phase 2 cannot run in the absence of `lib/setup.ts`.

## Validation Checkpoints

1. **After Phase 1**: `npm run build` passes; `npx tsx server.ts setup --repo <disposable/repo>` end-to-end smoke passes against a throwaway repo; `wc -l lib/setup.ts` ≤ 150; all 291 existing tests still green.
2. **After Phase 2**: `npm test` passes with 8 new tests; `wc -l tests/setup.test.ts` ≤ 200; test count check passes; review-gate grep checklist from spec passes.
3. **Before PR merge**: Reviewer runs the full spec review-gate checklist (10 items in spec's "Review Gate Enforcement" section).

## Integration Points

- **External**: `gh` CLI ≥ 2.29 (user-provided, not a package dep). `gh auth status` must pass in the user's environment before running `ci-channel setup`.
- **External**: `smee.io` — `fetchSmeeChannel` reaches `https://smee.io/new` on first-run installs. Failure → `setup` exits non-zero. No retries.
- **Internal**: reuses `findProjectRoot` (`lib/project-root.ts`), `loadState` (`lib/state.ts`), `fetchSmeeChannel` (`lib/bootstrap.ts`). No changes to these modules.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Line budget overshoot on `lib/setup.ts` | Medium | High (spec violation → REQUEST_CHANGES) | Check `wc -l` before every commit; tighten by shortening identifiers, not by extracting helpers |
| Line budget overshoot on `tests/setup.test.ts` | Medium | Medium (not as strictly enforced but still a cap) | Extract `runSetupWithFakeGh` helper inside the test file; compress error-case scenarios |
| `process.exit` patching flakiness | Low | Medium (test instability) | Use `node:test`'s `after` hooks; avoid shared state between tests |
| `gh` unavailable on CI | Low | Low (tests use fake `gh` on PATH; real `gh` is not invoked) | n/a — fake `gh` via PATH override means real `gh` is never touched during tests |
| Spec-3-style review churn | Low | High (multiple iterations) | Spec is tight; plan respects every constraint; single natural seam (impl vs tests) for phases; no hidden fast paths; no DI; no new modules |

## What This Plan Does NOT Include

- No separate helpers module (`lib/setup-helpers.ts`, `lib/gh-wrapper.ts`, etc.)
- No new interface files (`lib/types.ts`, `lib/setup-types.ts`)
- No refactor of `lib/bootstrap.ts`, `lib/state.ts`, or `lib/project-root.ts`
- No changes to `package.json` (no new deps, no new scripts beyond what `npm test` already runs)
- No changes to `tsconfig.json`
- No CI workflow changes
- No README or INSTALL.md updates in Phase 1 or 2. (Docs are a Review-phase concern; if any user-visible behavior changes from what INSTALL.md already documents, the reviewer flags it. The spec says the command should produce the same end state as the manual 5-step process in INSTALL.md, so no user-visible doc changes are expected.)

## Expert Review

To be filled in after porch runs the 3-way consultation.

## Notes

- The 150-line cap is the MAXIMUM, not the minimum. If the implementation comes in at 120 lines, that is better. Do not pad.
- If during Phase 1 implementation it becomes clear a constraint is impossible to satisfy (e.g., 150 lines is unachievable because of a TypeScript type issue), STOP, write a clear blocker message, and notify the architect. Do not smuggle in helpers or workarounds.
- `codev/resources/lessons-learned.md` entry "Prefer single-file implementations + real-fs tests for install/bootstrap commands" is the authoritative post-mortem. Consult it when in doubt about any tradeoff.
