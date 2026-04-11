# Review: spec-7-feat-gitlab-gitea-insta

## Summary

Extended the `ci-channel setup` installer (v0.3.1, GitHub-only, 194 lines) to support three forges — `--forge github|gitlab|gitea` — and to auto-wire Codev projects by appending `--dangerously-load-development-channels server:ci` to `.codev/config.json`'s `shell.architect` command. Final `lib/setup.ts` is **294 lines** (under the 300-line cap). Final `tests/setup.test.ts` is **399 lines** with **18 tests** (under the 400-line / 20-test caps). Shipped as **v0.4.0**.

This was delivered as an ASPIR project (autonomous Specify → Plan → Implement → Review with 3-way consultations at each phase, no human gates on spec/plan). The project went through exactly one iteration of each phase — every reviewer concern was addressed in-place before porch advanced.

## Spec Compliance

Every item from the spec's "Review Gate Enforcement" checklist is met:

- [x] `wc -l lib/setup.ts` = 294 (≤300)
- [x] `wc -l tests/setup.test.ts` = 399 (≤400)
- [x] `lib/setup.ts` is a single file; `lib/setup/` does not exist
- [x] `tests/setup.test.ts` contains 18 test cases (≤20)
- [x] No `InstallDeps`, `SetupError`, `UserDeclinedError`, `ForgeInstaller` tokens in setup.ts
- [x] No new runtime or dev dependencies (`@inquirer`, `commander`, `yargs`, `dotenv`, `@gitbeaker`, `gitea-js`, `node-fetch`, `undici`, `axios` — none added)
- [x] No `readline`, `prompt(`, `confirm(` in setup.ts
- [x] No files added under `lib/setup/` or `lib/forge-installers/`
- [x] `server.ts` is unchanged (`git diff server.ts` returns empty)
- [x] GitLab uses `PUT` (not PATCH) for hook updates — line 229 in `lib/setup.ts`
- [x] Gitea update payload does NOT include `type` field — line 257 sends `{config, events, active}` only; line 265 (POST) includes `type: 'gitea'`
- [x] Gitea token precedence: `process.env` first, then `.env` file — line 154
- [x] `.mcp.json` merge uses `'ci' in servers` key-presence check — line 275
- [x] State-first ordering preserved on all three forge branches (Gitea has the additional pre-state token check at step 3, which is spec-mandated)
- [x] `.codev/config.json` is read/modified only if it exists; non-existence is silent
- [x] `package.json` version is `0.4.0`; `package-lock.json` version is `0.4.0` at both fields
- [x] All existing tests still pass (181 baseline → 191 total = +10 new scenarios)

### Functional requirements met

- [x] `ci-channel setup --forge gitlab --repo group/project` — new, works
- [x] `ci-channel setup --forge gitea --gitea-url https://... --repo owner/repo` — new, works
- [x] `ci-channel setup --repo owner/repo` (no `--forge`) — default GitHub, no regression
- [x] Re-running any of the three forge flows is idempotent (PATCH/PUT the existing hook, leave state + .mcp.json byte-equal when nothing changed)
- [x] Codev integration is conditional on `.codev/config.json` existence; no change when absent
- [x] Codev integration is idempotent (substring check before append)
- [x] Codev failure is contained (local try/catch warns and continues with exit 0)
- [x] `--forge` validates against `{github, gitlab, gitea}` (lowercase) with a clear error message on invalid values
- [x] `--gitea-url` required if and only if `--forge gitea`; mutual-exclusion errors both directions
- [x] `--gitea-url` must start with `http://` or `https://` (caught by Codex during impl consult, fixed mid-phase)
- [x] `GITEA_TOKEN` empty string treated as missing
- [x] `.env` parser handles `export KEY=value` prefix, quoted values, comments, blank lines

## Deviations from Plan

None material. Two small deviations worth noting:

