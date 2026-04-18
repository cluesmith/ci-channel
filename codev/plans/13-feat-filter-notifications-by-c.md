# Plan: Filter notifications by conclusion (default: failures only)

## Metadata
- **ID**: plan-2026-04-17-conclusions-filter
- **Status**: draft
- **Specification**: codev/specs/13-feat-filter-notifications-by-c.md
- **Created**: 2026-04-17
- **Issue**: #13

## Executive Summary

Three small additions to existing files: a normalization helper + new `conclusions` field in `lib/config.ts`, a new `isConclusionAllowed` helper in `lib/webhook.ts`, and a single filter step in `lib/handler.ts`. No new files, no new dependencies, no forge-specific code. Documentation and release-note updates ship in the same PR.

The work splits into two phases. **Phase `impl`** lands all production code + docs (config + webhook helper + handler wiring + startup banner + README/INSTALL). **Phase `tests`** lands new unit/integration tests for the filter and config-layer integration. Both phases land in one PR.

This is a **behavior change** — users upgrading stop receiving success notifications by default. Release notes in the version bump call this out explicitly with the `--conclusions all` escape hatch.

## Success Metrics (copied from spec)

- [ ] `--conclusions` CLI flag + `CONCLUSIONS` env var recognized by `loadConfig`
- [ ] Default (no flag) excludes `success`, `skipped`, `neutral`, `manual`, `stale`, `requested`, `in_progress`, `completed`, `running`, `pending`, `queued`, `waiting`, `preparing`; forwards everything else (including `failure`, `cancelled`, `timed_out`, `action_required`, and unknown strings)
- [ ] `--conclusions all` (case-insensitive) disables the filter
- [ ] Explicit list is inclusion-based with normalization (lowercase + `failed`→`failure`, `canceled`→`cancelled`)
- [ ] Mixed `all,X` lists rejected at config-load with a clear error
- [ ] Filter applies uniformly to GitHub, GitLab, Gitea via shared handler pipeline
- [ ] Startup banner includes the active filter description
- [ ] All existing tests continue to pass
- [ ] New tests cover all 12 scenarios from spec's Test Scenarios section

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "impl", "title": "Implementation: config + webhook helper + handler wiring + startup banner + docs + version bump"},
    {"id": "tests", "title": "Automated tests: filter helper + handler integration + config-layer integration"}
  ]
}
```

## Phase Breakdown

### Phase 1: `impl`

**Dependencies**: None

#### Objective

Add the conclusions filter end-to-end: config → handler → startup banner → docs. No new tests in this phase; the existing test suite must continue to pass as a regression guard.

#### Files modified

1. **`lib/webhook.ts`**
   - Add `normalizeConclusion(s: string): string` — pure function: lowercase, then map `failed`→`failure`, `canceled`→`cancelled`
   - Add `isConclusionAllowed(conclusion: string, allowlist: string[] | null): boolean` — pure function. When `allowlist` is `null`, returns `false` only if the normalized conclusion is in the hardcoded default **exclusion set**; `true` otherwise. When `allowlist` is `['all']`, returns `true` unconditionally. Otherwise normalizes both sides and returns `allowlist.includes(normalized)`.
   - Default exclusion set (module-level `const`): `['success', 'skipped', 'neutral', 'manual', 'stale', 'requested', 'in_progress', 'completed', 'running', 'pending', 'queued', 'waiting', 'preparing']`

2. **`lib/config.ts`**
   - Add `conclusions: string[] | null` to the `Config` interface
   - Add `'--conclusions'` to the `knownFlags` set in `parseCliArgs`
   - In `loadConfig`: read `get('CONCLUSIONS', '--conclusions')`, parse via `splitCommaList`, normalize each entry by calling `normalizeConclusion` (imported from `webhook.ts`), then validate:
     - If the normalized list contains `'all'` AND has length > 1 → throw `Invalid --conclusions value: "all" may only appear as a standalone sentinel.`
     - Otherwise store the normalized array (or `null` when no value supplied)
   - Precedence: CLI > env > `.env` (no `state.json` for this field — it's user intent only)

3. **`lib/handler.ts`**
   - Import `isConclusionAllowed` from `./webhook.js`
   - Insert Step 5.5 between workflow filter and notification formatting:
     ```
     if (!isConclusionAllowed(event.conclusion, config.conclusions)) {
       return new Response('ok')
     }
     ```
   - Filter is synchronous, pure-function — no new async/await, no blocking

4. **`lib/bootstrap.ts`**
   - Extend the startup notification payload to include the active conclusions filter:
     - `null` → `"default (failures + cancellations + timeouts + action_required)"`
     - `['all']` → `"all"`
     - explicit list → joined comma-separated (e.g., `"failure, success"`)
   - Exact wording to match the existing banner style; single additional line or appended field

5. **`README.md`**
   - New "Filtering by conclusion" subsection under configuration / options, documenting the flag, the default, and the `all` opt-out
   - Breaking-change callout in the "Upgrade notes" section (or equivalent; create if missing)

6. **`INSTALL.md`**
   - Add `--conclusions` to the manual-install flags reference

7. **`package.json` / `package-lock.json`**
   - Version bump to `0.6.0` (minor — user-visible behavior change)

#### Success Criteria

- Existing test suite passes: `npm test`
- Type-checks: `npm run build` produces no errors
- Manual smoke: `npx tsx server.ts --conclusions failure` loads without error; `npx tsx server.ts --conclusions failure,all` errors with the specified message
- Version in `package.json` is `0.6.0`
- Banner output confirmed manually by running the server once and inspecting the startup notification

#### Tests

None new in Phase 1. Regression-only.

#### Commit

Single commit: `[Spec 13][Phase: impl] feat: add --conclusions filter + version bump to 0.6.0`

---

### Phase 2: `tests`

**Dependencies**: Phase 1

#### Objective

Add automated tests covering all 12 scenarios from the spec's Test Scenarios section. Tests live in the existing test layout — no new test infrastructure.

#### Files modified

1. **`tests/webhook.test.ts`** (or wherever `isWorkflowAllowed` is tested — follow convention)
   - `normalizeConclusion` pure-function tests:
     - Lowercasing (`"FAILURE"` → `"failure"`)
     - American → British (`"canceled"` → `"cancelled"`, `"failed"` → `"failure"`)
     - Idempotent on canonical values
   - `isConclusionAllowed` pure-function tests mapping to spec scenarios 1–3, 5–8:
     - T1: default drops `success` (allowlist=null)
     - T2: default drops `in_progress`, `running`, `pending`, `queued`, `requested` (one assert each or parametric)
     - T3: default forwards `action_required`
     - T5: inclusion list `['failure', 'success']` forwards both, drops `cancelled`
     - T6: inclusion list `['failure']` matches `'failed'` (GitLab); `['cancelled']` matches `'canceled'`
     - T7: empty string and `'unknown'` forwarded under default; dropped under `['failure']`
     - T8: novel `'xyz'` forwarded under default; dropped under `['failure']`
     - T4: `['all']` forwards both `success` and `failure`

2. **`tests/config.test.ts`** (or wherever `loadConfig` is tested — follow convention)
   - T9: `--conclusions failure,all` throws with the documented error message
   - T10: CLI `--conclusions failure` overrides `CONCLUSIONS=success` env var
   - T11: `--conclusions failure,SUCCESS` produces `config.conclusions === ['failure', 'success']` (lowercased + normalized)
   - T4-variant: `--conclusions ALL` produces `config.conclusions === ['all']`

3. **`tests/handler.test.ts`** (integration)
   - Handler integration covering the wiring: a fake `config.conclusions = ['failure']` with a `success` event produces no notification; with a `failure` event produces one notification. Builds on the existing handler-test scaffolding (whatever the project uses for mocking MCP + forge).

4. **`tests/bootstrap.test.ts`** (or equivalent for T12, if startup-banner tests exist)
   - T12: startup banner includes the literal filter description for all three states (null / `all` / custom)
   - If no bootstrap test exists today, add a minimal pure-function test against whatever formatter `bootstrap.ts` uses. If the banner is built inline, extract a small pure formatter (`formatConclusionsSummary(config.conclusions): string`) to `lib/bootstrap.ts` and test that.

#### Success Criteria

- All 12 spec scenarios have corresponding test assertions (mapping documented above)
- Full test suite passes: `npm test`
- Coverage of new helpers (`normalizeConclusion`, `isConclusionAllowed`) is 100% by inspection
- No flaky intermittent failures

#### Commit

Single commit: `[Spec 13][Phase: tests] test: cover conclusions filter + config integration`

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| The default exclusion set misses a non-terminal value some forge emits | `isConclusionAllowed` uses an explicit named list; adding values is a one-line change. Users can always pass `--conclusions` to override. |
| Upgrade regression: user loses success notifications silently | Release notes in v0.6.0 call this out prominently; startup banner makes the active filter visible at every run |
| Someone relies on `splitCommaList` stripping empty segments in an unexpected way | Documented as known behavior in spec Notes; no behavior change on this path |
| Config validation rejects a legitimate input | Only one validation rule (`all` must be standalone); covered by T9 |
| Startup banner refactor in bootstrap.ts breaks an unrelated test | Keep the change minimal — append a single additional field/line; don't restructure the banner |

## Out of Scope

- Reconciliation (`lib/reconcile.ts` + forge `runReconciliation`) — already failure-only by construction per spec
- Adding new canonical conclusion values — confined to the documented set in the spec
- Per-repo or per-workflow conclusion filters — single global filter only
- Logging dropped events for observability — deferred; current `ok` response is sufficient
