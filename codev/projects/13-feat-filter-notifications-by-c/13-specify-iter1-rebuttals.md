# Specify Iteration 1 — Rebuttals

## Summary of reviews
- **Gemini**: APPROVE (two implementation notes for the builder)
- **Codex**: REQUEST_CHANGES (default-behavior contradiction + ambiguities)
- **Claude**: COMMENT (reconciliation gap, wording fixes, minor clarifications)

## Codex — REQUEST_CHANGES

### Issue 1: Default-behavior contradiction (unknown/in-progress conclusions)

**Codex is correct.** The spec said "default forwards failures only" AND "unknown values forwarded by default." Given that GitHub's parser maps in-progress `workflow_run` events to `payload.action` (e.g., `requested`, `in_progress`, `completed`) and GitLab passes through statuses like `running`/`pending`, a literal fail-open on unknowns would leak noise.

**Resolution**: The default filter is now an **exclusion list** rather than an inclusion list. The default allowlist is `null` at the config layer, but semantically means "forward only if the normalized conclusion is NOT in the excluded set." The excluded set enumerates both known non-failure terminal states AND known in-progress/non-terminal states:

- `success`, `skipped`, `neutral`, `manual`, `stale` (known non-failures)
- `requested`, `in_progress`, `completed`, `running`, `pending`, `queued`, `waiting`, `preparing` (known non-terminal)

Truly unknown string values (something neither in the excluded set nor in the canonical failure set) still forward — so a new forge outcome is not silently dropped. This resolves the contradiction: the default is "fail-closed for known-good, fail-open for truly novel."

Codex's Option A is effectively what we adopted.

### Issue 2: `WebhookEvent.conclusion` typed as `string`

**Codex is correct on the typing point.** `WebhookEvent.conclusion` is typed as `string`, and the current parsers coerce null to literal `'unknown'` or `payload.action`. The spec's phrasing "handle null" was sloppy.

**Resolution**: The Assumptions section is rewritten to state that `WebhookEvent.conclusion` remains a `string` (never null); the filter helper treats empty-string and the literal `'unknown'` as non-terminal and forwards them under the default. The event interface is unchanged.

### Issue 3: `all` semantics, invalid values, mixed lists

**Codex is correct that these need explicit spec coverage.** Decisions:
- `all` is **case-insensitive** (`all`, `ALL`, `All` all accepted)
- `all` is only valid as a **standalone** value. A mixed list like `failure,all` is rejected at config-load time with a clear error message.
- Completely unknown configured values (e.g., `--conclusions foobar`) are **accepted silently** and simply never match. Rationale: if we reject, we're second-guessing the user and coupling config validation to the canonical set, which may grow. Cost of a typo is "no notifications match" which is immediately visible.
- All input is normalized at **config-load time** (once): lowercase, then `failed`→`failure`, `canceled`→`cancelled`.

These are now documented in the spec under "Semantics for `--conclusions` values."

### Issue 4: Reconciliation applicability

**Codex's observation about reconciliation is correct in principle, but verification of the code shows it's already failure-only:**
- `lib/forges/github.ts:119` — `if (run.conclusion !== 'failure') continue`
- `lib/forges/gitlab.ts` — `if (pipeline.status !== 'failed') continue`
- `lib/forges/gitea.ts` — same pattern (verified)

Reconciliation only emits failure events by construction. The spec now explicitly scopes reconciliation out and documents this fact — no behavior change in reconciliation is required, but the spec records the audit.

## Claude — COMMENT

### Issue 1: Reconciliation not addressed

**Accepted.** Addressed above — scoped out with an audit note.

### Issue 2: Lowercase assumption is technically wrong

**Accepted.** Spec assumption rewritten: "values are *expected* to be lowercase but the filter normalizes defensively (lowercase + canonicalize spelling)."

### Issue 3: `action_required` in default set

**Accepted — partially.** Claude is right that `action_required` is failure-adjacent (workflow needs manual intervention). Moved it from the excluded set to the **included** set. The default now forwards: anything not explicitly excluded (including `action_required` and `failure`/`cancelled`/`timed_out`).

Effective effect: `action_required` notifications appear by default.

### Issue 4: Startup banner "if feasible" → required

**Accepted.** Made required. The bootstrap startup notification must include the active conclusions filter (the literal list if custom, or `"default (failures + cancellations + timeouts + action_required)"` if the default is active, or `"all"` if opted out).

### Issue 5: Where normalization happens

**Clarified.** Normalization happens once at config-load time for the user's list, and once per event inside the filter helper. The filter helper lives in `lib/webhook.ts` alongside `isWorkflowAllowed`. Config layer exports a `normalizeConclusion` pure function that both sides use.

## Gemini — APPROVE

### Note 1: Default logic via exclusion
**Accepted** — adopted, as described in the Codex Issue 1 resolution.

### Note 2: `splitCommaList` strips empty strings
**Noted.** Not a spec change; the builder is already aware. Documented in "Notes" of the spec.

## Spec file changes
The spec is being updated in the same iteration to reflect these resolutions. Key sections rewritten:
- **Success Criteria** — default behavior spelled out as exclusion-based, startup-banner requirement added
- **Assumptions** — corrected lowercase assumption, clarified `conclusion` typing
- **Semantics section (new)** — explicit rules for `all`, case-insensitivity, mixed lists, unknown values, normalization timing
- **Reconciliation section (new)** — scopes it out with code audit
- **Test Scenarios** — adds in-progress value cases (`requested`, `in_progress`, `running`, `pending`), config-layer integration test, explicit `all,X` rejection test
- **Default set** — `action_required` moved to the included default set
