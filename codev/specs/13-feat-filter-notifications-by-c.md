# Specification: Filter Notifications by Conclusion (Default: Failures Only)

## Metadata
- **ID**: spec-2026-04-17-conclusions-filter
- **Status**: draft
- **Created**: 2026-04-17
- **Issue**: #13

## Problem Statement

The ci-channel plugin markets itself as a CI **failure** notifier — the README, startup messages, and installation flows all frame the feature as "get pinged when CI breaks". But the implementation forwards **every** `workflow_run` / pipeline event to the MCP channel regardless of outcome. As a result, users see notifications for successful green runs intermixed with the failures they actually care about, diluting signal-to-noise and training users to ignore the channel.

This is a direct mismatch between stated intent and observed behavior. Users have no way to restrict output to failures short of patching the code.

## Current State

The webhook handler (`lib/handler.ts`) runs a pipeline of filters:
1. Signature validation
2. Event parsing (forge-specific)
3. Duplicate-delivery check
4. Repo allowlist (`config.repos`)
5. Workflow-name allowlist (`config.workflowFilter`)
6. **[No conclusion filter]** — every outcome proceeds to notification
7. Format and push notification
8. Async enrichment (fire-and-forget)

Each forge's `parseWebhookEvent` already normalizes the run outcome into `event.conclusion` (a string). Values observed in the wild:

- **GitHub Actions**: `success`, `failure`, `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required`, `stale`, plus occasionally `null` when a run is still in progress.
- **GitLab CI**: `success`, `failed`, `canceled`, `skipped`, `manual` (note the spelling variations — British `cancelled` vs American `canceled`, and `failed` vs `failure`).
- **Gitea Actions**: mirrors GitHub — `success`, `failure`, `cancelled`, `skipped`.

There is no `conclusion`-based filter today. The only workaround is to set `--workflow-filter` to an empty or impossible value, which drops everything including failures.

## Desired State

Users receive only the notifications they want. By default, that means **failures, cancellations, and timeouts** — the three outcomes that typically indicate something is wrong and worth a human's attention.

Advanced users can override the default to match their own workflow — e.g., pass `--conclusions all` to keep current behavior, or `--conclusions failure,success` to include green runs.

The filter is applied uniformly across all three forges (GitHub, GitLab, Gitea). Because each forge's parser already normalizes the outcome into `event.conclusion`, the filter logic itself is forge-agnostic.

## Stakeholders
- **Primary Users**: developers running `ci-channel` in Claude Code to get CI alerts
- **Secondary Users**: architects spawning builders that depend on CI signal (noise suppression improves agent decision-making)
- **Technical Team**: ci-channel maintainers
- **Business Owners**: cluesmith / Claude Code ecosystem

## Success Criteria
- [ ] A new `--conclusions` CLI flag (and matching `CONCLUSIONS` env var) is recognized by `loadConfig`
- [ ] When `--conclusions` is not supplied, the channel forwards failure-like outcomes and drops known non-failure/in-progress outcomes (see "Default behavior" below)
- [ ] `--conclusions all` (case-insensitive) disables the filter entirely, restoring pre-upgrade behavior
- [ ] A user can pass an explicit comma-separated list of conclusion values (e.g. `failure,success,skipped`) and only matching events are forwarded
- [ ] The filter applies uniformly to GitHub, GitLab, and Gitea — values from each forge's `event.conclusion` pass through the same normalization + comparison
- [ ] Tests cover: default filter behavior (including in-progress values), `all` opt-out, custom lists, cross-forge terminology (`failed` vs `failure`, `canceled` vs `cancelled`), empty/`'unknown'` conclusions, rejection of mixed `all,X` lists, config-layer integration (CLI flag → `config.conclusions`)
- [ ] README and INSTALL docs describe the flag, the default, and the breaking-change upgrade note
- [ ] The startup notification emitted by `bootstrap.ts` includes the active conclusions filter (literal list when custom, the string `"default (failures)"` when default, `"all"` when opted out)
- [ ] All existing tests continue to pass