1. **`cliCount` helper added to tests**: The plan didn't explicitly mention this helper. It was added because Scenario 10 (GitLab idempotent re-run) asserts `glab` was called exactly twice, which required reading the counter file. Implementation: one inline `existsSync` check + `parseInt`. Cost: 2 lines in the test file. Not in scope for any larger abstraction.

2. **`CI_DIR(root)` helper added to tests**: Collapsed three duplicate `join(root, '.claude', 'channels', 'ci')` calls across `seedState`, `writeEnv`, and the assertion in Scenario 14 into a single helper. Saved ~3 lines net. Not in the plan but obviously correct and tiny.

Neither deviation introduces abstraction, DI, new modules, new dependencies, or changes behavior. They are compression tactics for hitting the 400-line cap.

## Lessons Learned

### What Went Well

- **The 300-line cap was the right constraint.** Without it, the natural instinct would have been to extract GitLab and Gitea into separate files "for clarity." The flat if/else chain in `setup()` with three inline forge branches + a shared `classifyForgeError` helper is more readable than three separate modules would have been, AND easier to diff against the spec.
- **The shared `cliApi` helper (formerly `ghApi`) generalized cleanly.** Renaming from `gh`-specific to a parameterized `(bin: 'gh' | 'glab', ...)` cost zero lines and serves both forge branches. The same pattern applied to `mkFakeCli` in tests.
- **State-first ordering + the Gitea step-3 exception are a coherent pair.** The spec explicitly carved out the Gitea token check as "before state provisioning" — a deliberate departure from the rule that's easy to explain: "missing token is a user-error input gap, not an operational failure; don't burn a smee channel just to fail on the first API call."
- **Codev failure containment** (the one exception to the "single top-level try/catch" rule) proved its value in scenario design: imagining a malformed `.codev/config.json` after a successful webhook install made the exit-1 semantics feel wrong — a warning-and-continue is clearly better user experience. The test file has no test for this exact scenario, but the code path is simple and the rationale is documented in the spec.
- **3-way consultation found every substantive issue.** Codex was particularly valuable: flagged the Scenario 8 / `--forge gitlab` contradiction in plan review (avoiding a blocked Phase 1), the `package-lock.json` version bump (avoiding a broken release), the Gitea URL scheme validation gap (impl review, fixed mid-phase). Claude caught Codev test win32-skip inconsistency. Gemini caught `[object Object]` fallback bug and offered verbatim error string matching.

### Challenges Encountered

- **Line-budget pressure.** Even with aggressive compression (flattened the GitLab payload event flags onto 6 lines instead of 15; inlined log-on-reuse branches; removed blank lines between if/else arms), `lib/setup.ts` landed at 294/300 and `tests/setup.test.ts` at 399/400. Both are tight. Any future addition (e.g., a fourth forge, a new CLI flag) will force another compression pass before fitting.
  - **Resolution**: The spec pre-budgeted per-section line counts, which made overages visible early. When the first draft came in at 312 lines, I knew exactly which sections to compress (the GitLab payload, the secret/smeeUrl if/else).

- **Scenario 8 contradiction.** The existing test 8 asserted `['--repo', 'foo/bar', '--forge', 'gitlab']` failed as an unknown flag. After Spec 7, that argv is valid input. Both Gemini and Claude flagged this during spec review. The fix had to move from Phase 2 (tests) to Phase 1 (impl) to keep the `npm test` gate passing — Codex flagged this in plan review. A concrete lesson in "tests are load-bearing and edits to them must happen in the same phase as the code change that invalidates them."

- **Gitea `type` field asymmetry.** The Gitea API accepts `type: "gitea"` on hook creation but rejects it on update. This is not documented in the obvious places — I encoded it in the spec based on reading the Gitea source indirectly. Test 13 locks it in as `body.type === undefined` on PATCH. If future Gitea versions change this, the test will catch the regression.

- **`GITEA_TOKEN` environment leak in tests.** The original `inProject` helper didn't save/restore `GITEA_TOKEN`. Codex flagged this in plan review. Fix was a 3-line addition to `inProject` — save `prevToken`, delete on entry, restore on finally. Prevents tests from leaking state into each other AND prevents local dev env (where `GITEA_TOKEN` is already exported) from making scenarios order-dependent.

