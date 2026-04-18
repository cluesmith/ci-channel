# Review: feat-filter-notifications-by-c

## Summary

Added a `--conclusions` CLI flag (and `CONCLUSIONS` env var) to `ci-channel` that filters notifications by run outcome. The default is a strict failure-only profile — `success`, `skipped`, `neutral`, `manual`, `stale`, and in-progress/non-terminal states like `requested`, `in_progress`, `running`, `pending`, `queued`, `waiting`, `preparing`, `completed` are dropped; `failure`, `cancelled`, `timed_out`, `action_required`, and any unknown forge-specific string are forwarded.

Shipped as v0.6.0. Breaking change is documented in README upgrade note and surfaced in the startup banner.

## Spec Compliance

- [x] `--conclusions` CLI flag + `CONCLUSIONS` env var recognized by `loadConfig`
- [x] Default (no flag) drops known non-failure + in-progress outcomes; forwards everything else
- [x] `--conclusions all` (case-insensitive) disables the filter
- [x] Explicit list is inclusion-based, normalized (lowercase + `failed`→`failure`, `canceled`→`cancelled`)
- [x] Mixed `all,X` lists rejected at config-load with the documented error
- [x] Filter applies uniformly to GitHub, GitLab, Gitea via shared handler pipeline
- [x] Startup banner includes the active filter description (`default (failures)` / `all` / joined list)
- [x] All 12 spec test scenarios covered; full suite passes (237 tests, 0 failures)
- [x] README + INSTALL + CLAUDE + AGENTS docs updated; version bumped to 0.6.0

Reconciliation (`lib/reconcile.ts` + forge `runReconciliation`) is explicitly out of scope: all three forge reconcilers already short-circuit on non-failure outcomes. No change needed.

## Deviations from Plan

- **Phase 1 test-fixture update**: the plan's file-table suggested overriding `conclusions: ['all']` "on call" for the two integration tests that assert pre-filter behavior (success event / running pipeline). But `tests/integration.test.ts` and `tests/integration-gitlab.test.ts` build a single module-level handler from a shared `testConfig`. Per-call override wasn't possible without restructuring the test files. Deviation: set `conclusions: ['all']` on the module-level `testConfig` instead. Effect: all existing tests in those files run with the filter disabled (preserving their intent); new filter-specific integration tests in Phase 2 stand up their own local handlers with explicit `conclusions` values. Both impl reviews flagged this as a defensible improvement.

- **Phase 1 scope expansion (already captured in plan iter1 rebuttal)**: the rebuttal expanded Phase 1 to include mechanical `conclusions` field updates across all 7 test `Config` fixtures. This is recorded in the plan as the definitive scope.

## Lessons Learned

### What Went Well

