# Spec 8 — Iteration 1 Rebuttal

## Review Summary

| Model | Verdict | Confidence |
|---|---|---|
| Gemini | APPROVE | HIGH |
| Codex | REQUEST_CHANGES | HIGH |
| Claude | APPROVE | HIGH |

Not unanimous — Codex blocks. All four Codex issues are legitimate and have been addressed. Claude's minor concerns have also been folded in. Gemini's implementation notes are informational (for the plan/impl phase).

## Codex Issue 1 — Canonical `.mcp.json` rule contradiction (FIXED)

**Codex said**: The spec described forge-specific args in the canonical shape but the check only validated `args[0]` and `args[1]`, which would match `['-y', 'ci-channel', '--custom']` (customized!) as canonical and remove it — contradicting the prose that said hand-edited suffixes should be treated as customized.

**Rebuttal**: Agreed, this was internally inconsistent. I picked the tighter rule: **strict full-array equality** against the forge-specific expected args for the `--forge` passed to remove. Rationale:

1. The user already has to pass `--forge` to `remove` (they need it for the webhook DELETE call on the correct forge CLI). So we know the expected args.
2. Strict equality correctly refuses to remove any hand-edited entry, which is the safer default.
3. The tradeoff I was originally worried about (user runs setup with one forge, then remove with a different forge) is better handled by the "forge mismatch is treated as customization" rule I added — the entry is left alone and a warning fires, which is correct because the user probably ran remove against the wrong forge.

**Changes**: rewrote the "Canonical entry check" section entirely. Added `JSON.stringify` full-array equality rule, the forge-specific expected-args table, the `--gitea-url` trailing-slash normalization note, and the forge-mismatch explanation. Removed the confusing "Why args[0]/args[1] only" rationale.

## Codex Issue 2 — Idempotency contradiction (FIXED)

**Codex said**: "Desired State" claimed re-running remove was idempotent and exited 0. "Success Criteria" and "Idempotency" sections said the second run fails fast with exit 1. Pick one.

**Rebuttal**: Agreed, this was a drafting error. The correct behavior is **fail fast with exit 1 on the second run**, because `state.json` is gone and that's the precondition. The word "idempotent" was misleading — this is not POSIX-rm-style "no-op if already gone," it's "state.json is the source of truth, and the correct answer when it's missing is 'not installed here'."

**Changes**:
- Rewrote the "Desired State" paragraph to explicitly say the second run exits 1, and to explain why (not idempotent exit-0 is a deliberate design choice, more informative for scripts).
- Rewrote the first Success Criteria bullet to match.
- Added a clarifying explanation at the top of the "Idempotency" section that `state.json` is the single source of truth.

## Codex Issue 3 — `state.json` validity under-specified (FIXED)

**Codex said**: The spec required `state.json` to exist but didn't say what happens if it exists and is malformed, unreadable, or missing `smeeUrl`. The current `loadState()` helper swallows errors and returns `{}`, which would silently mask these cases.

**Rebuttal**: Agreed — this was a real gap and Codex correctly identified that using `loadState()` would conflate "missing" with "corrupt."

**Changes**: Expanded the "Required vs optional preconditions" section to enumerate three distinct failure sub-cases:
1. File missing → `no ci-channel install detected` (original rule, unchanged).
2. File present but unreadable or invalid JSON → `state.json is unreadable or malformed`.
3. File present and parses but `smeeUrl` is missing/empty/not-a-string → `state.json is missing a 'smeeUrl' field`.

Also added an explicit instruction: **the implementation MUST NOT use `loadState()`** for remove's precondition check. It must use `readFileSync` + `JSON.parse` directly in a try/catch, so that the three cases can be distinguished. Added a new Success Criteria bullet for this specific invariant. Added a new mandatory test (R10) covering the missing-`smeeUrl` case with the assertion that no mutation happens before fail-fast.

## Codex Issue 4 — 404 list vs 404 delete ambiguous (FIXED)

**Codex said**: One section said "404 during the match lookup or the DELETE call is not an error," while the helper budget section said 404-on-list = "not found" (error) and 404-on-DELETE = "already gone" (not error). The latter is correct.

**Rebuttal**: Agreed — the "404 on list is fine" line was wrong. A 404 on list means the repo/project itself is inaccessible (which is how the existing `classifyForgeError` already handles it), and silently proceeding would orphan the webhook if it does exist.

**Changes**: Added a dedicated "### 404 handling (disambiguated)" subsection that explicitly states:
- 404 on LIST `/hooks` → hard failure (repo/project not found), exit 1.
- 404 on DELETE `/hooks/{id}` → soft (webhook already gone), log and continue.