## Constraints

### Technical Constraints
- Must not change the signature of `WebhookEvent` — `conclusion` is already a field
- Must not block on the filter — filter runs synchronously in the handler pipeline (pure string comparison)
- Must not duplicate per-forge logic — filter reads `event.conclusion` and compares against an allowlist
- Must accept **both** British and American spellings as equivalent (`cancelled` == `canceled`) and **both** `failure`/`failed` — GitLab uses the alternate forms
- Config precedence must follow the existing rule: CLI args > env vars > `.env` file > `state.json` defaults

### Business Constraints
- This is a **behavior change** — upgrading users will stop seeing success notifications by default
- The change must be documented prominently in release notes for the version that ships this

## Assumptions
- `WebhookEvent.conclusion` remains typed as `string` (never null). Each forge's `parseWebhookEvent` already coerces missing values to `'unknown'` or to `payload.action`/`attrs.status`. The filter helper accepts any string, including empty, and normalizes defensively (lowercase + spelling canonicalization) rather than trusting that the parser already did so.
- Forge webhook payloads use lowercase conclusion strings in practice, but the spec does not rely on this — normalization inside the filter is authoritative.
- Users running into the current noise problem will welcome the stricter default; users who relied on the old "everything" behavior are a small minority and will be served by `--conclusions all`.
- No existing user config field or env var conflicts with the name `CONCLUSIONS`.
- `lib/reconcile.ts` and its forge-specific implementations already short-circuit on non-failure outcomes (GitHub: `if (run.conclusion !== 'failure') continue`; GitLab: `if (pipeline.status !== 'failed') continue`; Gitea: same). Reconciliation therefore does **not** need to run the new conclusion filter — it is already failure-only by construction. Scoping note below.

## Solution Approaches

### Approach 1: New `conclusions` config field + dedicated filter step (recommended)
**Description**: Add a new `conclusions: string[] | null` field to `Config`, parsed from `--conclusions` / `CONCLUSIONS` using the existing comma-split helper. Insert a new filter step in the handler pipeline after the workflow-name filter. The filter normalizes both the event's conclusion and each allowlist entry (lowercase, canonicalize `canceled`→`cancelled` and `failed`→`failure`) before comparing. A default list is applied when the field is null.

**Pros**:
- Mirrors the existing `workflowFilter` pattern exactly — low cognitive overhead for maintainers
- Filter is forge-agnostic — a single implementation covers all three forges
- Easy to test in isolation (pure function over `(conclusion, allowlist)`)
- Default behavior matches the stated purpose of the channel

**Cons**:
- Introduces a new CLI flag — one more thing for the installer to know about
- Terminology canonicalization (GitLab's `canceled`/`failed` vs GitHub's `cancelled`/`failure`) must be maintained in one spot

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Hardcoded "failures only" default, no config
**Description**: Skip the config layer entirely — unconditionally drop `success`, `skipped`, `neutral`, `stale`, `manual` events at the handler.

**Pros**:
- Zero config surface — nothing to misconfigure

**Cons**:
- No escape hatch for users who legitimately want success notifications (release announcements, deploy confirmations)
- Breaking change with no migration path
- Less composable — users on different teams have different definitions of "interesting"

**Estimated Complexity**: Trivial
**Risk Level**: Medium (no opt-out)

### Approach 3: Per-forge filtering inside each `parseWebhookEvent`
**Description**: Push the filter down into each forge's parser; return `{type: 'irrelevant'}` for filtered-out events.

**Pros**:
- Filtering happens closer to parsing

**Cons**:
- Triplicates the filter logic across three forges
- Ties the filter to parsing, making it harder to test in isolation
- Violates the "forge-agnostic handler" principle documented in CLAUDE.md

**Estimated Complexity**: Medium
**Risk Level**: Medium (triple-maintenance burden)

**Decision**: Approach 1.

## Default Behavior (Exclusion-Based)

