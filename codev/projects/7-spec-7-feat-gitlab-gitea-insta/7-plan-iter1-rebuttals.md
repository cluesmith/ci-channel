# Plan 7 — Iteration 1 Rebuttals

Three reviewers consulted: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude (COMMENT). All substantive concerns were folded into the plan revision committed as `[Spec 7] Plan with multi-agent review`. The plan already contains a full "Plan iteration 1" subsection in the "Expert Review" area — this rebuttal summarizes the dispositions for porch's rebuttal gate.

## Codex (REQUEST_CHANGES)

### Finding 1 — Phase 1 cannot pass its own test gate as written

**Feedback**: Phase 1 modifies `lib/setup.ts` to accept `--forge gitlab` as valid input, but Phase 1 does NOT modify `tests/setup.test.ts:194`, which currently asserts that the same argv fails with `/unexpected arg: --forge/`. The two are mutually exclusive — Phase 1's `npm test` acceptance gate cannot pass. Either move the Scenario 8 modification into Phase 1 or relax the gate.

**Disposition**: **ACCEPTED, FIXED.** Moved the Scenario 8 modification into Phase 1 as a minimal test-file edit (not a new test scenario). Phase 1's "Files" list now includes `tests/setup.test.ts` with an explicit "Scenario 8 modification" subsection showing the exact before/after diff. Phase 1 acceptance criteria gained an item: `Scenario 8 in tests/setup.test.ts has been updated to use --nonsense (or similar truly-unknown flag) instead of --forge gitlab`. Test count remains unchanged in Phase 1.

### Finding 2 — `package-lock.json` version bump is missing

**Feedback**: Releasing v0.4.0 requires updating both the root `version` field (line 3) and the first package block `version` field (line 9) of `package-lock.json`, not just `package.json`.

**Disposition**: **ACCEPTED, FIXED.** Confirmed via `grep -n 'version' package-lock.json` that both fields exist at the expected line numbers. Phase 1's "Files" list now includes `package-lock.json` with an explicit note that BOTH version fields need updating and that no `npm install` rerun is needed (no dependencies change). Phase 1 acceptance criteria gained an item: `package-lock.json version is 0.4.0 at BOTH the root (line 3) AND the first package block (line 9)`.

### Finding 3 — Codev Windows testing notes are self-contradictory

**Feedback**: Codev scenarios (16–18) are described as running on all platforms because they "don't require fake CLIs," but they reuse the GitHub setup path which relies on a POSIX shell script fake `gh`. Either skip them on win32 too, or make `mkFakeCli` cross-platform.

