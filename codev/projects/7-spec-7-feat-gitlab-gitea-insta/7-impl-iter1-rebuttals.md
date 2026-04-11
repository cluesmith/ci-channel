# Impl Phase (Phase 1) — Iteration 1 Rebuttals

Three reviewers consulted:
- **Gemini**: APPROVE (no issues)
- **Codex**: REQUEST_CHANGES (one finding)
- **Claude**: APPROVE (no issues)

## Codex (REQUEST_CHANGES)

### Finding 1 — Missing `http://` / `https://` validation for `--gitea-url`

**Feedback**: `lib/setup.ts:35` accepts `--gitea-url` without validating the scheme prefix. The spec explicitly requires `"it's a string that starts with http:// or https://"` in the Gitea section. As written, `--forge gitea --gitea-url gitea.example.com` (no scheme) would proceed through token/state provisioning and only fail when `fetch` rejects the URL — a later, more confusing failure mode than the intended CLI-validation fail-fast.

**Disposition**: **ACCEPTED, FIXED.**

Added a one-line regex check to `parseArgs` immediately after the forge-presence validation:

```typescript
if (giteaUrl && !/^https?:\/\//i.test(giteaUrl)) throw new Error(`--gitea-url must start with http:// or https:// (got '${giteaUrl}')`)
```

Placement: after the two existing guards (`forge === 'gitea' && !giteaUrl` and `forge !== 'gitea' && giteaUrl`), so the scheme check only runs when there's a value to validate. Case-insensitive (`/i` flag) so `HTTP://`, `Https://`, etc. are accepted — `fetch` normalizes the scheme anyway. Error message includes the offending value to make the failure diagnosable.

**Budget impact**: `lib/setup.ts` went from 293 → 294 lines. Still well under the 300-line cap.

**Test impact**: No new tests required in Phase 1 — this is a CLI validation branch that Phase 2 will cover under the "CLI validation" stretch scenarios (spec test scenarios 11/12). Rerunning `npm test` after the fix: 181 tests pass, baseline unchanged.

## Gemini (APPROVE)

No findings. Approved.

## Claude (APPROVE)

No findings. Approved. Noted two non-blocking observations:
- `unchanged` check uses `Object.keys(existing).length === 2` which couples to `loadState`'s current shape. This is pre-existing behavior from Spec 5 — not a regression and not in Phase 7's scope. Kept as-is.
- Live smoke test against a real forge was not run. Spec explicitly marks this non-required; Phase 2's fake-CLI tests cover the code paths automatically.

## Summary

- 1 of 3 reviewers requested changes; the finding was a real spec-adherence gap.
- Fix is a 1-line regex addition to `parseArgs`, zero test changes needed in Phase 1.
- Final `lib/setup.ts` = 294 lines (≤300 cap).
- All 181 existing tests still pass.
- No new dependencies, no new files, no architectural changes.

Under ASPIR, no second consultation round is required — Phase 1 auto-approves on porch `done` after verification checks pass.
