# Spec 7 — Iteration 1 Rebuttals

Three reviewers consulted: Gemini (COMMENT), Codex (REQUEST_CHANGES), Claude (COMMENT). All substantive concerns were folded into the spec revision committed as `[Spec 7] Specification with multi-agent review`. This document lists each review point and the disposition.

## Codex (REQUEST_CHANGES)

### Finding 1 — Gitea token validation vs state-first ordering

**Feedback**: Spec says common flow steps 3–6 generate/fetch/write `state.json` before forge-specific API work, but the Gitea section says missing `GITEA_TOKEN` must "fail fast". Unclear whether the token check happens before or after smee/state provisioning.

**Disposition**: **ACCEPTED, FIXED.** Reworked the common-flow numbering so that the token check is an explicit step 3 ("Forge-specific input validation"), executed BEFORE state provisioning. Added a dedicated subsection "Gitea token check ordering (resolves state-first vs fail-fast tension)" that spells out the rationale: a missing token is a user-error configuration gap, not an operational failure, and should short-circuit before any smee channel is burned or state is written. Scenario 6 was tightened to explicitly assert that no HTTP request is made AND no `state.json` is written when the token is missing.

### Finding 2 — Codev "byte-equal" wording is too strong

**Feedback**: "Do not change any other field … must remain byte-equal when re-serialized" is inaccurate — `JSON.parse` + `JSON.stringify(null, 2)` preserves content and key order but NOT original whitespace/formatting. The intended requirement is "only mutate `shell.architect`; write with canonical 2-space JSON when a change is made."

**Disposition**: **ACCEPTED, FIXED.** Rewrote step 5 of the Codev section to say: "This produces canonical 2-space-indented JSON with a trailing newline. The only semantic change from the input is that `config.shell.architect` now ends with the appended flag; all other keys and values round-trip through `JSON.parse`/`JSON.stringify` unchanged in both content and order. Formatting and whitespace of the output file will be canonical 2-space JSON regardless of how the input was formatted — that is intentional, not a bug." Removed the misleading "byte-equal" phrasing. Kept the ECMA-262 §24.5.2 insertion-order note as defense against a common reviewer false alarm.

### Finding 3 — Line-count discussion in "Success Looks Like" is internally confusing

**Feedback**: "bringing it from ~195 to ~345 max — under the 300-line cap means tightening the existing code too — actually: target total ≤300 lines" contains an internal correction that reads as sloppy. Reviewers are told to enforce the cap strictly; the prose should not waver.

**Disposition**: **ACCEPTED, FIXED.** Rewrote the "Success Looks Like" bullet to state the cap once, with the starting-point context: "Final `lib/setup.ts` ≤ 300 lines total. Starting from 194 lines and adding GitLab + Gitea + Codev + error-classification dedupe, the diff is likely +~100 net lines after cleanup — with the exact per-section budget in the 'Pre-budget for `lib/setup.ts`' section above." Also added a per-section pre-budget table earlier in the spec so the plan phase can catch overage early.

### Finding 4 — Gitea `Content-Type` on all requests is unusual

**Feedback**: Sending `Content-Type: application/json` on a GET request (the list call) is harmless but unusual. Better to require `Authorization` on all requests and `Content-Type` only on POST/PATCH bodies.

**Disposition**: **ACCEPTED, FIXED.** Updated the Gitea section to say "`Content-Type: application/json` on POST and PATCH requests (the ones with a JSON body). GET requests (the list call) send only `Authorization`; no `Content-Type` header."

### Finding 5 — Testing strategy should explicitly cover Gitea no-token ordering

**Feedback**: Scenario 6 (Gitea missing token) already seeds `state.json`, which does not resolve the state-first-vs-token-check ordering question because the state was pre-seeded.

**Disposition**: **ACCEPTED, FIXED.** Rewrote Scenario 6 to NOT seed `state.json`. The revised assertions are: `process.exit(1)` with stderr containing `GITEA_TOKEN not set`, no HTTP request received by the server, AND no `state.json` written. This directly locks in the step-3-before-step-7 ordering. Added a note that Scenario 6 may also cover the empty-string case (`GITEA_TOKEN=`) as a back-to-back sub-test if budget allows.

## Claude (COMMENT — with 1 blocker plus 5 minor issues)

### Finding 1 — Test 8 cannot stay "exactly as it is"

**Feedback**: The existing `tests/setup.test.ts:194-197` asserts `['--repo', 'foo/bar', '--forge', 'gitlab']` fails with `/unexpected arg: --forge/`. After Spec 7, `--forge gitlab` is valid input, so the assertion flips from pass to fail (or worse, attempts a real GitLab install and produces ENOENT). The spec's "8 pre-existing tests unchanged" criterion contradicts the design.

**Disposition**: **ACCEPTED, FIXED.** Rewrote the "Pre-existing scenarios" section to say explicitly that Scenario 8 must be modified. Provided the before/after code snippet showing the replacement assertion with a genuinely-unknown flag (`--nonsense`). Reworked the test-count math: 7 unchanged + 1 modified + ≤12 new = ≤20 total (the hard cap). Both Gemini and Claude flagged this; it is addressed once with clear guidance.

### Finding 2 — 300-line budget is tight; recommend per-section pre-budget in plan phase