Also added implementation guidance: two options for plumbing the distinction through (Option A: `classifyForgeError` takes a `context: 'list' | 'delete'` parameter; Option B: local try/catch around the DELETE call). The plan phase picks one. I provided the Gitea-specific variant too (wrap the Gitea DELETE call locally or pass `context` into `giteaFetch`).

Updated the "Hard failures" and "Soft handling" lists in the Idempotency section to reflect this. Added mandatory scenario R9 that exercises the 404-on-DELETE race explicitly — it asserts the DELETE call fails with stderr containing `HTTP 404: Not Found` and the remove continues and exits 0.

Updated success criteria bullet on webhook 404 handling to explicitly distinguish list-404 from delete-404.

## Claude Minor Concerns (ADDRESSED)

Claude approved, but flagged several minor items. All folded in:

1. **R1 `--paginate --slurp` response shape**: added explicit note that the test fake must return a nested array `[[{...}]]` if remove uses `--paginate --slurp` (matching setup's pattern), or a flat array if remove uses plain `gh api`. The plan phase picks the invocation shape and the test matches.

2. **`.mcp.json` with non-object `mcpServers`**: added a "Defensive shape handling" note requiring remove to log a warning and skip if `mcp.mcpServers` is not an object (rather than silently proceed as setup's `?? {}` fallback would).

3. **`classifyForgeError` DELETE-404 mechanism**: addressed in the new "404 handling" section — plan phase picks Option A or Option B. Either is acceptable; just commit to one.

4. **`findProjectRoot()` null-return**: added explicit precondition bullet requiring remove to mirror setup's "No project root found" error and exit 1.

5. **"Wait — that's backwards" paragraph**: rewritten cleanly. The invariant is now stated once as "state.json exists iff the install is active on the local side."

6. **Line-cap feasibility**: Claude's concern is valid — ~385–395 projected landing zone is tight. This is already called out in the spec's "Pre-budget" section with mandatory `parseSetupArgs` merge and explicit escalation path. No change needed; the plan phase will have to execute carefully.

7. **R10 promoted to mandatory?**: I disagree here — the original R10 (end-to-end setup→remove round-trip) is valuable but complex because it requires two fake-gh instances with different response sets. The core inverse contract is already covered by R1 (happy path forward) + setup's existing tests. I kept R10 as optional. However, I added the more targeted R9 (404-during-DELETE race) and R10-new (invalid state.json) as mandatory, which exercise the trickier edge cases directly.

## Gemini Informational Notes (PLAN-PHASE ITEMS)

Gemini approved but flagged three implementation details. These are for the plan phase, not spec changes:

1. **`giteaFetch` 404 handling**: The existing `giteaFetch` throws on 404 with `Could not find Gitea repo`. For DELETE-404, remove must either wrap the call in a local try/catch (Option B from the 404 section), or parameterize `giteaFetch` with a context flag (Option A). The spec now calls this out in the 404 handling section.

2. **`classifyForgeError` return-type change**: If Option A is chosen, `classifyForgeError` either returns a null sentinel on soft-404 or the caller checks the context before throwing. Plan-phase decision.

3. **`loadState` returning `{}` on missing**: This is already addressed by the new "state.json validity" rule (don't use `loadState`, use direct `readFileSync` + `JSON.parse`).

## Summary of spec changes

- **Desired State** paragraph: rewrote the re-run idempotency claim.
- **Success Criteria**: rewrote 3 bullets to match the new precondition rules, split the 404 handling bullet into list-404 vs delete-404.
- **Required vs optional preconditions**: expanded with project-root, 3 state.json sub-cases, defensive shape handling for `.mcp.json`.
- **Canonical entry check**: rewrote entire section with strict full-array equality, forge-specific expected-args table, `--gitea-url` normalization rule, and forge-mismatch explanation.
- **404 handling**: new dedicated subsection disambiguating list-404 (hard) vs delete-404 (soft) with two implementation options.
- **Idempotency**: rewrote opening with "state.json is the source of truth" framing; expanded Hard failures and Soft handling lists.
- **Order of operations**: step 3 now says "Read and validate state.json"; step 5 references the new 404 handling section; removed the confusing "Wait — that's backwards" paragraph.
- **Test Scenarios**: R1 clarified with `--paginate --slurp` response shape note. R9 promoted to mandatory (404-during-DELETE race). R10 updated (invalid state.json). Minimum mandatory coverage raised from 8 to 9 tests.
- **Test budget**: unchanged caps; 9 mandatory + 1 optional.

## Line count after changes

- `codev/specs/8-spec-8-feat-ci-channel-remove-.md`: 551 lines (up from 500). The spec file itself has no line cap — only `lib/setup.ts` and `tests/setup.test.ts` do.

## Ready for re-review

All four Codex issues resolved with concrete spec changes. Claude's minor items addressed inline. Gemini's implementation notes captured in the relevant spec sections for the plan phase to pick up. No open ambiguity remains.