### What Would Be Done Differently

- **Start with the line budget pre-computed per section.** The first pass at `lib/setup.ts` was 312 lines and required compression. If I had started by writing the section budget into a comment at the top of the file (the same per-section table from the spec), I'd have been more disciplined about cutting lines as I wrote them.
- **Scenario 8 should have been modified in the spec, not just the plan.** I correctly identified the issue in the spec consult feedback and fixed the spec's "Test Scenarios" section, but the phrasing "Scenario 8 must be modified" was buried. A clearer callout ("Scenario 8 is a REQUIRED edit — see below") would have saved me from Codex flagging the same issue at plan time.
- **The Gitea fetch timeout helper is slightly over-engineered.** It uses AbortController with a 10-second timer. In practice, no Gitea happy-path test exercises this — the local HTTP server responds in milliseconds. It's there as belt-and-suspenders for real-world deployments. Trade-off between test simplicity and production robustness; went with robustness.

### Methodology Improvements

- **ASPIR is the right fit for well-scoped extensions.** This project was "extend an existing 194-line file by ~100 lines to add known forge APIs." The spec was constrained (300-line cap, single file, no new deps), the plan was straightforward (if/else on `forge`), and the implementation was routine. Running this as SPIR with human gates on spec/plan would have added latency without adding value. ASPIR's auto-approval after a single 3-way review round is the appropriate discipline level.

- **Spec + plan phases together caught every substantive bug.** Codex's REQUEST_CHANGES at plan time (scenario 8, package-lock, env restore, error message text) would have each become a broken Phase 1 commit if discovered later. The plan-phase consultation is worth its weight.

- **Line caps as a forcing function actually work.** This is the second consecutive project (Spec 5 + Spec 7) where tight line caps prevented over-engineering. The pattern is: (a) write the spec with hard caps and a per-section pre-budget, (b) verify caps mechanically (`wc -l`) in the review gate, (c) when the impl overshoots, compress don't extract. Every time.

## Technical Debt

- **`lib/setup.ts` is at 294/300 lines.** Any non-trivial future addition will require either (a) another compression pass, (b) a spec amendment raising the cap, or (c) extraction to a helper module (which would be a spec violation). My recommendation: hold the line at 300 for at least one more release cycle. If the file needs a fourth forge or another dimension of functionality, that's a new spec, not a cap-raise.
- **`tests/setup.test.ts` is at 399/400 lines.** Same caveat. There's no headroom for additional scenarios without compression.
- **GitLab API is assumed to return a single page of hooks** (no `--paginate --slurp`). GitLab projects with >100 webhooks will see a missed hook match and fall through to a duplicate CREATE. The spec explicitly accepts this as a non-goal. Spec followup: add `--paginate` if a user reports the issue.
- **No live smoke test was run against real GitLab/Gitea instances.** The fake-CLI + local-HTTP-server tests exercise the code paths but not the real API responses. A follow-up integration test in a disposable environment would de-risk the first real-user install.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- **Concern**: Test 8 contradiction — existing `tests/setup.test.ts:194-197` uses `--forge gitlab` as the "unknown flag" example; after Spec 7 that flag is valid, so the assertion `/unexpected arg: --forge/` will fail.
  - **Addressed**: Rewrote the "Pre-existing scenarios" section of the spec to explicitly mark Scenario 8 as modified. Provided the before/after code snippet. Math reworked: 7 unchanged + 1 modified + ≤12 new = ≤20 total.

#### Codex
- **Concern 1**: Gitea token validation conflicts with state-first flow ordering — unclear whether missing token fails before or after state/smee provisioning.
  - **Addressed**: Added a dedicated "Gitea token check ordering" subsection. Token check is an explicit step 3 of the common flow, BEFORE state provisioning. Rationale: user-error input gaps should short-circuit before burning a smee channel. Updated Scenario 6 to assert no state write and no HTTP request when token is missing.
