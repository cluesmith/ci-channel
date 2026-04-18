# Plan Iteration 1 — Rebuttals

## Summary
- **Gemini**: APPROVE (three helpful notes)
- **Codex**: REQUEST_CHANGES (phase split inconsistent with existing tests; banner-wording drift; env-over-.env coverage; test mock updates)
- **Claude**: REQUEST_CHANGES (same core concerns as Codex — existing tests break + Config interface compilation + non-existent handler.test.ts + envKeys)

Codex and Claude agree on the core issues. All are accepted; the plan is updated.

## Codex — REQUEST_CHANGES

### Issue 1: Phase 1 regression guard is invalid — existing tests will break

**Accepted.** Verified:
- `tests/integration.test.ts:169` — "success event → notification" — success dropped by default filter
- `tests/integration-gitlab.test.ts:162` — "running pipeline state → notification" — running dropped by default filter

**Resolution**: Phase 1 scope expanded to include updates to these two existing tests. Both are changed to explicitly set `conclusions: ['all']` on the test config — this preserves the original regression coverage (confirming the old "forward everything" behavior is still reachable) without rewriting test intent.

### Issue 2: Banner wording drift from spec

**Accepted.** Spec says literal `"default (failures)"`. Plan had a more verbose variant. Aligning plan to spec wording: `"default (failures)"`.

### Issue 3: Env-over-.env precedence for `CONCLUSIONS`

**Accepted.** Added T10b to Phase 2: `CONCLUSIONS` in `process.env` overrides `CONCLUSIONS` in `.env` file when no CLI flag is supplied.

### Issue 4: Test fixture `Config` objects need `conclusions`

**Accepted.** Adding `conclusions: string[] | null` to the `Config` interface will cause TypeScript errors everywhere a `Config` is constructed inline. Phase 1 now includes mechanical updates to all known call sites:
- `tests/integration.test.ts`
- `tests/integration-gitlab.test.ts`
- `tests/integration-gitea.test.ts`
- `tests/bootstrap.test.ts` (`makeConfig` helper)
- `tests/reconcile.test.ts`
- `tests/forges/gitea.test.ts`
- `tests/forges/gitlab.test.ts`

Default for unrelated tests: `conclusions: null`. Exceptions: the success-event test in `integration.test.ts` and the running-pipeline test in `integration-gitlab.test.ts` use `conclusions: ['all']` to preserve the original assertion semantics.

### Issue 5: Phase split is artificial

**Accepted — adjusted, not collapsed.** Phase 1 now carries the mechanical test updates required to keep the suite green; Phase 2 adds the new filter-specific tests. This answers the concern (Phase 1 is independently verifiable via `npm test`) while retaining the porch-mandated ≥2 phases.

## Claude — REQUEST_CHANGES

### Issue A: Existing tests break under new default

**Accepted.** Same as Codex Issue 1 — handled in Phase 1.

### Issue B: TypeScript compilation fails from Config expansion

**Accepted.** Same as Codex Issue 4 — handled in Phase 1.

### Issue C: `envKeys` in `config.test.ts` needs `CONCLUSIONS`

**Accepted.** Added to Phase 2 as an explicit instruction: append `'CONCLUSIONS'` to the `envKeys` array in `tests/config.test.ts` save/restore block before adding new tests.

### Issue D: `tests/handler.test.ts` doesn't exist

**Accepted.** Plan updated to reference `tests/integration.test.ts` (and its sister files) as the home for the new handler integration tests. The phantom `handler.test.ts` reference removed.

## Gemini — APPROVE (three notes)

### Note 1: Test config mocks need `conclusions: null`
**Accepted** (same as above).

### Note 2: Handler tests live in integration files
**Accepted** (same as Claude's Issue D).

### Note 3: Double normalization

**Accepted — adopted as an optimization.** Since `lib/config.ts` normalizes each user-supplied allowlist entry at load time, the runtime filter only needs to normalize the event's `conclusion` side. `isConclusionAllowed` is updated to expect a pre-normalized allowlist:

```ts
// Inside handler (runtime):
isConclusionAllowed(event.conclusion, config.conclusions)
// - config.conclusions is already normalized at load time
// - helper normalizes only the event's conclusion
```

This is a minor code-quality improvement, not a behavior change.

## Plan changes summary

Phase 1 (`impl`) additions:
- Update `tests/integration.test.ts:169` success-event test to use `conclusions: ['all']` on its test config
- Update `tests/integration-gitlab.test.ts:162` running-pipeline test to use `conclusions: ['all']`
- Add `conclusions: null` to all other test `Config` fixtures: `tests/integration.test.ts:33`, `tests/integration-gitlab.test.ts:27`, `tests/integration-gitea.test.ts:32`, `tests/bootstrap.test.ts:7` (makeConfig helper), `tests/reconcile.test.ts:6`, `tests/forges/gitea.test.ts:48`, `tests/forges/gitlab.test.ts:7`
- Align startup banner wording to the spec: `"default (failures)"`
- Normalize only the event side at filter runtime; allowlist is already normalized at config-load

Phase 2 (`tests`) additions:
- Append `'CONCLUSIONS'` to the `envKeys` array in `tests/config.test.ts` before the new test cases
- New test T10b: env-over-.env precedence for `CONCLUSIONS`
- Locate the new handler integration tests in `tests/integration.test.ts` (and possibly `integration-gitlab.test.ts` for cross-forge verification), **not** a new `tests/handler.test.ts`
- Extract `formatConclusionsSummary` from `bootstrap.ts` (confirmed, not conditional) — required for T12