**Feedback**: Adding GitLab (~45 lines), Gitea (~65 lines), Codev (~20 lines), parseArgs extensions (~10 lines), per-forge dispatch (~10 lines) comes to +150 naïve → 344 total. Reaching ≤300 requires deduplicating `GhError` into a shared helper AND compressing existing code. Cleanup of working code is itself risky. Recommend pre-budgeting per section (GitHub ≤70, GitLab ≤60, Gitea ≤80, Codev ≤20, common ≤70) in the plan phase.

**Disposition**: **ACCEPTED, FIXED.** Added a dedicated "Pre-budget for `lib/setup.ts` (300-line cap, per-section allocation)" subsection with a 10-row table allocating lines across imports / parseArgs / readEnvToken / ghApi / error classification helper / common flow / GitHub / GitLab / Gitea / Codev. Total estimate is intentionally pessimistic at ~302 lines to give the plan phase early warning. Explicit directive added: the plan's Phase 1 acceptance criteria MUST include `wc -l lib/setup.ts ≤ 300`; if the plan phase projects higher, it must either tighten, simplify, or escalate — not quietly propose 325. The cap is the cap.

### Finding 3 — `.env` parser doesn't handle `export KEY=value` prefix

**Feedback**: Real `.env` files sometimes ship with `export` prefixes (some projects source them directly in shells). The spec's 15-line parser doesn't strip that, so a user with `export GITEA_TOKEN=...` may hit "token not set" and be confused.

**Disposition**: **ACCEPTED, FIXED.** Added `line.replace(/^export\s+/, '')` to the parser. Parser grew by 1 line (17 total). Updated the parser's scope note to list the forms it handles (`KEY=value`, `export KEY=value`, quoted values) and the forms it does NOT (multi-line values, `${VAR}` expansion, escape sequences).

### Finding 4 — `GITEA_TOKEN` empty-string precedence

**Feedback**: Spec says `process.env.GITEA_TOKEN` first. What if the env var is set but empty? Recommend: "missing OR empty string after trim".

**Disposition**: **ACCEPTED, FIXED.** Added explicit wording in the "Gitea token check ordering" subsection: "Either source counts as 'present' if the value, after trimming, is a non-empty string. An unset var AND an empty-string value AND a `.env` file without the key ALL fail with the same 'GITEA_TOKEN not set' error." Scenario 6 was extended to (optionally, budget permitting) cover the empty-string sub-test.

### Finding 5 — Codev `JSON.parse` failure after successful webhook install

**Feedback**: If `.codev/config.json` exists but throws on parse, the current design lets it flow through the top-level catch and exit 1. That means the user sees "setup failed" AFTER the webhook was already registered and `.mcp.json` was written. Re-running hits the PATCH path so it's recoverable, but the exit-1 on partial success is surprising. Consider: catch the Codev step specifically and log a warning + exit 0.

**Disposition**: **ACCEPTED, FIXED (reversing earlier spec decision).** This was explicitly NOT in the original spec and the rebuttal author initially thought the "fail loud" rule should win. On reflection, Claude's point is correct: the failure semantics matter more for user experience than for consistency with Spec 5's rule. Added a new subsection "Codev failure containment" that wraps the Codev step in a local `try/catch` that logs a warning and continues with exit 0. Explicitly called out as the **only** scoped exception to Spec 5's "single top-level try/catch" rule. Rationale: webhook is already live when Codev runs, so exit-1 misleads the user into thinking nothing worked.

### Finding 6 — `--forge` error message should mention lowercase requirement

**Feedback**: If a user passes `--forge GITLAB` (uppercase), the generic "must be one of: github, gitlab, gitea" message doesn't tell them their mistake was capitalization. One-line clarification recommended.

**Disposition**: **ACCEPTED, FIXED.** Updated the `--forge` validation spec line to: "Any other value (including uppercase variants like `GitLab`, or typos like `githb`): fail fast with a usage message that lists the three valid values AND explicitly notes the lowercase requirement. Example: `Invalid --forge 'GitLab'. Must be one of: github, gitlab, gitea (lowercase).`"

## Gemini (COMMENT)

### Finding 1 — Test 8 Contradiction

**Feedback**: Same as Claude's Finding 1.

**Disposition**: **ACCEPTED, FIXED** (same fix as Claude Finding 1).

### Additional notes on feasibility

Gemini endorsed the 300-line cap as "tight but achievable" given the `ghApi`/`glabApi` consolidation into a parameterized `cliApi` function, and endorsed the 400-line test cap as "generous enough for ~10 new tests". Also confirmed that Node's `JSON.stringify` guarantees enumeration order per ECMA-262. No action needed on these — they are validations, not requests.

## Summary

- **Codex**: 5 findings, all accepted and fixed
- **Claude**: 6 findings (1 blocker + 5 minor), all accepted and fixed
- **Gemini**: 1 finding, already covered by Claude's fix

**Nothing was rejected.** Every review point was either implemented verbatim or, in two cases (the `--forge` error example and the Codev failure-containment decision), implemented slightly more comprehensively than the reviewer suggested. The spec grew from ~470 lines to ~566 lines.

Under ASPIR, no second consultation round is required — the spec auto-approves on porch `done` after verification completes.