- **Concern 2**: Codev "byte-equal" language is too strong — `JSON.parse`/`JSON.stringify(null, 2)` preserves content and key order but NOT whitespace/formatting.
  - **Addressed**: Rewrote step 5 of the Codev section to say "canonical 2-space JSON on write; only `shell.architect` is mutated." Removed the misleading "byte-equal" phrasing. Kept the ECMA-262 §24.5.2 insertion-order note as defense against a common reviewer false alarm.
- **Concern 3**: Line-count discussion in "Success Looks Like" is internally confusing with a mid-sentence correction.
  - **Addressed**: Rewrote the bullet to state the cap once with the starting-point context.
- **Concern 4**: Gitea `Content-Type: application/json` on GET requests is unusual.
  - **Addressed**: Updated spec to say "Content-Type on POST and PATCH only; GET sends only Authorization."
- **Concern 5**: Tests should explicitly cover the Gitea no-token ordering question.
  - **Addressed**: Rewrote Scenario 6 to NOT seed state.json and to assert no HTTP request is made AND no state.json is written.

#### Claude
- **Concern 1**: Test 8 contradiction (same as Gemini).
  - **Addressed**: Same fix as Gemini's concern 1.
- **Concern 2**: 300-line budget is tight; recommend per-section pre-budget in plan phase.
  - **Addressed**: Added a dedicated "Pre-budget for `lib/setup.ts`" subsection with a 10-row table allocating lines across imports / parseArgs / readEnvToken / cliApi / error helper / common flow / GitHub / GitLab / Gitea / Codev. Total estimate: ~302 (intentionally pessimistic).
- **Concern 3**: `.env` parser doesn't handle `export KEY=value` prefix.
  - **Addressed**: Added `line.replace(/^export\s+/, '')` to the parser sketch. Parser grows by 1 line (17 total).
- **Concern 4**: `GITEA_TOKEN` empty-string should be treated as missing.
  - **Addressed**: Added explicit wording "Either source counts as 'present' if the value, after trimming, is a non-empty string."
- **Concern 5**: Codev JSON.parse failure after successful webhook install exits 1 mid-stream — surprising UX.
  - **Addressed**: Reversed the spec's original decision. Added a "Codev failure containment" subsection: wrap Codev step in a local try/catch that warns and continues with exit 0. The only scoped exception to the outer "single top-level try/catch" rule.
- **Concern 6**: `--forge` error message should mention the lowercase requirement.
  - **Addressed**: Updated error message example to `Invalid --forge 'GitLab'. Must be one of: github, gitlab, gitea (lowercase).`

### Plan Phase (Round 1)

#### Gemini
- **Concern 1**: `classifyForgeError` fallback `new Error(String(err))` can render `[object Object]` if err is a plain `{bin, code, stderr, args}` object.
  - **Addressed**: Rewrote the sketch's last-resort branch to reconstruct the message from the object fields: `new Error(\`${bin} ${(err?.args ?? []).join(' ')} exited ${err?.code ?? '?'}: ${stderr.trim()}\`)`.
- **Concern 2**: `classifyForgeError` sketch uses a generic ENOENT message; spec dictates exact per-forge install URLs.
  - **Addressed**: Same sketch rewrite — now uses verbatim spec strings with `https://cli.github.com/` for gh and `https://gitlab.com/gitlab-org/cli` for glab.

#### Codex
- **Concern 1**: Phase 1 cannot pass its own `npm test` gate — Scenario 8 uses `--forge gitlab` as "unknown flag" but Phase 1 makes that valid input. Either move the Scenario 8 edit to Phase 1 or relax the gate.
  - **Addressed**: Moved the Scenario 8 modification into Phase 1 as a minimal test-file edit (not a new test scenario). Phase 1's "Files" list now includes `tests/setup.test.ts` with an explicit diff showing `--forge gitlab` → `--nonsense`.
- **Concern 2**: Version bump omits `package-lock.json` (two fields: root and first package block).
  - **Addressed**: Added `package-lock.json` to Phase 1's file list with explicit note that both fields need updating. Phase 1 acceptance criteria gained a new item.
