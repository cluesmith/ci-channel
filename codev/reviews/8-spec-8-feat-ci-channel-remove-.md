# Review: spec-8-feat-ci-channel-remove-

## Summary

Added a `ci-channel remove` subcommand that reverses what `ci-channel setup` did: deletes the forge webhook (matched by smee URL from state.json), deletes `state.json`, strips the canonical `ci` entry from `.mcp.json` (leaves non-canonical entries alone with a warning), and reverts the Codev integration if `.codev/config.json` contains the loader flag. All three forges (GitHub, GitLab, Gitea) are supported with the same flag shape as `setup`.

Ships as v0.5.0. `lib/setup.ts` grew from 300 → 396 lines (under the 400-line cap). `tests/setup.test.ts` grew from 399 → 580 lines with 10 new mandatory scenarios (R1–R10), for a total of 28 tests in the file and 201 tests across the full suite (baseline was 191).

## Spec Compliance

- [x] `ci-channel remove --repo owner/repo` (GitHub, default) fully reverses a prior setup — **R1 happy path** + second-run fail-fast assertion
- [x] `ci-channel remove --forge gitlab --repo group/project` — **R5 happy path**, encoded project path, DELETE call against `projects/group%2Fproject/hooks/77`
- [x] `ci-channel remove --forge gitea --gitea-url URL --repo owner/repo` — **R6 happy path**, GET+DELETE with `Authorization: token fake-token`
- [x] Missing state.json → fail fast with `no ci-channel install detected` — **R4** first sub-assertion
- [x] Malformed state.json / missing `smeeUrl` → fail fast with distinct error message — **R4** second sub-assertion, no forge call, no local mutations
- [x] Second run after successful remove → exit 1 (not idempotent exit-0) — **R1** second-run assertion
- [x] Non-canonical `.mcp.json` `ci` entry → leave alone, warn, still delete state + webhook — **R3**, assert round-trip equality of entry after remove
- [x] `.codev/config.json` with loader flag → strip flag + leading space, rewrite canonical JSON — **R8**
- [x] Webhook already deleted (no match in list) → log `no matching webhook found`, continue — **R2**
- [x] DELETE-404 race (webhook gone between list and delete) → soft handling, log `already deleted`, continue — **R9**
- [x] LIST-404 (repo not found) → hard failure via `classifyForgeError`, no local mutations — **R10**
- [x] For Gitea: `GITEA_TOKEN` precondition check before any HTTP call — **R7**, assert state.json still exists and no request received
- [x] `wc -l lib/setup.ts` ≤ 400 — **396** ✓
- [x] `wc -l tests/setup.test.ts` ≤ 600 — **580** ✓
- [x] `tests/setup.test.ts` contains ≤ 28 tests — **28 exactly** (18 setup + 10 remove)
- [x] `lib/setup.ts` is still a single file; `lib/remove.ts` and `lib/setup/` do not exist
- [x] No new runtime or dev dependencies
- [x] Ships as v0.5.0 (package.json + package-lock.json both fields)
- [x] `server.ts` dispatch ≤ 8 lines (5 actual) and still uses dynamic import
- [x] README / INSTALL / CLAUDE / AGENTS all document the `remove` command

## Deviations from Plan

- **Phase 1 tightening was more aggressive than projected**. The plan projected 400–410 lines pessimistically with 10 tightening levers; actual landing was **396** after the same levers plus compressing the existing `classifyForgeError` and `codevIntegrate` helpers into single-line conditional expressions. Those two existing-helper compressions were not in the original Phase 1 plan but were necessary to cross the 400 threshold. This is within Phase 1's "touch lib/setup.ts" scope — it's the same file — and was applied after the first compression pass landed at 421 lines and a second at 416.
- **Plan said 9 mandatory tests (R1–R9)**, spec iter2 said 10 (R1–R10 with R10 = LIST-404). I implemented 10 mandatory tests; the plan table also listed R10 (folding invalid-state into R4). The numbering is a bit confusing across spec iter1, spec iter2, and plan iter2 — the final state has R4 carrying the invalid-state sub-assertions and R10 being the LIST-404 test. This matches spec iter2 + plan iter2.

## Lessons Learned

### What Went Well