The default filter is semantically an **exclusion list**, not an inclusion list. When `config.conclusions` is `null` (no CLI flag, no env var), the handler drops events whose normalized conclusion matches any of the following:

- **Known non-failure terminal**: `success`, `skipped`, `neutral`, `manual`, `stale`
- **Known non-terminal / in-progress**: `requested`, `in_progress`, `completed`, `running`, `pending`, `queued`, `waiting`, `preparing`

All other events pass through the default filter — this includes the canonical failure-like values (`failure`, `cancelled`, `timed_out`, `action_required`) **and** any unknown string the filter hasn't been taught about (so a new forge outcome isn't silently dropped).

When `config.conclusions` is an explicit list (e.g., `['failure', 'success']`), the filter is an **inclusion list** — only events whose normalized conclusion matches exactly are forwarded. Unknown strings are dropped in this mode because the user explicitly scoped the output.

`config.conclusions === ['all']` (the `--conclusions all` sentinel) disables the filter entirely.

## Semantics for `--conclusions` values

- Case-insensitive throughout (input lowercased at config-load time)
- Spelling canonicalized at config-load time: `failed` → `failure`, `canceled` → `cancelled`
- `all` is valid only as a **standalone** value. Mixed lists like `failure,all` or `all,success` are rejected at config-load with a clear error: `Invalid --conclusions value: "all" may only appear as a standalone sentinel.`
- Completely unknown configured values (e.g., `--conclusions foobar`) are accepted silently — they simply never match. Rationale: config validation should not own the canonical set (which may grow); a typo surfaces as "no notifications match," which is immediately visible.
- Normalization happens once at config-load time for the user's allowlist, and once per event inside the filter helper. Both sides call the same `normalizeConclusion(s: string): string` pure function.

## Reconciliation Scoping

