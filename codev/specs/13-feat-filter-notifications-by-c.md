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
- [ ] When `--conclusions` is not supplied, the channel defaults to forwarding only **failure-like** outcomes; successful runs are silently dropped
- [ ] `--conclusions all` (or the literal string `all`) disables the filter entirely, restoring pre-upgrade behavior
- [ ] A user can pass an explicit comma-separated list of conclusion values (e.g. `failure,success,skipped`) and only matching events are forwarded
- [ ] The filter applies uniformly to GitHub, GitLab, and Gitea — values from each forge's normalized `event.conclusion` pass through the same logic
- [ ] Events whose `conclusion` is empty/null/unknown are forwarded by default (fail-open to avoid silently dropping legitimate events) — unless the explicit filter omits them
- [ ] Tests cover: default filter behavior, `all` opt-out, custom lists, cross-forge terminology (`failed` vs `failure`, `canceled` vs `cancelled`), empty/null conclusions
- [ ] README and INSTALL docs describe the flag, the default, and the breaking-change upgrade note
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
- Each forge's `parseWebhookEvent` populates `event.conclusion` with a lowercase string (or empty string) for terminal states. If a forge ever emits an in-progress event with `null`, the filter must not crash.
- Users running into the current noise problem will welcome the stricter default; users who relied on the old "everything" behavior are a small minority and will be served by `--conclusions all`.
- No existing user config field or env var conflicts with the name `CONCLUSIONS`.

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

## Open Questions

### Critical (Blocks Progress)
- None — issue #13 answers the major design questions.

### Important (Affects Design)
- [ ] **Canonicalization scope**: should the filter accept `failed`, `canceled` as-written, or normalize internally? **Answer**: normalize internally. Users who write `--conclusions failure` must match both GitHub's `failure` and GitLab's `failed`. Internal normalization is lossless and hides a forge-leakage from users.
- [ ] **Empty/null conclusions**: drop or forward? **Answer**: forward (fail-open). An empty string is almost always an in-progress event or a forge quirk; dropping it silently is worse than a stray notification.
- [ ] **Unknown conclusions** (a value outside the canonical set): drop or forward? **Answer**: forward when using the default list (so new forge outcomes aren't lost until the canonical set is updated). When an explicit `--conclusions` list is provided, match exactly against the normalized list — unknown values from the event are dropped because the user explicitly scoped the output.

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
1. **Default filter** — no `--conclusions` flag; a `success` event is dropped, a `failure` event is forwarded
2. **`all` opt-out** — `--conclusions all`; both `success` and `failure` events are forwarded
3. **Custom list** — `--conclusions failure,success`; both are forwarded, `cancelled` is dropped
4. **Cross-forge terminology** — `--conclusions failure` forwards both GitHub's `failure` and GitLab's `failed`; `--conclusions cancelled` forwards both `cancelled` and `canceled`
5. **Empty conclusion** — an event with `conclusion: ""` is forwarded under the default list
6. **Unknown conclusion** — an event with `conclusion: "xyz"` under the default list is forwarded; under `--conclusions failure` it is dropped
7. **Config precedence** — CLI flag beats env var beats `.env` file

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

- The default list should be `failure, cancelled, timed_out` (after normalization). `skipped`, `neutral`, `success`, `action_required`, `stale` are excluded by default.
- `timed_out` is GitHub-specific; GitLab doesn't emit it. Including it in the default doesn't hurt — it's just a no-op on other forges.
- The canonical set of recognized values for documentation purposes: `success`, `failure`, `cancelled`, `timed_out`, `skipped`, `neutral`, `action_required`, `stale`, `manual`. Input is normalized: `failed`→`failure`, `canceled`→`cancelled`.
