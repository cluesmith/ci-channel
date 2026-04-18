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

Add the conclusions filter end-to-end: config → handler → startup banner → docs. Phase 1 also carries **mechanical updates to existing tests** — the `Config` interface is expanded, which forces every inline `Config` fixture to add a `conclusions` field, and two existing integration tests explicitly assert pre-filter behavior (success events + running-pipeline events produce notifications) and must opt into `conclusions: ['all']` to keep their coverage intact. No *new* tests in Phase 1 — those are Phase 2.

#### Files modified

1. **`lib/webhook.ts`**
   - Add `normalizeConclusion(s: string): string` — pure function: lowercase, then map `failed`→`failure`, `canceled`→`cancelled`
   - Add `isConclusionAllowed(conclusion: string, allowlist: string[] | null): boolean` — pure function. When `allowlist` is `null`, returns `false` only if the normalized conclusion is in the hardcoded default **exclusion set**; `true` otherwise. When `allowlist` is `['all']`, returns `true` unconditionally. Otherwise normalizes **only** the event-side `conclusion` and returns `allowlist.includes(normalizedEventConclusion)` — the allowlist is assumed pre-normalized at config-load time (Gemini's optimization note).
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
   - Extract a new pure helper `formatConclusionsSummary(conclusions: string[] | null): string` (exported for Phase 2 testing):
     - `null` → `"default (failures)"` (literal, matches spec wording)
     - `['all']` → `"all"`
     - explicit list → joined comma-separated (e.g., `"failure, success"`)
   - Extend the startup notification payload to include the active conclusions filter via `formatConclusionsSummary(config.conclusions)` — single additional line or appended field, matching the existing banner style

5. **`README.md`**
   - New "Filtering by conclusion" subsection under configuration / options, documenting the flag, the default, and the `all` opt-out
   - Breaking-change callout in the "Upgrade notes" section (or equivalent; create if missing)

6. **`INSTALL.md`**
   - Add `--conclusions` to the manual-install flags reference

7. **`package.json` / `package-lock.json`**
   - Version bump to `0.6.0` (minor — user-visible behavior change)

8. **Existing test `Config` fixtures** — mechanical updates to satisfy the expanded `Config` interface and preserve existing test intent:

   | File | Fixture | `conclusions` value | Why |
   |------|---------|---------------------|-----|
   | `tests/integration.test.ts:33` | `testConfig` | `null` | Default behavior; other tests use `testConfig` for unrelated assertions |
   | `tests/integration.test.ts:169` test | override on call | `['all']` | Test asserts "success event → notification" — preserve pre-filter behavior |
   | `tests/integration-gitlab.test.ts:27` | `testConfig` | `null` | Same rationale as above |
   | `tests/integration-gitlab.test.ts:162` test | override on call | `['all']` | Test asserts "running pipeline → notification" — preserve pre-filter behavior |
   | `tests/integration-gitea.test.ts:32` | `testConfig` | `null` | Default |
   | `tests/bootstrap.test.ts:7` | `makeConfig` helper | `null` | Default; existing callers unchanged |
   | `tests/reconcile.test.ts:6` | `dummyConfig` | `null` | Default |
   | `tests/forges/gitea.test.ts:48` | `dummyConfig` | `null` | Default |
   | `tests/forges/gitlab.test.ts:7` | `dummyConfig` | `null` | Default |

   These are mechanical updates — no new assertions, no new test cases. Phase 2 adds the new coverage.

#### Success Criteria

- Full test suite passes: `npm test` (after the mechanical test-fixture updates in this phase)
- Type-checks: `npm run build` produces no errors
- Manual smoke: `npx tsx server.ts --conclusions failure` loads without error; `npx tsx server.ts --conclusions failure,all` errors with the documented message
- Version in `package.json` is `0.6.0`
- Banner output confirmed manually by running the server once and inspecting the startup notification — contains the literal string `default (failures)` when no flag is supplied

#### Tests

No *new* tests in Phase 1. Mechanical updates to existing fixtures only (see file table above). New coverage for the filter itself is Phase 2.

#### Commit

Single commit: `[Spec 13][Phase: impl] feat: add --conclusions filter + version bump to 0.6.0`

---

### Phase 2: `tests`

**Dependencies**: Phase 1

#### Objective

Add automated tests covering all 12 scenarios from the spec's Test Scenarios section. Tests live in the existing test layout — no new test infrastructure.

#### Files modified

1. **`tests/webhook.test.ts`** (follow `isWorkflowAllowed` test location convention)
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

2. **`tests/config.test.ts`**
   - **Prerequisite**: append `'CONCLUSIONS'` to the `envKeys` save/restore array at the top of the file before any new test cases, to prevent env-state leakage
   - T9: `--conclusions failure,all` throws with the documented error message (string match: `Invalid --conclusions value: "all" may only appear as a standalone sentinel.`)
   - T10a: CLI `--conclusions failure` overrides `CONCLUSIONS=success` env var
   - T10b: `CONCLUSIONS=failure` env var overrides `CONCLUSIONS=success` written to `.env` file when no CLI flag
   - T11: `--conclusions failure,SUCCESS` produces `config.conclusions === ['failure', 'success']` (lowercased + normalized)
   - T4-config: `--conclusions ALL` produces `config.conclusions === ['all']` (lowercased, single-element sentinel)

3. **`tests/integration.test.ts`** (new handler-integration coverage lives in the existing integration files, not a new `handler.test.ts`)
   - Integration test: with `config.conclusions = ['failure']` and a `success` event posted, the handler returns 200 but emits no notification; with a `failure` event it emits exactly one. Uses the same MCP + server scaffolding already in the file.
   - Repeat the same assertion pattern in `tests/integration-gitlab.test.ts` (and optionally `integration-gitea.test.ts`) to confirm cross-forge uniformity — the spec requires the filter to apply to all three forges.

4. **`tests/bootstrap.test.ts`**
   - T12: test `formatConclusionsSummary` directly (exported from `lib/bootstrap.ts` in Phase 1) for all three states:
     - `null` → `"default (failures)"`
     - `['all']` → `"all"`
     - `['failure', 'success']` → `"failure, success"`
   - If the existing bootstrap banner tests exercise the integration end-to-end, extend one of them to confirm the summary appears in the notification payload.

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