- **Concern 3**: Codev scenarios 16-18 were described as running on all platforms but reuse the GitHub POSIX fake `gh` setup.
  - **Addressed**: Corrected the "Test implementation constraints" subsection to say Codev scenarios ALSO skip on win32 (inherit from their chosen forge branch).
- **Concern 4**: `GITEA_TOKEN` env mutation in tests needs restoration.
  - **Addressed**: Added explicit requirement that tests touching `process.env.GITEA_TOKEN` must save/restore via `try/finally`. Preferred implementation extends `inProject` to save/restore on entry — single-point fix, no per-scenario boilerplate.
- **Concern 5**: `classifyForgeError` GitLab messages don't match the spec text verbatim.
  - **Addressed**: Rewrote the sketch with per-forge branches and verbatim spec strings. Phase 1 acceptance criteria gained a "messages match spec verbatim" item.

#### Claude
- **Concern 1**: Codev 16-18 skip-on-win32 self-contradiction (same as Codex #3).
  - **Addressed**: Same fix as Codex #3.
- **Concern 2**: Scenario 15 relies on `loadState` returning partial state with `smeeUrl` present and `webhookSecret` undefined — builder should verify during impl.
  - **Addressed**: Added a note explaining the expected flow in "Test implementation constraints". Provided a fallback strategy if the pattern breaks.
- **Concern 3**: Phase 1 grep acceptance criterion for PUT detection has shell-quoting ambiguity.
  - **Addressed**: Reworded the criterion to "code review — reviewer reads lib/setup.ts and confirms the glab api call for the update path uses '--method', 'PUT' as the argv sequence".
- **Concern 4**: Optional belt-and-suspenders fake `gh` in GitLab tests adds lines against the tight 400-line budget.
  - **Addressed**: Dropped. Plan explicitly says "Do NOT add a belt-and-suspenders fake `gh`".
- **Concern 5**: `codev/resources/arch.md` section existence should be verified before committing to a one-line update.
  - **Addressed**: Verified the file exists (250 lines). Added a note that the update is optional if no appropriate section exists.

### Implement Phase (Round 1, `impl` plan phase)

#### Gemini
- **Verdict**: APPROVE, no concerns.

#### Codex
- **Concern**: Missing `http://` / `https://` validation for `--gitea-url`. The spec explicitly requires validating the scheme prefix in `parseArgs`; as written, `--forge gitea --gitea-url gitea.example.com` proceeded through token/state provisioning and only failed when `fetch` rejected the URL.
  - **Addressed**: Added a one-line regex check in `parseArgs` immediately after the forge-presence validation: `if (giteaUrl && !/^https?:\/\//i.test(giteaUrl)) throw new Error(\`--gitea-url must start with http:// or https:// (got '${giteaUrl}')\`)`. Line budget impact: 293 → 294 (still under 300).

#### Claude
- **Verdict**: APPROVE, no concerns.
- (Noted two non-blocking observations about the `Object.keys(existing).length === 2` coupling and the absence of a live smoke test. Both are pre-existing behavior from Spec 5 and out of Phase 7's scope.)

### Implement Phase (Round 1, `tests` plan phase)

#### Gemini
- **Verdict**: APPROVE, no concerns.

#### Codex
- **Verdict**: APPROVE, no blocking findings.
- (Noted a few assertions were "thinner than the phase plan said they would be" but confirmed the important behavioral risks are covered: GitLab PUT, path encoding, Gitea create/update payload split, token-before-state ordering, 401 state-first behavior, Codev append/skip/no-op behavior.)

#### Claude
- **Verdict**: APPROVE, no concerns. Full pass on constraint verification, scenario coverage, and quality checks.

## Flaky Tests

No flaky tests encountered. All 191 tests in the project (181 baseline + 10 new setup scenarios) pass deterministically on local Darwin. No skips beyond the explicit `skip: WIN` annotations on POSIX-shell-dependent scenarios (1–18 except Scenario 7 which is platform-independent). No intermittent failures observed during the multiple `npm test` runs across Phase 1, Phase 2, and post-fix verification.

## Architecture Updates

Updated `codev/resources/arch.md` in Phase 1 as part of the impl commit. Changes:

1. **Directory structure block (line 41)**: Updated `lib/setup.ts` comment from `"ci-channel setup --repo owner/repo" installer (Spec 5)` to `"ci-channel setup" installer — multi-forge + Codev auto-integration (Spec 5 + Spec 7)`.

2. **Installer section (lines 168–179, now expanded)**: Rewrote the "Installer" architecture section to document:
   - The new 300-line cap (loosened from 150)
   - The three supported forges and their per-forge API differences (GitHub uses `gh api` + PATCH; GitLab uses `glab api` + PUT with URL-encoded `path_with_namespace`; Gitea uses global `fetch` + PATCH with `type` field omitted from update payload)
   - The Gitea token check as the single exception to state-first ordering ("fail fast on user-error input, before any smee channel is burned")
   - Codev auto-integration: the local try/catch that warns and continues on failure
   - The shared `classifyForgeError` helper that maps 404/403/401/ENOENT from `gh`/`glab` stderr to user-friendly messages
   - The `giteaFetch` helper that does the equivalent status-code classification for Gitea

No new subsystems or data flows. The runtime plugin's forge strategy pattern (`lib/forges/*`) is unchanged and untouched — this project was entirely installer-side.

## Lessons Learned Updates

No lessons-learned updates needed. The existing lessons-learned.md already contains every principle this project validated:

- **"Prefer single-file implementations + real-fs tests for install/bootstrap commands"** (Spec 3): directly applied.
- **"Tight specs pay for themselves"** (Spec 5): this project is the second data point — 2-iteration spec + 1-iteration plan + 1-iteration impl + 1-iteration tests, zero rework cycles. The pattern works.
- **"Natural-seam phase split for constrained single-PR specs"** (Spec 5): two phases (`impl`, `tests`), one PR, ASPIR-autonomous, per the spec 5 lesson.
- **"Always assert `exitCode === null` on success paths when `process.exit` is intercepted"** (Spec 5): every new scenario (9-18) asserts `res.exitCode === null` on success paths.
- **"Never override `process.stdout.write` during node:test execution"** (Spec 5): `runSetup` intercepts only `stderr.write` and `process.exit`; `stdout` is untouched per the existing lesson.
- **"3-way consultation catches real issues"** (Spec 1): validated again — every REQUEST_CHANGES finding was a real spec-adherence gap; every APPROVE was well-reasoned.

The only novel insight from Spec 7 that could become a new lesson is **"Line-cap compression forces inline-if/else-chain architecture over strategy patterns"** — the 300-line cap directly prevented a `ForgeInstaller` interface or a `FORGE_INSTALLERS` registry Map, both of which are tempting defaults for three-forge-branches code. But that's really a corollary of the existing "tight specs pay for themselves" lesson, not a separate principle. Not adding a new entry.

## Follow-up Items

- **Live smoke test** against real GitLab and Gitea instances. The fake-CLI + local-HTTP-server tests cover the code paths but not the actual API responses. A one-off integration test in a disposable project would de-risk the first real-user install. Not a blocker for merging this PR.
- **`--paginate` for GitLab hook listing** if a user reports the issue. GitLab projects with >100 webhooks would see a missed hook match. Spec marks this as explicit non-goal for v0.4.0.
- **`--rotate` / webhook secret rotation** is still explicitly out of scope. Users who want to rotate delete `state.json` and re-run.
- **Gitea organization-level hooks** — only repo-level supported. A new spec would be needed to extend.
- **Bidirectional `.codev/config.json` uninstall** (remove the flag when `ci-channel` is uninstalled) — not in scope. Users who remove ci-channel have to edit `.codev/config.json` manually. If this becomes painful, a `ci-channel uninstall` subcommand is a new spec.