- **Spec + plan iteration fast convergence on the line budget.** The iter1 plan projected ~420 lines for `lib/setup.ts` and quickly hit reality: after the first naive implementation, I got 421 lines. The plan's "tightening commitments" section anticipated this and listed specific compression levers — I applied them methodically (biome-ignore comment trimming, one-line if/else chains for `classifyForgeError` and `codevIntegrate`, compact nested helper) and landed at 396 with a 4-line margin. Having the levers enumerated upfront meant no panic when the initial implementation was over budget.
- **3-way review caught factual errors in the plan**. The iter1 plan described `runRemove` as spawning `dist/server.js` and said `mkFakeCli` needed a "DELETE branch extension." Both Claude and Codex flagged these in their plan-phase reviews. Verifying against the actual tests/setup.test.ts source (lines 19–36 and 64–76) confirmed: `runSetup` is in-process, `mkFakeCli` is counter-based. The plan was revised before Phase 2 started, avoiding what would have been wasted implementation effort.
- **Strict full-array canonical check is cleaner than the partial-check tradeoff**. The spec iter1 draft had a confusing "why only args[0] and args[1]" rationale that Codex correctly flagged as contradictory. The iter2 rewrite to strict full-array equality with forge-specific expected args is simpler to implement, simpler to test, and correctly handles the "user customized" case. R3 (customized .mcp.json with extra `env` key) tests this directly.
- **The nested `cliDelete` helper pattern**. GitHub and GitLab have identical list-match-delete-with-404-soft shapes. A nested (not top-level) helper inside `remove()` shares the logic, captures `repo` + `smeeUrl` via closure, and reduces ~44 inline lines to ~28. Gitea differs enough (direct fetch for DELETE) that it stays inline — three branches, not a generic abstraction.
- **State.json as single source of truth**. The `state.json` precondition check is the entire "is ci-channel installed here?" question. Setup writes state before the webhook call; remove deletes state after the webhook call. Either failure leaves `state.json` present, so re-running is always safe. This inverts setup's "state-first" into remove's "state-last after network" but both point at the same invariant. Codex iter1 spec review's pushback on the idempotency wording ("pick one: idempotent exit-0 OR fail-fast exit-1") led to the cleaner framing.

### Challenges Encountered

- **Line budget was genuinely tight.** The spec author's pre-budget of 300→400 with ~100 lines for remove was optimistic. Detailed counting showed the honest naive implementation would land at ~447. The plan phase had to commit to specific compression levers upfront, not as a fallback. This included compressing pre-existing helpers (`classifyForgeError`, `codevIntegrate`) which was not in the iter1 plan sketch. The iter2 plan was more honest about the risk and set a specific escalation gate ("if >410 after all tightening, message architect"). In the end the final landing was 396, within 4 lines of the cap.
- **biome-ignore comments are line-expensive.** My first pass at `remove()` had 11 biome-ignore comments for `any` type usage (user-owned JSON, untyped API responses). Each comment is a dedicated line, so the first pass landed at 421 lines. Discovering biome isn't actually a dependency in this repo (`npm ls biome` returns empty) meant I could drop the comments I added without breaking anything. Existing biome-ignore comments in setup() remain as aspirational editor hints.
- **R9 (404-on-DELETE) vs R10 (404-on-LIST) easy to confuse**. Both tests use the same stderr text (`HTTP 404: Not Found`) but need different positional responses from `mkFakeCli`: R9 returns a hook on LIST[0] and 404 on DELETE[1], while R10 returns 404 on LIST[0]. The two tests are deliberately structured identically except for the response array to make the contrast obvious. Writing them consecutively helped lock in the distinction.
- **`mkFakeCli` nested-array vs flat-array response shapes**. GitHub's `gh api --paginate --slurp` returns a nested array (pages flattened via `.flat()`) while GitLab's `glab api` returns a flat array. Tests need to match: R1 seeds `[[{...}]]` for GitHub; R5 seeds `[{...}]` for GitLab. Plan iter2 explicitly called this out after Claude's iter1 plan review flagged it.

### What Would Be Done Differently

