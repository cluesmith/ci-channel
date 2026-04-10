# Specification Rebuttals — Iteration 1

**Project**: 3 — feat: Interactive installer (`ci-channel setup`)
**Iteration**: 1
**Date**: 2026-04-10

## Review Verdicts

| Reviewer | Verdict | Confidence |
|----------|---------|------------|
| Codex (GPT-5) | REQUEST_CHANGES | HIGH |
| Gemini Pro | APPROVE | HIGH |
| Claude (Opus) | COMMENT | HIGH |

Codex requested changes; Claude flagged contradictions/gaps as comments; Gemini approved with minor notes. All reviewer points were substantive and actionable — no bad-faith or off-base feedback. Rebuttal below addresses each item.

---

## Codex Issues (REQUEST_CHANGES)

### 1. `.env` ownership and precedence conflict with current runtime model

**Codex's point**: The spec said the installer would write `WEBHOOK_SECRET` into `.env`. But the current runtime model treats `state.json` as auto-provisioned state and `.env` as a user override. Writing to `.env` would invert precedence and muddy ownership.

**Verdict**: **Agreed.** This was a real mismatch, not a nit. The issue text mentioned writing `.env`, but on closer inspection of `lib/bootstrap.ts` and `lib/config.ts`, the runtime expects `.env` to be user-supplied only.

**Change made**: Removed `.env` writes entirely from the installer. The installer now writes *only* `state.json`. `.env` is explicitly called out as "reserved for user-managed overrides, not touched by the installer". Updated:
- Clarifying question #5 now says `.env` is not written
- Desired State step 3 drops the `.env` reference
- Installer Step Sequence step 5 drops it
- Success criteria drop the `.env` write check
- Test scenario 1 (happy path) verifies no `.env` is written
- Security section clarifies the one-source-of-truth model

### 2. Non-interactive flag semantics inconsistent

**Codex's point**: The spec said `--repo` is required, but elsewhere said missing `--repo` should prompt in `--dry-run`, while success criteria said `--yes` must fail fast. The `setup --dry-run --yes` case was undefined.

**Verdict**: **Agreed.** This was genuinely contradictory. I hadn't worked through every cell of the matrix.

**Change made**: Added an explicit "Interactive / non-interactive matrix" in the Subcommand Surface section. The matrix covers all combinations of TTY, `--yes`, `--dry-run`, and missing `--repo`, plus a one-sentence rationale. Key rules:
- `--yes` means "no prompts allowed" — if `--repo` is missing with `--yes`, fail fast regardless of `--dry-run`.
- Non-TTY + no `--yes` → fail fast (cannot prompt).
- Only TTY + no `--yes` prompts for `--repo`.

New test scenarios 6, 7, 8 exercise each branch of the matrix.

### 3. Idempotency rules contradict `--smee-url` override behavior

**Codex's point**: The spec said "never overwrites", but test scenario 12 required `--smee-url` to update state.json when it differs. That is an overwrite.

**Verdict**: **Agreed.** The word "never" was too strong for the actual intent.

**Change made**: Rewrote the Idempotency Rules table. Added explicit override rows for `--smee-url`:
- Matching stored value → no-op
- Differing stored value → **explicit override** with spelled-out semantics (update state.json, reuse existing webhook secret, create new webhook, leave old webhook in place, print a warning)
- Missing stored value → use CLI value (not technically an override)

Rewrote the closing sentence: the one user-driven exception to "no destructive writes" is `--smee-url` override, and its consequences are documented.

Added tests 15 and 16 to cover both "override differs" and "override matches" cases.

### 4. `.mcp.json` malformed/non-object handling is unspecified

**Codex's point**: The spec handled missing file and existing `ci` entry, but not invalid JSON, top-level arrays, `mcpServers` being non-object. These are real footguns since `.mcp.json` corruption is high-impact.

**Verdict**: **Agreed.** I was thinking about the happy path and skipped the degenerate-input cases.