- The `isWorkflowAllowed` pattern was a strong template. Copying it for `isConclusionAllowed` kept the filter forge-agnostic, trivially testable, and mechanically consistent with code that reviewers already trust.
- Separating `normalizeConclusion` as a pure function and calling it at config-load time for the allowlist + at runtime only for the event side (per Gemini's suggestion) kept the filter O(1) per event.
- Extracting `formatConclusionsSummary` up-front (rather than "if banner testing needs it") made T12 a trivial four-line pure-function test and let the integration test for the banner stay focused on the bootstrap wiring.

### Challenges Encountered

- **Default-behavior contradiction** (spec iter1): the "failures only" goal conflicted with "unknowns forwarded (fail-open)" once you realize the parsers coerce in-progress events to `requested` / `in_progress` / `running`. Resolved by switching the default to an exclusion-list semantic — see lessons-learned entry below.
- **Existing integration tests break under the new default**: both the success-event test and the running-pipeline test were invalid under the new filter. Resolved by setting `conclusions: ['all']` on the module-level `testConfig` for both files, preserving original test intent and isolating the new coverage to explicit-per-test handlers.
- **TypeScript compilation propagation**: adding `conclusions` to the `Config` interface forced mechanical updates to seven test fixtures. Plan iter1 rebuttal captured these as a complete file list; Phase 1 executed them mechanically.

### What Would Be Done Differently

- Start the spec with a concrete enumeration of the values each forge actually emits (including non-terminal / action strings). The spec iter1 framed this as "conclusion values are mostly lowercase strings" — but once Codex reminded us that GitHub's parser can emit `payload.action` (`requested`, `completed`) in place of a literal conclusion, the whole default-behavior question became much more concrete.
- Run `grep -l "Config = {"` on the test directory *before* writing the plan. That would have made the "mechanical fixture updates" scope visible in iter1 rather than arriving as review feedback.

### Methodology Improvements

- When a spec changes a **default** (as opposed to adding a new flag with a null default), the plan template should explicitly require an "existing tests that assert the old default" section. This would have caught the integration-test breakage before the plan review cycle.

## Architecture Updates

Updated `codev/resources/arch.md`:
- Webhook handler pipeline renumbered: inserted step 6 ("Check conclusion filter") between workflow filter and notification formatting. Enrichment step renumbered 8→9, return-200 renumbered 9.
- `lib/webhook.ts` exports list extended with `normalizeConclusion` and `isConclusionAllowed`; new exports documented with their three-mode semantics (null default-exclusion, `['all']` sentinel, explicit inclusion list).
- ASCII data-flow diagram updated with the new step 6 and shifted downstream steps.

## Lessons Learned Updates

Added two entries to `codev/resources/lessons-learned.md`:
1. "Behavior-change specs must trace the default through every existing test that asserts the old behavior" — formalizes the grep-before-plan workflow for default changes, triggered by Spec 13 plan iter1.
2. "Exclusion-list semantics resolve the 'failures only vs. unknowns forwarded' contradiction cleanly" — generalizes the inclusion→exclusion pivot that resolved the spec iter1 REQUEST_CHANGES from Codex.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini — APPROVE
- **Concern**: Default logic must be coded as an *exclusion* list, else unknown values would accidentally be dropped under `conclusions: null`.
  - **Addressed**: Default behavior rewritten as an explicit exclusion list (known non-failures + known non-terminals). Unknown strings forwarded under the default; dropped under an explicit list.
- **Concern**: `splitCommaList` filters empty strings — users can't include an empty-string conclusion.
  - **N/A**: Noted in the spec's "Notes" section as acceptable — users wanting strict filtering rarely want empty states.

#### Codex — REQUEST_CHANGES
- **Concern**: Default "failures only" contradicts "unknowns forwarded" given parsers emit `requested`/`in_progress`/`running` for non-terminal events.
  - **Addressed**: Spec now uses an exclusion-list semantic for the default; in-progress values are explicitly in the exclusion set. Unknown strings still forward under default (fail-open for novel forge outcomes), but known non-terminals do not.
- **Concern**: `WebhookEvent.conclusion` is typed `string`, not nullable.
  - **Addressed**: Assumptions section rewritten: interface unchanged, filter handles empty string and `'unknown'` as non-terminal, fails safely.
- **Concern**: Semantics for `all`, invalid values, mixed lists (`failure,all`) need explicit spec coverage.
  - **Addressed**: New "Semantics for --conclusions values" section in spec: case-insensitive, `all` standalone-only, unknown configured values accepted silently, normalization at config-load time.
- **Concern**: Reconciliation applicability ambiguous.
  - **Addressed**: Spec audited all three `runReconciliation` implementations; all already short-circuit on non-failure. Added explicit "Reconciliation Scoping" section marking it out of scope with the audit receipt.

#### Claude — COMMENT
- **Concern**: Reconciliation path not addressed.
  - **Addressed**: See Codex Issue 4 above.
- **Concern**: "values are lowercase" assumption technically wrong (parsers don't explicitly lowercase).
  - **Addressed**: Assumptions rewritten: values *expected* lowercase but filter normalizes defensively.
- **Concern**: `action_required` should be forwarded by default (failure-adjacent).
  - **Addressed**: `action_required` moved to the forwarded-by-default set.
- **Concern**: Startup banner should be required, not "if feasible."
  - **Addressed**: Spec success criterion made mandatory; plan implemented `formatConclusionsSummary` + banner integration unconditionally.

### Plan Phase (Round 1)

#### Gemini — APPROVE
- **Concern**: Test config mocks need `conclusions: null`.
  - **Addressed**: Phase 1 scope expanded to enumerate all 7 test fixture updates.
- **Concern**: Handler tests live in integration files, not a separate `handler.test.ts`.
  - **Addressed**: Plan references `tests/integration.test.ts` (and sisters), not a new file.
- **Concern**: Double normalization unnecessary if allowlist is normalized at load-time.
  - **Addressed**: `isConclusionAllowed` normalizes only the event side; allowlist is assumed pre-normalized from config.

#### Codex — REQUEST_CHANGES
- **Concern**: Phase 1 claims existing tests pass but 2 tests assert old default behavior.
  - **Addressed**: Phase 1 scope expanded to set `conclusions: ['all']` on module-level `testConfig` in both integration files.
- **Concern**: Startup banner wording in plan (`default (failures + cancellations + ...)`) doesn't match spec wording (`default (failures)`).
  - **Addressed**: `formatConclusionsSummary` returns the exact spec wording `default (failures)`.
- **Concern**: Env-over-.env precedence test missing for `CONCLUSIONS`.
  - **Addressed**: Added T10b to Phase 2: `CONCLUSIONS` env overrides `.env` file when no CLI.
- **Concern**: Test fixture `Config` objects need explicit `conclusions`.
  - **Addressed**: Phase 1 table enumerates all 7.
- **Concern**: Phase split is artificial given behavior change.
  - **Rebutted (soft)**: Phase split retained because porch requires ≥2 phases. Phase 1 now carries mechanical test-fixture updates to keep the suite green; Phase 2 adds new coverage. Both reviewers agreed this is reasonable.

#### Claude — REQUEST_CHANGES
- **Concern**: Same as Codex Issue 1 (existing tests break).
  - **Addressed**: See above.
- **Concern**: TypeScript compilation fails from `Config` interface expansion.
  - **Addressed**: Phase 1 includes the full fixture-update table.
- **Concern**: `envKeys` array in `config.test.ts` needs `CONCLUSIONS`.
  - **Addressed**: Phase 2 instructions now include the mandatory append as a prerequisite.
- **Concern**: `tests/handler.test.ts` referenced but doesn't exist.
  - **Addressed**: Plan rewritten to use `tests/integration.test.ts` (and `tests/integration-gitlab.test.ts` for cross-forge).

### Implement Phase — Round 1 (plan-phase `impl`)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE
- No concerns raised. Note: Codex's sandbox couldn't run `npm test` (EPERM on `mkdtemp`/`listen`); verdict based on `npx tsc --noEmit` and static review.

#### Claude — APPROVE
- No concerns raised. Noted the `testConfig = ['all']` vs per-test override deviation as a defensible improvement.

### Implement Phase — Round 1 (plan-phase `tests`)

#### Gemini — APPROVE
- No concerns raised.

#### Codex — APPROVE (confidence MEDIUM, sandbox limits)
- No concerns raised.

#### Claude — APPROVE
- No concerns raised. Confirmed all 237 tests pass, 0 failures.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- When the next `ci-channel` release goes out, the release notes should include the `--conclusions all` escape-hatch callout prominently. The README already has this; just ensure it propagates to the published release notes.
- If a user reports a novel forge conclusion value (e.g., Gitea introducing a new state), the fix is a one-line addition to `DEFAULT_EXCLUDED_CONCLUSIONS` in `lib/webhook.ts`. No architectural change needed.
- Consider adding a `--log-filtered` flag in a future release for observability — currently, dropped events return `ok` with no audit trail. Out of scope for v0.6.0.