- **Spec the `lib/setup.ts` line budget by honest counting, not optimistic projection.** The spec iter1 "+100 lines for remove" was based on a ballpark estimate. A better approach: the spec phase should include a detailed section budget that counts sections explicitly (e.g., "parseCommandArgs: 26 lines; cliDelete helper: 22; GitHub call: 3; etc."). The plan iter2 had this level of detail; the spec could have saved one iteration by anticipating it.
- **Assertion string vs log string sync check should be automated or explicitly flagged at the spec phase**. R3 assertion originally said `is customized — leaving alone` (from the spec iter1 draft prose), but the actual `remove()` log line says `does not match the canonical shape for --forge ${forge}`. Claude iter1 plan review caught this. A better spec would have a "## Log strings" section that enumerates every log line verbatim so tests can match them exactly.
- **Consider skipping the `codevRevert` as a separate function from the start**. The iter1 plan proposed a top-level `codevRevert` helper mirroring `codevIntegrate`. The iter2 plan inlined it into `remove()`. For cap-sensitive single-file implementations, inlining small helpers into their one call site can save enough lines to matter. The rule of thumb: if a helper is called from exactly one place and is <30 lines, inlining saves ~5 lines of function boilerplate.

### Methodology Improvements

- **3-way review of the plan phase caught factual errors that would have wasted Phase 2 time**. Both Codex and Claude independently flagged that the plan misdescribed `runSetup` (calling it dist-based) and `mkFakeCli` (calling it method-dispatched). Without the plan-phase review, I would have written a broken `runRemove` helper that spawned `dist/server.js` and attempted to extend `mkFakeCli` with a nonexistent `DELETE branch`. The plan-phase 3-way review pays for itself when the plan makes factual claims about existing code.
- **Honest line-budget math matters more than aspirational math**. The iter1 plan said "save 18 lines via parseCommandArgs merge" but that was counted against a hypothetical duplicated `parseRemoveArgs` that never existed. The real savings was ~2 lines (renaming `parseArgs` to `parseCommandArgs` + adding a `command` param). Claude iter1 plan review caught this. Plan phase should always count from the actual current baseline, not from "hypothetical worst case."

## Technical Debt