**Change made**: Step 8 now contains an explicit 7-row handling matrix:
- Missing file → create
- Valid with `mcpServers.ci` → skip
- Valid with `mcpServers` object, no `ci` → merge
- Valid with no `mcpServers` → add `mcpServers`
- `mcpServers` not an object → fail fast
- Top-level not an object → fail fast
- Invalid JSON → fail fast

All fail-fast cases leave the file untouched. The "fail fast after earlier steps succeeded" scenario is acknowledged — state.json and the webhook may have been written already, which is fine because the error is reportable and the fix is trivial (hand-edit `.mcp.json` and re-run).

Added tests 20, 21, 22 covering the malformed shapes, and test 23 for the multi-server merge case.

### 5. Legacy global-state compatibility

**Codex's point**: Runtime `loadState` still falls back to `~/.claude/channels/ci/` when no project root is detected. The spec didn't say whether `setup` should read/migrate/ignore/warn about legacy global state.

**Verdict**: **Agreed** — this deserved explicit treatment given the "must not break existing installs" constraint.

**Change made**: Added clarifying question #11 stating the installer always writes project-local state and never reads, migrates, or deletes legacy global state. Test scenario 26 verifies the installer does not touch a pre-existing global state file; it emits a one-line informational note if global state happens to exist, so users aren't confused about why their old install isn't being picked up.

---

## Gemini Issues (APPROVE with notes)

### 1. Stdio isolation vs. stdin payload contradiction

**Gemini's point**: `stdin: 'ignore'` prevents passing a payload to `gh api --input -`. Use `stdio: ['pipe', 'pipe', 'pipe']` or `execFile` with the `input` option.

**Verdict**: **Agreed.** Same issue Claude flagged in its point 1 — this was a real contradiction.