Startup reconciliation (`lib/reconcile.ts` + each forge's `runReconciliation`) is **out of scope** for this spec. All three forge implementations already emit events only when the last run failed:

| Forge | Guard |
|-------|-------|
| GitHub | `if (run.conclusion !== 'failure') continue` |
| GitLab | `if (pipeline.status !== 'failed') continue` |
| Gitea | identical guard on `run.conclusion !== 'failure'` |

Applying the new conclusion filter to reconciliation would be redundant — the reconciliation path is already stricter than even the default filter would be. If a user opts into `--conclusions success`, reconciliation still only fires on failures; this is consistent with the existing behavior and introduces no new surprise. If future work changes reconciliation to emit non-failure events, the filter should be applied then.

## Open Questions

### Critical (Blocks Progress)
- None — issue #13 answers the major design questions.

### Important (Affects Design) — resolved during iter-1 review
- [x] **Canonicalization scope**: normalize internally (lowercase + `failed`→`failure`, `canceled`→`cancelled`). Internal normalization is lossless and hides forge-leakage from users.
- [x] **Empty / `'unknown'` conclusions**: forwarded under the default filter, dropped under an explicit `--conclusions` list. See "Default Behavior" and "Semantics" sections above.
- [x] **Non-terminal conclusions** (`requested`, `in_progress`, `running`, `pending`, etc.): excluded from the default filter by name, alongside known non-failure terminals. This resolves the original "failures only vs unknowns forwarded" contradiction flagged in iter-1 review.
- [x] **`all` sentinel semantics**: case-insensitive, standalone only, mixed lists rejected at config-load.

### Nice-to-Know (Optimization)
- [ ] Should the filter emit a log line when dropping events, for observability? Not strictly required for v1 — the existing `ok` response body is sufficient.

## Performance Requirements
- **Response Time**: filter adds a single `Array.includes` over a ≤10-element list — negligible (<1µs)
- **Throughput**: unchanged
- **Resource Usage**: unchanged
- **Availability**: unchanged

## Security Considerations
- No new trust boundaries. The `conclusion` string is already passed through the parser and is treated as untrusted; the filter is a pure comparison, no injection surface.
- The filter reduces the volume of notifications, which is weakly defense-in-depth against log-flooding a running Claude Code session.

## Test Scenarios

### Functional Tests
1. **Default filter, success dropped** — no `--conclusions` flag; a `success` event is dropped, a `failure` event is forwarded
2. **Default filter, in-progress dropped** — no flag; events with `conclusion` in `{requested, in_progress, running, pending, queued}` are dropped
3. **Default filter, action_required forwarded** — no flag; an `action_required` event is forwarded
4. **`all` opt-out (case-insensitive)** — `--conclusions ALL`; both `success` and `failure` events are forwarded
5. **Custom inclusion list** — `--conclusions failure,success`; both are forwarded, `cancelled` is dropped
6. **Cross-forge terminology** — `--conclusions failure` forwards both GitHub's `failure` and GitLab's `failed`; `--conclusions cancelled` forwards both `cancelled` and `canceled`
7. **Empty / `'unknown'` conclusion** — an event with `conclusion: ""` or `conclusion: "unknown"` is forwarded under the default, dropped under `--conclusions failure`
8. **Novel unknown conclusion** — an event with `conclusion: "xyz"` under the default is forwarded; under `--conclusions failure` it is dropped
9. **Mixed `all` rejected** — `--conclusions failure,all` throws at config-load with a clear error
10. **Config precedence** — CLI flag beats env var beats `.env` file
11. **Config-layer integration** — `--conclusions failure,SUCCESS` produces `config.conclusions = ['failure', 'success']` after normalization
12. **Startup banner** — the bootstrap startup notification includes the active filter description

### Non-Functional Tests
1. All existing handler tests continue to pass (regression guard)
2. Filter helper is a pure function — unit-testable without a live handler

## Dependencies
- **External Services**: none new
- **Internal Systems**: `lib/config.ts`, `lib/handler.ts`, `lib/webhook.ts`
- **Libraries/Frameworks**: none new

## References
- GitHub issue #13 — feat: filter notifications by conclusion
- `lib/handler.ts` — current pipeline
- `lib/config.ts` — config loading + CLI parsing
- `lib/webhook.ts` — `WebhookEvent.conclusion` field, existing `isWorkflowAllowed` helper as the pattern to follow
- `CLAUDE.md` — "Forge strategy pattern: handler and reconciler are forge-agnostic"

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Users upgrading silently lose success notifications they relied on | Med | Med | Prominent release note, clear `--conclusions all` escape hatch, mention in startup banner if feasible |
| Forge emits a new conclusion value not in the canonical set | Low | Low | Default list forwards unknown values; users with explicit lists can add the new value |
| Cancelled vs canceled / failed vs failure typo bites a user | Med | Low | Internal normalization accepts both spellings as equivalent; documented in README |
| Filter accidentally applied before dedup or repo check (ordering bug) | Low | Low | Fixed insertion point: between workflow-name filter and notification; covered by integration test |

## Notes

- Default filter is **exclusion-based** (see "Default Behavior" section). Excluded by default: `success`, `skipped`, `neutral`, `manual`, `stale`, `requested`, `in_progress`, `completed`, `running`, `pending`, `queued`, `waiting`, `preparing`. Everything else (including `failure`, `cancelled`, `timed_out`, `action_required`, and unknown strings) is forwarded.
- `action_required` is forwarded by default — it signals a workflow awaiting manual intervention, which is failure-adjacent and usually deserves attention.
- `timed_out` is GitHub-specific; GitLab doesn't emit it. It's handled uniformly via the same pipeline regardless.
- The canonical set of recognized values for documentation: `success`, `failure`, `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required`, `stale`, `manual`. Input is normalized: lowercase, then `failed`→`failure`, `canceled`→`cancelled`.
- The existing `splitCommaList` helper uses `.filter(Boolean)`, so trailing commas or empty segments (e.g., `--conclusions "failure,"`) are silently trimmed. Acceptable — users who want strict filtering typically don't want empty states anyway.