- **The existing setup() body has 8 biome-ignore comments for `any` type usage** that I preserved (not touched). A future refactor could use `Record<string, unknown>` narrowing with type guards to drop these, but it's not load-bearing and would eat more lines than it saves.
- **The shared `cliDelete` nested helper captures `repo` and `smeeUrl` via closure**, which makes it slightly harder to unit-test in isolation (you can't call it without setting up a surrounding `remove()` scope). Not a problem in practice because it's only called from two places within remove() and both are tested via the full remove() path.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised — APPROVE. Gemini flagged three minor implementation notes for the plan/impl phases (giteaFetch 404 handling, classifyForgeError return type, loadState returning `{}` on missing). All captured in the 404-handling section of spec iter2.

#### Codex (REQUEST_CHANGES)
- **Concern**: Canonical `.mcp.json` rule was internally contradictory (described forge-specific args but only validated args[0]/args[1]).
  - **Addressed**: Rewrote the canonical-entry check section with strict full-array equality, forge-specific expected-args table, and a forge-mismatch example. Scenario R3 now tests the customized-entry-left-alone case.
- **Concern**: Idempotency contradiction — "Desired State" said re-run is idempotent (exit 0) but Success Criteria said second run fails fast (exit 1).
  - **Addressed**: Rewrote Desired State to explicitly say the second run exits 1, and added an "Idempotency" section opener explaining state.json is the single source of truth.
- **Concern**: `state.json` validity behavior under-specified (what if file exists but is malformed or missing `smeeUrl`).
  - **Addressed**: Expanded "Required vs optional preconditions" with three sub-cases (missing, malformed, missing smeeUrl). Added an explicit directive that implementation must NOT use `loadState()` for this check. Added a success-criteria bullet and a mandatory test (R4 folds these two sub-cases into one test).
- **Concern**: 404-on-LIST vs 404-on-DELETE ambiguous — one section said both are soft, another said list is hard.
  - **Addressed**: Added a dedicated "404 handling (disambiguated)" subsection. LIST 404 = hard fail via classifyForgeError; DELETE 404 = soft, log and continue. Added mandatory R9 (DELETE-404 race) and R10 (LIST-404 hard fail) tests.

#### Claude
- **Concern** (minor): R1 test response shape for `gh api --paginate --slurp` should be clarified as nested-array.
  - **Addressed**: R1 scenario now explicitly uses `[[{id:42, config:{url:smeeUrl}}]]` (nested) with a note explaining the shape.
- **Concern** (minor): `.mcp.json` with non-object `mcpServers` needs defensive handling.
  - **Addressed**: Added "Defensive shape handling" note requiring remove() to log and skip if `mcp.mcpServers` is not an object. Implementation checks `typeof servers !== 'object' || Array.isArray(servers)`.
- **Concern** (minor): `findProjectRoot()` null-return path not explicitly mentioned.
  - **Addressed**: Added a precondition bullet requiring remove() to mirror setup's "No project root found" error.
- **Concern** (minor): Order-of-operations paragraph had a confusing "Wait — that's backwards" self-correction.
  - **Addressed**: Rewrote the paragraph cleanly. The invariant is now stated once: "state.json exists iff the install is active on the local side."

### Plan Phase (Round 1)

#### Gemini
- No concerns raised — APPROVE. Gemini flagged positive observations about the parseCommandArgs merge, two-block try/catch pattern, and R4 collapse strategy as "smart tightening maneuvers."

#### Codex (REQUEST_CHANGES)
- **Concern**: R10 (invalid state.json) marked optional but is a mandatory spec criterion.
  - **Addressed**: R10 folded into R4 as two sub-assertions (missing-state + missing-smeeUrl) in one test. R4 is mandatory. A new separate R10 was added for LIST-404 hard fail (see Codex concern 3 below).
- **Concern**: Remove-twice not directly tested.
  - **Addressed**: R1 now folds in a second-run assertion. After the first runRemove succeeds, a second runRemove call asserts exit code 1 and `no ci-channel install detected` in stderr.
- **Concern**: 404-on-LIST hard failure not covered.
  - **Addressed**: Added R10 as a new mandatory test exercising LIST-404 → `Could not find repo` hard fail + state.json + .mcp.json untouched.
- **Concern**: `npm test` count assumption wrong (iter1 plan said "tests 18" as the baseline).
  - **Addressed**: Plan updated to say the full-suite baseline is 191 (not 18). Phase 1 records the actual baseline from `npm test 2>&1 | tail -5` as its first action. Phase 2 targets 201 (191 + 10).
- **Concern**: `runRemove` helper description calls `dist/server.js` but `runSetup` is in-process.
  - **Addressed**: Plan's "Factual corrections" section now explicitly documents that runSetup is in-process (tests/setup.test.ts:8 + 64–76). runRemove mirrors the in-process pattern. Helper sketch shows `import { setup, remove } from '../lib/setup.js'` plus a shared `runCommand(fn, argv)` refactor.

#### Claude (REQUEST_CHANGES)
- **Concern**: `runRemove` description claims `runSetup` spawns `dist/server.js` but `runSetup` imports setup in-process.
  - **Addressed**: Same fix as Codex concern 5 above. Plan explicitly describes the in-process pattern.
- **Concern**: `mkFakeCli` "DELETE branch extension" is misdiagnosed — the helper is counter-based, not method-dispatched.
  - **Addressed**: Plan's "Factual corrections" section explicitly says mkFakeCli is counter-based and no helper extension is needed. Tests seed `responses[0]` as LIST and `responses[1]` as DELETE in call order. **Net helper changes: zero.** Acceptance criterion added: "mkFakeCli, withGiteaServer, runSetup are unchanged — no extensions or modifications to existing helpers."
- **Concern**: R10 (invalid state.json) dropped but spec lists it as mandatory success criterion.
  - **Addressed**: Same fix as Codex concern 1 above — R10 folded into R4.
- **Concern**: 400-line cap landing is optimistic (projected 397, but honest count lands at 413–418).
  - **Addressed**: Added a new "Tightening commitments" section with 10 specific line-saving levers, a line-by-line budget table, and a **Phase 1 escalation gate** that stops work at >410 lines. Real landing after implementation was 396 (under 400 by 4 lines).
- **Concern**: R3 assertion string (`is customized — leaving alone`) doesn't match the actual log string in the remove() sketch (`does not match the canonical shape for --forge ...`).
  - **Addressed**: Plan's R3 row updated to use the actual log line. Implementation confirms remove() emits the longer phrasing.

### Implement Phase — Plan Phase "impl" (Round 1)

#### Gemini
- No concerns raised — APPROVE (HIGH). Gemini noted Phase 1 was "exceptionally thorough" and landed at 344 lines (actually 396 — Gemini may have been looking at a file snapshot before the final tightening). Minor informational observation: `codev/resources/arch.md` wasn't updated. The spec explicitly flagged that update as "optional — Not required."

#### Codex
- No concerns raised — APPROVE (HIGH). Non-blocking note: `codev/resources/arch.md`, CLAUDE.md, and AGENTS.md still described lib/setup.ts as "≤300 lines" in stale wording. Addressed in Review phase: arch.md was updated to say "≤400 lines" and mention the Spec 8 remove() addition.

#### Claude
- No concerns raised — APPROVE (HIGH). Confirmed all hard constraints met: lib/setup.ts 396/400 lines, server.ts dispatch 5/8 lines, 191/191 existing tests pass, spec compliance on ordering/preconditions/404 disambiguation/canonical check/Codev revert.

### Implement Phase — Plan Phase "tests" (Round 1)

#### Gemini
- No concerns raised — APPROVE (HIGH).

#### Codex
- No concerns raised — APPROVE (HIGH).

#### Claude
- No concerns raised — APPROVE (HIGH). Confirmed 10 new scenarios R1–R10 present, file at 580/600 lines, 28/28 tests in file, 201/201 full suite pass.

## Architecture Updates

Updated `codev/resources/arch.md`:

1. **File tree line** (line 41): `lib/setup.ts` description now mentions `ci-channel setup` + `remove` + "multi-forge installer/uninstaller" + "(Spec 5 + Spec 7 + Spec 8)".
2. **Test file line** (line 54): `tests/setup.test.ts` now says "28 scenarios total: 18 setup + 10 remove" instead of "8 scenarios, PATH-override fake gh."
3. **Installer section heading** (line 168): renamed "Installer (`lib/setup.ts`)" to "Installer/Uninstaller (`lib/setup.ts`)".
4. **Installer purpose paragraph** (line 170): updated to say "400-line implementation (Spec 8 raised the cap from Spec 7's 300)" and mention both `setup()` and `remove()` as exports.
5. **Dispatch + remove() description** (lines 186–194): extended the Dispatch paragraph to mention the new `remove` match, then added four new paragraphs:
   - **Uninstaller (`remove()`, Spec 8)**: enumerates what it reverses and the five fail-fast precondition cases.
   - **404 handling**: disambiguates list-404 (hard) vs delete-404 (soft) at the implementation level (nested `cliDelete` helper for gh/glab, inline direct-fetch for Gitea DELETE).
   - **Canonical `.mcp.json` check**: explains the strict full-array equality rule and the "safety valve for customized entries."
   - **Second-run behavior**: documents the fail-fast-with-exit-1 design choice (intentionally NOT idempotent exit-0).

No other arch.md changes needed — the data flow, state persistence, forge strategy pattern, and handler pipeline are all unchanged by Spec 8.

## Lessons Learned Updates

Added two new entries to `codev/resources/lessons-learned.md`:

1. **"Inline small helpers when the file has a hard cap"** (under Testing or Architecture — I'll place it under Architecture). The top-level `codevRevert` helper was ~25 lines; inlining into `remove()` saved ~7 lines of function boilerplate (signature, closing brace, return statements, call-site). For cap-sensitive single-file implementations, this is a worthwhile tradeoff. The rule: if a helper is called from exactly one place and is <30 lines, inlining beats the abstraction.

2. **"Plan phase must count line budget from the actual current baseline, not hypothetical worst case"**. The iter1 Spec 8 plan claimed "parseCommandArgs merge saves 18 lines" but the savings was counted against a hypothetical duplicated `parseRemoveArgs` that never existed. Real savings was ~2 lines. Claude's iter1 plan review caught this. Plan budgets should always count from `wc -l` of the current file, not from imaginary duplicated code.

3. **"3-way review of the plan phase catches factual errors about existing code"**. Both Codex and Claude independently flagged that the iter1 plan misdescribed `runSetup` (as dist-based) and `mkFakeCli` (as method-dispatched). The actual helpers (tests/setup.test.ts:19–36 and 64–76) don't match those descriptions. Without the plan-phase 3-way review, Phase 2 would have started with a broken `runRemove` helper and an attempted `mkFakeCli` extension that was unnecessary and would have broken existing tests.

## Flaky Tests

No flaky tests encountered. All 191 existing tests plus 10 new remove tests pass consistently across multiple runs (verified by running `npm test` multiple times during implementation).

## Follow-up Items

- None. The spec is self-contained and the implementation covers all success criteria. No features were deferred to future specs.