**Disposition**: **ACCEPTED, FIXED.** The "run on all platforms" note was wrong. Updated "Test implementation constraints" to say: "Codev scenarios (16–18) ALSO skip on win32 — they reuse the GitHub fake-gh setup (a POSIX shell script at `mkFakeCli(bin, 'gh', ...)`), so inherit the same platform-skip as Scenarios 1–6." Making `mkFakeCli` cross-platform is a non-goal that would add complexity without benefit (the whole of setup is unused on Windows for ci-channel's target audience).

### Finding 4 — `GITEA_TOKEN` env mutation needs restoration

**Feedback**: Scenario 14 mutates/unsets `process.env.GITEA_TOKEN`, and developer/CI environments may already have the variable set. Without restoration, tests can be order-dependent and leak state into later cases.

**Disposition**: **ACCEPTED, FIXED.** Added explicit restoration requirement: any test touching `process.env.GITEA_TOKEN` must save/restore via `try/finally`. Preferred implementation extends `inProject` to also save/restore `GITEA_TOKEN` on every entry (4-line addition, same pattern already used for `PATH` and `cwd`). This eliminates per-scenario boilerplate and prevents the leak across all affected scenarios (12–15).

### Finding 5 — `classifyForgeError` messages don't exactly match spec text

**Feedback**: The planned `classifyForgeError` sketch for GitLab `ENOENT` (`Install and authenticate it, then retry.`) and GitLab `403` do not match the spec's stated messages. If the reviewer diffs against the spec, this will churn iterations.

**Disposition**: **ACCEPTED, FIXED.** Rewrote the `classifyForgeError` sketch to use verbatim error strings from the spec's "Error classification" sections. Notable: the ENOENT messages now include the exact install URLs (`https://cli.github.com/` for gh, `https://gitlab.com/gitlab-org/cli` for glab), the 404 messages use "repo" vs "project" appropriately, and the 403 messages have fully distinct text (gh's mentions `admin:repo_hook` + `gh auth refresh`; glab's mentions `project maintainer/owner permission and the 'api' scope` + `glab auth login`). Added a Phase 1 acceptance criterion to verify: `classifyForgeError error messages match the spec's "Error classification" sections verbatim`.

## Gemini (APPROVE)

### Finding 1 — `classifyForgeError` fallback `String(err)` can render `[object Object]`

**Feedback**: If `cliApi` rejects with a plain object like `{ bin, code, stderr, args }`, the fallback `new Error(String(err))` will evaluate to `"[object Object]"`, hiding the useful diagnostic information. Reconstruct the message from the object's fields instead.

**Disposition**: **ACCEPTED, FIXED.** The sketch's last-resort branch is now `new Error(\`${bin} ${(err?.args ?? []).join(' ')} exited ${err?.code ?? '?'}: ${stderr.trim()}\`)`. Preserves the existing `err instanceof Error ? err : ...` short-circuit above it for cases where `cliApi` rejects with a real `Error`. Phase 1 acceptance criteria gained an item for this.

### Finding 2 — Use exact spec ENOENT strings with install URLs

**Feedback**: The sketch had a generic "`${bin} CLI not found. Install and authenticate it, then retry.`" message for both forges. The spec specifies per-forge install URLs.

**Disposition**: **ACCEPTED, FIXED** (same fix as Codex #5 — the message alignment task covered both ENOENT and 403/404 cases).

## Claude (COMMENT)

### Finding 1 — Codev scenarios 16-18 skip-on-win32 self-contradiction

**Feedback**: Same root cause as Codex #3.

**Disposition**: **ACCEPTED, FIXED** (same fix as Codex #3).

### Finding 2 — Scenario 15 relies on `loadState` returning partial state

**Feedback**: The rewrite of Scenario 15 to seed `state.json` with only `smeeUrl` (no `webhookSecret`) depends on `loadState` returning a partial `PluginState` object with individual fields possibly undefined. Builder should verify this shape during implementation.

**Disposition**: **ACCEPTED, CLARIFIED.** Added a note to "Test implementation constraints" explaining the expected flow: `loadState` → `smeeUrl` present, `webhookSecret` undefined → installer generates fresh secret → writes state (state-first) → hits Gitea API → 401 → exits 1. This is the same pattern as existing Scenario 5, which verifies the shape is correct. Added a fallback strategy if the pattern breaks at impl time.

### Finding 3 — Phase 1 grep acceptance criterion has shell-quoting ambiguity

**Feedback**: `grep -E "'--method', 'PUT'" lib/setup.ts` uses quoted-string matching that a reviewer may stumble on during runtime (nested quoting). Restate as a code-review check.

**Disposition**: **ACCEPTED, FIXED.** Rewrote the acceptance criterion to: `GitLab branch uses PUT for updates, not PATCH (code review — reviewer reads lib/setup.ts and confirms the glab api call for the update path uses '--method', 'PUT' as the argv sequence; no grep shell-quoting gotcha)`. Keeps the verification specific enough to catch the PUT-vs-PATCH trap without depending on shell escaping.

### Finding 4 — Optional belt-and-suspenders fake `gh` adds lines

**Feedback**: The plan's Phase 2 risk-mitigation section suggests writing a fake `gh` in GitLab tests that exits non-zero, as a defensive measure against accidental real-`gh` calls. Given the tight 400-line test-file budget, this adds lines for negligible benefit.

**Disposition**: **ACCEPTED, DROPPED.** Updated the risk mitigation to explicitly say: "Do NOT add a belt-and-suspenders fake `gh` that exits non-zero — that costs lines against the tight 400-line budget for negligible benefit." If GitLab tests accidentally spawn real `gh`, the resulting behavior will be obvious in the test failure.

### Finding 5 — `codev/resources/arch.md` section existence

**Feedback**: The plan commits to "one line added under the setup section" of `arch.md`. Builder should verify the file exists and has an appropriate section before editing.

**Disposition**: **ACCEPTED, CLARIFIED.** Verified the file exists (`ls codev/resources/` returns `arch.md`, 250 lines). Added a note to the "Files" section that the builder should verify `arch.md` has an appropriate "Key components" or setup-related section before editing; if the file doesn't mention `setup.ts` at all, the update is a no-op and can be skipped without blocking the PR.

## Summary

- **Gemini**: APPROVE, 2 minor notes, both accepted and fixed
- **Codex**: REQUEST_CHANGES, 5 findings, all accepted and fixed
- **Claude**: COMMENT, 5 minor issues, all accepted and fixed

**Nothing was rejected.** Every review point was implemented. The plan grew from ~498 lines to ~573 lines. The most consequential change is the Scenario 8 move from Phase 2 to Phase 1 — this fixes an internal contradiction that would have blocked Phase 1's test gate.

Under ASPIR, no second consultation round is required — the plan auto-approves on porch `done` after verification checks pass.