**Change made**: Rewrote the subprocess constraint in the Technical Constraints section. The new text explains:
- The actual invariant is "don't inherit `process.stdin`" (so the child doesn't steal bytes from the MCP JSON-RPC stream).
- `stdin: 'ignore'` is one way to achieve that, but `stdio: ['pipe', 'pipe', 'pipe']` with an explicit write is another — and the only one compatible with `gh api --input -`.
- A third option (temp file with `--input /path/to/file.json`) is explicitly allowed.
- The setup subcommand is never invoked from inside the running MCP server, so the risk is lower, but the invariant is preserved for consistency.

Security section also now covers the temp-file approach (`mode 0600`, `os.tmpdir()`, cleanup in `finally`).

### 2. Dynamic import for subcommand dispatch

**Gemini's point**: Use `const { runSetup } = await import('./lib/setup/index.js')` so the normal MCP server path doesn't load `@inquirer/prompts`.

**Verdict**: **Agreed.** This is standard practice for subcommand-style CLIs and is worth specifying now so the plan phase doesn't flip-flop.

**Change made**: Added a new bullet to Technical Constraints: "Dynamic import of the installer module... must use `await import('./lib/setup/index.js')` inside the `setup` branch, not a top-level import."

### 3. `.env` writing utility

**Gemini's point**: `lib/config.ts` only has a `parseEnvFile` helper, no writer. Builder would need a `saveEnv` utility.

**Verdict**: **N/A after fix #1** — once `.env` writing is removed entirely (Codex issue 1), there's no need for a `saveEnv` utility. This is resolved implicitly by removing the feature.

---

## Claude Issues (COMMENT)

### 1. `stdin: 'ignore'` contradicts `gh api --input -`

Same as Gemini issue 1. Resolved by the subprocess-constraint rewrite. Both pipe-stdin and temp-file approaches are explicitly allowed.

### 2. TTY handling for interactive mode unspecified

**Claude's point**: `@inquirer/prompts` throws on non-TTY. Without a policy, CI runs and piped input crash.

**Verdict**: **Agreed.** Should have been in the original spec.

**Change made**: Added clarifying question #10 (explicit TTY behavior), a new success criterion, the non-interactive matrix (which covers non-TTY as a first-class case), and test scenario 7 (non-TTY + no `--yes` → fail fast).

### 3. `.env` + `state.json` write duplication

Same as Codex issue 1. Resolved by removing `.env` writes.

### 4. "Not yet implemented" wording for GitLab/Gitea is misleading

**Claude's point**: The MCP server already supports GitLab and Gitea. Saying the installer "doesn't yet implement" them would alarm users with working GitLab/Gitea setups into thinking their runtime was broken.

**Verdict**: **Agreed.** This was poor phrasing; I should have distinguished "installer doesn't support" from "plugin doesn't support".

**Change made**: The success criterion and fail-fast message now read:
> `setup` subcommand only supports GitHub in v1 — the MCP server itself supports all three forges; use the manual install flow in INSTALL.md for GitLab/Gitea.

Test scenario 9 verifies the message contains the specific "MCP server itself supports all three forges" clarifier.

### 5. `--smee-url` vs idempotency contradiction

Same as Codex issue 3. Resolved by the idempotency matrix rewrite, which spells out override semantics (reuse secret, new webhook, leave old in place).

### 6. Webhook list pagination

**Claude's point**: `gh api repos/OWNER/REPO/hooks` returns first 30 by default. Repos with more than 30 hooks would produce false negatives in the idempotency check.

**Verdict**: **Agreed.** This is exactly the kind of silent failure mode that a pre-impl spec should catch.

**Change made**: Step 6 and the Idempotency Rules now both specify `gh api --paginate repos/OWNER/REPO/hooks`. Added test scenario 13 that mocks multi-page responses where the matching hook is on a later page.

### 7. `ensureSecretReal` has no path parameter

**Claude's point**: The spec said "reuse `ensureSecretReal`", but that function internally calls `loadState()` with no args, which resolves via `findProjectRoot(process.cwd())`. That happens to align with the installer, but it's a foot-gun worth flagging for the plan phase.

**Verdict**: **Agreed.** Worth calling out explicitly so the plan doesn't drift.

**Change made**: Added a clause to the "reuse existing code" constraint explicitly noting that `ensureSecretReal` takes no explicit path, that the cwd-alignment is load-bearing, and that the plan phase must either (a) confirm cwd-alignment works for each call site or (b) add a helper overload. `saveState`/`loadState` are already explicit-path-capable.

### 8. `lib/setup/` directory convention

**Claude's point**: The rest of `lib/` is flat; a subdirectory needs a one-line justification.

**Verdict**: **Agreed.** Cheap to justify now; avoids a plan-phase debate.

**Change made**: Added one sentence to the TypeScript constraint: "the installer has several tightly-coupled files (arg parsing, prompt runner, `.mcp.json` merger, `gh` wrapper) that benefit from grouping. Nothing outside the installer imports from `lib/setup/`."

---

## Summary of Changes

**Spec file**: `codev/specs/3-feat-interactive-installer-ci-.md`

Substantive changes in this iteration:
- Clarifying questions: 2 new (#10 TTY, #11 legacy state); #5 rewritten
- Desired State: step 3 updated (no `.env`)
- Success Criteria: TTY criterion added, forge messaging clarified, `.env` removed
- Technical Constraints: stdin/stdio rule rewritten, dynamic import added, `ensureSecretReal` path note added, `lib/setup/` justification added
- Subcommand Surface: Interactive/non-interactive matrix added
- Installer Step Sequence: step 5 (`.env` removed), step 6 (`--paginate` required), step 8 (7-row `.mcp.json` matrix)
- Idempotency Rules: explicit override rows for `--smee-url` with full semantics
- Security: state.json `chmod 600`, `.env` not written, temp-file approach covered
- Test Scenarios: expanded from 16 to 27 with new coverage (TTY matrix, malformed JSON shapes, pagination, `--smee-url` override branches, missing `gh`, legacy state)
- Expert Consultation section added with full iteration 1 summary

No reviewer feedback was rejected. Two items were marked N/A: Gemini's `saveEnv` utility note became unnecessary once `.env` writes were removed (Codex fix 1), and one minor Claude point about directory convention was treated as a nit-worth-addressing.

**Unresolved**: None. All REQUEST_CHANGES items from Codex addressed; all COMMENT items from Claude addressed; Gemini's technical suggestions incorporated.

Ready for re-verification.
