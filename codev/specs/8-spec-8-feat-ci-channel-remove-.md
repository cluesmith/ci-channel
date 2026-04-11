# Specification: `ci-channel remove` command

## Metadata
- **ID**: spec-2026-04-11-ci-channel-remove
- **Status**: draft
- **Created**: 2026-04-11
- **Issue**: cluesmith/ci-channel#8
- **Protocol**: ASPIR (autonomous, no human gates on spec/plan)
- **Builds on**: Spec 5 (`ci-channel setup` simpler installer) and Spec 7 (GitLab + Gitea installer + Codev auto-integration) — merged as v0.4.0 in commit c3f91c6.

## Context — Where We Are Coming From

v0.4.0 shipped a three-forge installer (`ci-channel setup`) that registers a webhook, writes `state.json`, merges `.mcp.json`, and optionally updates `.codev/config.json`. The complementary operation — uninstall — still has to be done by hand:

1. Delete the webhook on the forge UI (GitHub / GitLab / Gitea).
2. Delete `<project-root>/.claude/channels/ci/state.json`.
3. Remove the `ci` entry from `.mcp.json` by hand.
4. If the project uses Codev, un-edit `.codev/config.json` to strip `--dangerously-load-development-channels server:ci` from `shell.architect`.

Every step is easy to forget or do wrong. A user who ran `ci-channel setup` should be able to run `ci-channel remove` and get the project back to its pre-setup state (minus the smee channel URL, which is externally provisioned and not owned by `ci-channel`).

**Explicit carry-over from Spec 5 and Spec 7**: every constraint that is not loosened below still applies. Single file, no DI, no new dependencies, no prompts, no dry-run, progress output at each step, classify forge errors into actionable messages. The cap on `lib/setup.ts` is raised from 300 to 400 lines to accommodate the remove path. Everything else is unchanged.

## Problem Statement

`ci-channel setup` is a one-command install. There is no one-command uninstall. Users who want to remove the channel — because they're offboarding a project, switching to a different notification system, or just trying something out — must reverse four discrete changes manually, across two local files and one forge API. Each of the four steps has a "did I do it right?" moment that the user has to verify themselves.

The result is that `ci-channel` installs look hard to undo, which makes them feel risky to try. That's the full extent of the problem. This spec is NOT about recovery, audit trails, or any broader "installation management" framework. It's just "match the install with an uninstall."

## Current State

To uninstall `ci-channel` from a project today, a user must:

1. Open the forge UI (or run a hand-crafted `gh api DELETE` / `glab api --method DELETE` / `curl -X DELETE` command) to find and delete the webhook. The webhook is identified by its smee channel URL, which is stored in `<project-root>/.claude/channels/ci/state.json`. If the user deletes `state.json` first, they lose the smee URL needed to identify the webhook.
2. Delete `<project-root>/.claude/channels/ci/state.json` manually. If the directory `.claude/channels/ci/` contains other files (it shouldn't, but the user might have put something there), the user has to know to leave them alone.
3. Open `.mcp.json`, find the `ci` key under `mcpServers`, delete it, preserve the JSON formatting. This is a hand edit prone to introducing syntax errors.
4. If `.codev/config.json` exists, find the `shell.architect` string and strip the exact token `--dangerously-load-development-channels server:ci` out of it. This is a string edit that may or may not leave stray whitespace.

None of this is hard. All of it is easy to get subtly wrong.

## Desired State

```bash
# GitHub (default)
ci-channel remove --repo owner/repo

# GitLab
ci-channel remove --forge gitlab --repo group/project

# Gitea
ci-channel remove --forge gitea --gitea-url https://gitea.example.com --repo owner/repo
```

Each command, in one invocation, reverses everything `ci-channel setup` did (or would have done) for that forge against that repo:

- Finds the forge-side webhook by smee-URL match, deletes it via the forge API.
- Deletes `<project-root>/.claude/channels/ci/state.json`.
- Removes the `ci` entry from `.mcp.json` **if and only if** the entry is the canonical one written by setup. If the user customized it, leave it alone with a warning.
- If `.codev/config.json` exists and its `shell.architect` string contains the loader flag, strips the flag (and any single leading space) from the string and writes the file back.
- Prints a summary of exactly what changed, in the same `[ci-channel] ...` progress-line style as `setup`.

Re-running `ci-channel remove` after a successful remove **fails fast** with exit code 1 and a clear "no ci-channel install detected" message, because `state.json` (the precondition) is gone. This is NOT "idempotent exit-0" — it is "the second run tells you the install is already gone, same way the first run would have if you'd run it in a fresh project." See "Required vs optional preconditions" and "Idempotency" below for the full rule. Missing webhook, missing `.mcp.json`, or missing `.codev/config.json` during an otherwise-valid remove (state.json present) result in a log line ("nothing to do for this step") and no error.

## Success Criteria

- [ ] `ci-channel remove --repo owner/repo` (GitHub, default) fully reverses a prior `setup` against the same repo — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitlab --repo group/project` does the same for GitLab — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitea --gitea-url URL --repo owner/repo` does the same for Gitea — verified by local-HTTP-server test.
- [ ] Running `remove` in a project that was never set up fails fast with `no ci-channel install detected in this project` and exit code 1.
- [ ] Running `remove` twice in a row on the same project: the first succeeds and exits 0, the second fails fast with "no install detected" and exit code 1 (because `state.json` is gone after the first run). **This is intentional "not idempotent exit-0" behavior** — `state.json` is the source of truth for "is ci-channel installed," and telling the user "nothing installed here" via a non-zero exit is more informative than a silent no-op.
- [ ] Running `remove` with `state.json` present but malformed (invalid JSON, missing `smeeUrl`, or unreadable) fails fast with a distinct, actionable error message (different from the "not installed" message), exit code 1, and **without touching `.mcp.json`, `.codev/config.json`, or any forge API**.
- [ ] If the user's `.mcp.json` `ci` entry is non-canonical (does not match the full expected shape for the passed `--forge`, including extra keys, changed command, or different args), `remove` leaves the entry alone, logs a warning, and still removes everything else.
- [ ] If `.codev/config.json` exists and contains the loader flag, `remove` strips the flag (and exactly one leading space) from `shell.architect` and writes the file back in canonical 2-space JSON.
- [ ] If `.codev/config.json` does not exist, `remove` does not create it and does not log a Codev-related message.
- [ ] A deleted webhook on the forge side — 404 **on the DELETE call** (not on the list call), or no matching hook in the list — is NOT an error. A 404 **on the LIST call** IS a hard failure (repo/project not found).
- [ ] All existing tests continue to pass (baseline recorded in the impl phase commit message).
- [ ] `wc -l lib/setup.ts` ≤ 400.
- [ ] `wc -l tests/setup.test.ts` ≤ 600 (raised from 400 — see "Test budget" below).
- [ ] `tests/setup.test.ts` contains ≤ 28 tests total (18 pre-existing from Spec 7 + ≤10 new).
- [ ] `lib/setup.ts` is still a **single file**; `lib/setup/` still does not exist.
- [ ] `lib/remove.ts` does NOT exist. Remove code lives in `lib/setup.ts` alongside setup.
- [ ] No new runtime or dev dependencies in `package.json`.
- [ ] Ships as **v0.5.0** (minor bump: new subcommand).

## HARD CONSTRAINTS (MAX, not suggestions)

### Size caps (loosened from Spec 7)

| File | Spec 7 cap | Spec 8 cap | Rationale |
|------|-----------|-----------|-----------|
| `lib/setup.ts` | 300 lines | **400 lines** | +100 for the remove path. Current actual: 300 lines. Remove adds parseArgs extension, three forge branches for webhook deletion, state/mcp/codev revert, and a shared `exportFn remove`. |
| `tests/setup.test.ts` | 400 lines | **600 lines** | +200 for ≤10 new scenarios using the same helper patterns. |
| Tests | 20 max | **28 max** | 18 pre-existing + ≤10 new. |
| `server.ts` dispatch | 5 lines | **8 lines** | Existing `setup` dispatch is 5 lines (lines 20–24). Adding a `remove` branch with the same shape is +3 lines. |

**All other Spec 5 and Spec 7 caps are unchanged.** A 401-line `lib/setup.ts` is a REQUEST_CHANGES. A 601-line `tests/setup.test.ts` is a REQUEST_CHANGES. 29 tests is a REQUEST_CHANGES. 9-line dispatch is a REQUEST_CHANGES unless the plan phase reconciles with the cap.

### Pre-budget for `lib/setup.ts` (400-line cap, per-section allocation)

Starting point: current `lib/setup.ts` is 300 lines (the Spec 7 shipped version). To fit ≤400 lines while adding the remove path, the plan phase MUST commit to an approximate section budget. This is **guidance, not a hard cap** — reviewers should not reject a PR that reallocates across sections, only one that breaks the 400-line top-level cap.

| Section | Current | Add | Target | Notes |
|---|---|---|---|---|
| Imports + constants | 15 | 1 | 16 | Add `unlinkSync` to the `node:fs` import. |
| `parseArgs` (setup) | 20 | 0 | 20 | Unchanged. |
| `parseRemoveArgs` (new) | 0 | ~20 | ~20 | Mirrors `parseArgs` but for remove (same flags). May share implementation — see "Arg parsing strategy" below. |
| `readEnvToken` helper | 17 | 0 | 17 | Shared — Gitea remove also needs the token. |
| `cliApi` subprocess helper | 20 | 0 | 20 | Shared across setup and remove. |
| `classifyForgeError` helper | 22 | 2 | 24 | Add a `DELETE`-aware branch: 404 during list is classified as "not found" but during `DELETE` it is "already gone" (treat as success). See "Idempotency" below. |
| `giteaFetch` helper | 14 | 0 | 14 | Shared. |
| `codevIntegrate` helper | 22 | 0 | 22 | Unchanged. |
| `codevRevert` helper (new) | 0 | ~25 | ~25 | Local try/catch, strip the flag, write back. Mirrors `codevIntegrate` structure. |
| `setup()` body | 162 | 0 | 162 | Unchanged. |
| `remove()` body (new) | 0 | ~80 | ~80 | Common flow + 3 forge branches. Shares helpers. |
| **Total** | **300** | **~128** | **~420** | **Over budget.** See tightening below. |

The ~420 estimate is intentionally pessimistic and **exceeds the 400-line cap**. The plan phase MUST commit to one of the following tightening strategies to land at ≤400:

1. **Merge `parseArgs` and `parseRemoveArgs`** into a single `parseSetupArgs(argv, mode: 'setup' | 'remove')` — the flag set is identical. Saves ~15 lines. (This is the preferred strategy.)
2. **Tighten `remove()` by extracting** the forge-specific webhook-delete calls into a compact if/else chain (not a strategy map) that reuses the same `cliApi` / `giteaFetch` / `classifyForgeError` helpers as setup. Do NOT add new abstractions — "tightening" here means "fewer lines in each branch," not "new helper layer."
3. **Compress comments and log strings** if needed after (1) and (2) leave a small overage. If the code still doesn't fit, the plan phase must flag the constraint as infeasible and escalate to the architect — but NOT quietly propose a 425-line cap.

With (1) alone, total drops from ~420 to ~405. With (1) + modest compression in the new `remove()` body and `codevRevert` helper, the realistic landing zone is 380–395.

**Explicit directive to the plan phase**: the plan's Phase 1 acceptance criteria MUST include `wc -l lib/setup.ts ≤ 400`. If the plan phase projects a higher total, it must apply tightening (1) and (2), or escalate.

### Single file, no module split

- **No `lib/remove.ts`.** No `lib/uninstall.ts`. No `lib/setup/remove.ts`. No `lib/setup/` directory. Remove code lives in `lib/setup.ts`, next to `setup()`, sharing helpers.
- **No helpers module** extracted "for symmetry." Put helpers at the top of `lib/setup.ts` if you need them.
- **No generic "forge uninstaller" abstraction.** No `ForgeUninstaller` interface, no `FORGE_UNINSTALLERS` map. Use a plain `if/else` chain on `forge`. Three forges. An `if/else if/else` is correct.
- **No dependency injection.** Tests use real temp dirs and the PATH-override / fake-HTTP-server patterns from Spec 5 and Spec 7.

### CLI surface (this is the WHOLE added CLI surface)

```
ci-channel remove --repo owner/repo                                       # GitHub (default)
ci-channel remove --forge gitlab --repo group/project
ci-channel remove --forge gitea --gitea-url URL --repo owner/repo
```

- **Added subcommand**: `remove`. That is the only change to the external CLI.
- **Flag set is IDENTICAL to `setup`**: `--repo`, `--forge`, `--gitea-url`. Same validation rules (lowercase `--forge`, `--gitea-url` required iff `--forge gitea`, `--repo` always required).
- **No `--yes`, `--force`, `--dry-run`, `--keep-state`, `--keep-mcp`, `--keep-codev`, or any "partial remove" flag.** Running the command is the confirmation, and it's all-or-nothing (subject to the canonical-entry safety rule for `.mcp.json`).
- **No interactive prompts.** Same rule as `setup`.

### Required vs optional preconditions

- **Project root is REQUIRED.** `findProjectRoot()` must succeed. If it returns `null`, `remove` fails fast with the same error setup uses: `No project root found (no .git/ or .mcp.json in any ancestor). Run this from inside the project you want to uninstall from.` Exit 1.
- **`state.json` is REQUIRED and must contain a non-empty `smeeUrl`.** There are three failure sub-cases:
  1. **File missing** (`existsSync(statePath) === false`): fail fast with `no ci-channel install detected in this project (no state.json at <path>). Nothing to uninstall.` Exit 1.
  2. **File present but unreadable or not valid JSON**: fail fast with `state.json at <path> is unreadable or malformed: <error message>. Fix or delete the file, then retry.` Exit 1. The implementation MUST NOT use the existing `loadState()` helper (which swallows read/parse failures and returns `{}`), because that would conflate "file missing" with "file corrupt" and produce a less actionable error. Use `readFileSync` + `JSON.parse` directly inside a try/catch.
  3. **File present and parses but `smeeUrl` is missing, empty, or not a string**: fail fast with `state.json at <path> is missing a 'smeeUrl' field. Cannot match webhook. If you want to force a reinstall, delete state.json and re-run \`ci-channel setup\`.` Exit 1.

  Rationale: without a valid `smeeUrl` we don't know which webhook to delete on the forge side, so we can't do the primary job of `remove`. Faking our way through "delete something that might be the right hook" is worse than just failing. All three sub-cases exit before any forge call and before touching any other local file.
- **For Gitea: `GITEA_TOKEN` is REQUIRED.** Same precondition check and ordering as setup — fails fast before any webhook work if missing. See step 4 of "Order of operations."
- **The forge-side webhook is OPTIONAL.** If `state.json` is valid but the webhook has already been deleted (or never existed), `remove` logs `no matching webhook found on <forge>; skipping webhook delete` and continues with the local cleanup.
- **`.mcp.json` is OPTIONAL.** If missing, log `no .mcp.json found — skipping`. If present but no `ci` key under `mcpServers`, log `no 'ci' entry in .mcp.json — skipping`. If present with `mcpServers` not an object, log warning and skip (see "Defensive shape handling" in the canonical-entry section). If present with a non-canonical `ci` key, leave it alone and log a warning (see below).
- **`.codev/config.json` is OPTIONAL.** If missing, skip silently (no log line). If present but no `shell.architect`, log and skip (same shape-check as setup). If present with `shell.architect` not containing the loader flag, log and skip.

### Arg parsing strategy

The flag set for `remove` is identical to `setup` (`--repo`, `--forge`, `--gitea-url`, same validation). Rather than duplicate a second 20-line `parseArgs` function, the plan phase SHOULD merge the two into a single `parseSetupArgs(argv, command: 'setup' | 'remove')` that reuses the same validation. The `command` parameter only affects the usage string in error messages (e.g., `Usage: ci-channel remove --repo owner/repo ...`).

This is a recommendation, not a hard rule. A 20-line duplicated `parseRemoveArgs` is acceptable if the plan phase prefers it — but then the 400-line cap tightens and sections must be compressed elsewhere. The plan phase decides.

### "Canonical entry" check for `.mcp.json`

The `ci` entry in `.mcp.json` is **canonical** if it exactly matches the shape that `setup` writes for the current `--forge`. This is a **strict full-array equality check** against the forge-specific expected args.

**Expected canonical shape** (forge-specific):

| Forge | Expected `args` |
|---|---|
| `github` | `["-y", "ci-channel"]` |
| `gitlab` | `["-y", "ci-channel", "--forge", "gitlab"]` |
| `gitea`  | `["-y", "ci-channel", "--forge", "gitea", "--gitea-url", <base>]` where `<base>` matches `giteaUrl.replace(/\/$/, '')` from the CLI flag |

The canonical-check rule (all must hold):

1. `entry` is an object.
2. `Object.keys(entry).sort().join(',') === 'args,command'` (no extra keys like `env`, `cwd`, etc.).
3. `entry.command === 'npx'` (exact match).
4. `Array.isArray(entry.args)` is true.
5. `JSON.stringify(entry.args) === JSON.stringify(expectedArgs)` where `expectedArgs` is the forge-specific array from the table above, built using **the same `--forge` / `--gitea-url` values passed to `remove`**.

If all five checks pass, the entry is canonical and `remove` deletes it. If any check fails, `remove` logs a warning and leaves the entry alone:

```
[ci-channel] warning: .mcp.json 'ci' entry does not match the canonical shape for --forge <forge>. Leaving it alone. Edit .mcp.json manually if you want to remove it.
```

**Why strict full-array equality?** The user must pass the same `--forge` (and `--gitea-url` if applicable) to `remove` as they passed to `setup`. That's not a burden — they already know which forge they installed against (they're running `remove --repo owner/repo` against that forge's webhook anyway). Given the forge is known, the full expected `args` array is known, so we can check it exactly. This is stricter than a partial check and correctly refuses to remove any entry a user has hand-edited (e.g., added a trailing `--workflow-filter foo`, changed the `-y` to something else, replaced `ci-channel` with a local path).

**Note on `--gitea-url` normalization**: setup writes `<gitea-url>.replace(/\/$/, '')` into the entry's `args`. Remove must apply the same normalization before comparing, so `--gitea-url https://gitea.example.com/` passed to `remove` matches an entry written by setup with `--gitea-url https://gitea.example.com`.

**Forge mismatch is treated as customization**: if the user runs `remove --forge gitlab` against a project whose `.mcp.json` was written by `setup --forge github`, the expected array differs and the canonical check fails. The warning fires, the entry is left alone, and `remove` still cleans up `state.json`. This is correct — the user probably made a mistake running the wrong forge flag, and we'd rather preserve the entry than blow it away.

When the `ci` entry IS removed, the `.mcp.json` file is rewritten in canonical 2-space JSON with a trailing newline, same as setup does on write. If removing the `ci` key leaves `mcpServers` as an empty object `{}`, **leave the empty object** — do not delete the `mcpServers` key itself. Do not delete the file.

**Defensive shape handling**: if `.mcp.json` is present but `mcp.mcpServers` is not an object (e.g., `null`, a string, an array), log `warning: .mcp.json mcpServers is not an object — skipping` and do not mutate the file. This mirrors the defensive behavior of setup's `const servers = mcp.mcpServers ?? {}` fallback, extended to reject non-object values explicitly.

### Codev revert rule

If `.codev/config.json` exists and its `shell.architect` string contains the loader flag, strip the flag. The exact logic:

1. Read and `JSON.parse` `.codev/config.json`.
2. If `config.shell?.architect` is missing or not a non-empty string, log `.codev/config.json has no shell.architect — skipping (unexpected Codev shape)` and return.
3. If the string does NOT contain `--dangerously-load-development-channels server:ci`, log `.codev/config.json does not load ci channel — nothing to revert` and return.
4. Otherwise, replace the substring ` --dangerously-load-development-channels server:ci` (note the single leading space) with the empty string. Do NOT collapse extra whitespace anywhere else. Do NOT handle the edge case where the flag appears at the start of the string with no leading space — setup always appends with a leading space, so this case is unreachable in practice. If the user hand-edited the file to put the flag at the start, the substring-with-leading-space match will miss it and we'll log "does not load ci channel" — that's acceptable (we erred on the side of not corrupting the user's hand edit).
5. Write the file back with `JSON.stringify(config, null, 2) + '\n'` (canonical 2-space JSON, same as setup).
6. Log `Reverted .codev/config.json: architect session will no longer load ci channel`.

Wrap the whole Codev step in a local `try/catch` that logs a warning and **continues** (does NOT re-throw), same as `codevIntegrate` in setup. The rationale is the same: by the time Codev revert runs, the webhook and state.json are already gone. A malformed `.codev/config.json` should not cause `remove` to exit non-zero.

The log line for a Codev revert failure is: `[ci-channel] warning: Codev revert failed: <error message>. Other cleanup succeeded; edit .codev/config.json manually to remove --dangerously-load-development-channels server:ci from shell.architect.`

### 404 handling (disambiguated)

The forge-side webhook flow involves **two** distinct API calls that can return 404, and they must be handled differently:

1. **LIST `/hooks` returns 404** (or HTTP_404 via `gh`/`glab` stderr): this means the **repo or project itself** is not found (or not visible with the current auth scope). This is a **hard failure** — it's the same 404 setup classifies as "Could not find repo '<repo>'". Exit 1 with the existing error message. Rationale: if we can't list hooks, we don't know whether our hook exists or not, and silently proceeding to delete state.json would orphan the webhook if it does exist.

2. **DELETE `/hooks/{id}` returns 404**: this means the **webhook** is gone (race between list and delete — someone or something deleted it in between). This is **not an error**. Log `webhook <id> already deleted on <forge>; continuing` and proceed to the local cleanup. Rationale: the goal of the DELETE call is to ensure the webhook is gone, and it is gone, so the goal is met.

**Implementation note**: the distinction hinges on which API call produced the 404. Two workable mechanisms:

- **Option A**: `classifyForgeError` gets an additional `context: 'list' | 'delete'` parameter. On `context === 'delete'` + 404, return a sentinel `null`/`undefined` the caller interprets as "treat as success." On `context === 'list'` + 404, return the existing "Could not find repo" error.
- **Option B**: `remove()` catches the DELETE-call error locally *before* calling `classifyForgeError`. Check if the thrown error's stderr contains `HTTP 404` or `Not Found`; if so, swallow it and log the "already deleted" line. Otherwise, rethrow through `classifyForgeError`.

The plan phase picks one. Option B is slightly simpler (adds ~4 lines to `remove()` per forge branch, leaves `classifyForgeError` unchanged at current complexity). Option A is slightly cleaner (adds ~6 lines to `classifyForgeError`, centralized). Either is acceptable; the plan phase should just commit to one and note it in the Phase 1 acceptance criteria.

For Gitea, the same distinction applies to `giteaFetch`: a 404 on the LIST call throws `Could not find Gitea repo '<repo>'` (existing behavior, keep), but a 404 on the DELETE call must be caught locally in `remove()` (since `giteaFetch` throws before the caller can inspect it). The plan phase should wrap the Gitea DELETE call in a try/catch that matches `err.message` against `"Could not find Gitea repo"` OR the status code — probably the simplest approach is to bypass `giteaFetch` for the DELETE call and do a direct `fetch()` with manual status handling (~8 lines). Alternatively, `giteaFetch` could grow a `context` parameter the same way Option A does for `classifyForgeError`. Plan phase decides.

### Idempotency

The rule is straightforward: **`state.json` is the single source of truth for "is ci-channel installed here?"**. Every remove behavior follows from that.

Running `remove` after a successful remove (state.json is gone):
- Precondition check fails → fail fast with `no ci-channel install detected in this project`. Exit 1.
- **This is NOT "idempotent exit-0" behavior.** It is "the second run correctly tells you nothing is installed." If the user wanted silent no-op on a re-run, they could check themselves — but a non-zero exit is more informative for scripts and for users who expect "did I really uninstall?".

Running `remove` against a forge where the webhook is already deleted but `state.json` is still present (user deleted the hook manually, or a partial failure left state.json behind):
- List hooks succeeds, find no match → log `no matching webhook found on <forge>; skipping webhook delete` → continue.
- Delete `state.json`, revert `.mcp.json`, revert `.codev/config.json`, exit 0.

Running `remove` after a partial failure (webhook delete succeeded, state.json delete failed at unlink time, user re-runs):
- List hooks succeeds, find no match (already deleted) → log "no matching webhook found" → continue.
- Delete `state.json` → succeeds this time.
- Continue with `.mcp.json` and `.codev/config.json` cleanup.
- Exit 0.

**Hard failures (exit 1 with classified error)**:
- `state.json` missing, unreadable, malformed, or missing `smeeUrl` (see "Required vs optional preconditions").
- Project root not found.
- For Gitea: `GITEA_TOKEN` not set.
- Forge API authentication failure (401) on either list or delete.
- Forge API permission denied (403) on either list or delete.
- **LIST** call returns 404 (repo/project not found).
- Network error / timeout on the forge API call (surfaced through the existing error classifier).
- Local file write failure on `.mcp.json` or `.codev/config.json` (EACCES, EPERM) — bubbled through the top-level catch with the filename in the error.

**Soft handling (log and continue, exit 0)**:
- **DELETE** call returns 404 (webhook was already gone — race between list and delete).
- No matching webhook in the list response.
- Missing `.mcp.json`.
- Missing `ci` key in `.mcp.json`.
- Non-canonical `ci` key in `.mcp.json` (leaves alone, warns).
- `mcpServers` not an object.
- Missing `.codev/config.json`.
- Missing `shell.architect` in `.codev/config.json`.
- Loader flag not present in `shell.architect`.
- `unlinkSync(state.json)` throws `ENOENT` (race with another process).

### Order of operations

The order matters because we're deleting the piece of state (`state.json`) that lets us identify the webhook. The correct order is:

1. **Validate args** (parse, check forge-specific flags).
2. **Find project root** (`findProjectRoot`) — fail fast if null.
3. **Read and validate `state.json`** — fail fast if missing, unreadable, malformed, or missing `smeeUrl` (see "Required vs optional preconditions"). This gives us `smeeUrl` to match the webhook.
4. **For Gitea only**: read `GITEA_TOKEN` from env or `.env` — fail fast if missing (same ordering as setup).
5. **Delete the webhook on the forge** (list hooks, match by `smeeUrl`, delete). 404 on LIST is a hard failure (repo not found). 404 on DELETE is "already gone" (continue). No matching hook in the list is "already gone" (continue). See "404 handling" section.
6. **Delete `state.json`** (unlink). If the file is gone between step 3 and step 6 (race with another process), `ENOENT` from unlink is not an error.
7. **Remove canonical `ci` entry from `.mcp.json`** (or warn and skip if customized).
8. **Revert `.codev/config.json`** (if present, if contains loader flag).
9. **Print summary** of what was done.

The key invariant: **step 5 happens before step 6**. If we deleted `state.json` first and then tried to delete the webhook, we'd have no way to match it and would have to either (a) list all hooks and try to guess which one is ours or (b) give up. Neither is acceptable.

**Failure recovery note**: if step 5 fails (network error, 401, 403, 404-on-list), we exit 1 without touching anything else. The user's `state.json` is intact and re-running `remove` will retry the whole flow. Corollary invariant: **`state.json` exists iff the install is "active" on the local side, regardless of forge-side state.** Setup writes state before the network call (so a mid-setup failure leaves `state.json` present and re-runnable); remove deletes state after the network call succeeds (so a mid-remove failure also leaves `state.json` present and re-runnable). Both rules point at the same shape.

### Progress output

Each step prints a short `[ci-channel] ...` line to stderr via the shared `log()` helper, same as setup. Lines to add:

- `Project root: <path>`
- `Target repo: <repo>`
- `Forge: <forge>`
- `Listing existing webhooks on <repo>...`
- `Found webhook <id> on <repo> — deleting...` (or `no matching webhook found on <forge>; skipping webhook delete`)
- `Deleted webhook <id>`
- `Deleted state.json`
- `Removed 'ci' from .mcp.json` (or `'ci' entry in .mcp.json is customized — leaving alone` or `no 'ci' entry in .mcp.json — skipping`)
- `Reverted .codev/config.json` (or relevant skip message)
- Final `Done. ci-channel removed from <repo>.` to stdout.

### Shared helpers with setup

Remove reuses setup's helpers:

- `parseArgs` / `parseSetupArgs` — shared (see "Arg parsing strategy" above).
- `readEnvToken` — shared (Gitea remove also needs `GITEA_TOKEN`).
- `cliApi` — shared for GitHub and GitLab DELETE calls.
- `classifyForgeError` — shared; may get a small extension for "DELETE 404 = not an error."
- `giteaFetch` — shared for Gitea DELETE calls.
- `log` — shared.
- `findProjectRoot` / `loadState` — already imported, used by both.

The `codevIntegrate` and `codevRevert` helpers are siblings, not shared.

### No new dependencies

Same rule as Spec 7. Use Node built-ins. Do not add anything to `package.json` besides the version bump.

## CLI dispatch

`server.ts` lines 20–24 currently read:

```typescript
if (process.argv[2] === "setup") {
  const { setup } = await import("./lib/setup.js");
  await setup(process.argv.slice(3));
  process.exit(0);
}
```

This spec extends the dispatch to also match `"remove"`:

```typescript
if (process.argv[2] === "setup" || process.argv[2] === "remove") {
  const mod = await import("./lib/setup.js");
  const fn = process.argv[2] === "setup" ? mod.setup : mod.remove;
  await fn(process.argv.slice(3));
  process.exit(0);
}
```

This is **7 lines**, within the 8-line dispatch cap. The plan phase is free to use a slightly different shape (e.g., two separate `if` branches, 8 lines total) as long as it stays at ≤8 lines and does not import `lib/setup.js` until the user has actually invoked a subcommand.

**Hard rule**: the `./lib/setup.js` dynamic import must not happen unless the user invoked `setup` or `remove`. The rationale is the same as Spec 5: the server startup path must not load installer-only code. A static `import { setup, remove } from './lib/setup.js'` at the top of `server.ts` is a REQUEST_CHANGES.

## Test Scenarios

Tests reuse the Spec 7 patterns: PATH-override fake `gh`/`glab` for GitHub + GitLab scenarios, local `http.createServer` for Gitea scenarios. All tests cap at ≤28 total in one ≤600-line file.

### Test budget

- **Pre-existing tests (Spec 5 + Spec 7)**: 18 tests unchanged.
- **New remove tests**: 9 mandatory (R1–R9) + 1 optional (R10). Max 10.
- **Total cap**: 28.

The ≤400 to ≤600 line bump mirrors the 300→400 bump on `lib/setup.ts`. The test file already uses the helpers efficiently; new remove tests reuse the same `mkFakeCli` / `withGiteaServer` / `runSetup` scaffolding with minimal duplication.

### Test mocking strategy

- **`gh` CLI** — existing PATH-override fake, extended to handle `DELETE` responses.
- **`glab` CLI** — same extension.
- **Gitea HTTP API** — existing `withGiteaServer` helper, extended to handle `DELETE` requests.
- **`fetchSmeeChannel`** — still not mocked (remove doesn't call smee.io at all).

Windows: same rule as Spec 7. The fake-CLI tests skip on `win32`. The Gitea HTTP-server tests can run everywhere.

### Scenarios to ADD (≤10 new, aim for 8)

**Scenario R1 — GitHub remove happy path**:
1. Seed `state.json` with fake `smeeUrl` + `webhookSecret`.
2. Seed `.mcp.json` with the canonical GitHub `ci` entry (`{ command: 'npx', args: ['-y', 'ci-channel'] }`).
3. Fake `gh` returns `[[{ id: 42, config: { url: smeeUrl } }]]` on list (nested array — matches setup's `gh api --paginate --slurp` response shape, which returns an array of pages that setup then `.flat()`s), `{}` on DELETE. If `remove` chooses to use a plain `gh api repos/.../hooks` (no `--paginate --slurp`) for simplicity, the fake should return `[{ id: 42, config: { url: smeeUrl } }]` instead. **The plan phase must pick one invocation shape and the test must match it.** Matching setup's `--paginate --slurp` pattern is recommended for consistency.
4. Run `remove --repo owner/repo`.
5. Assert:
   - `gh api ... repos/owner/repo/hooks` called for list (exact argv depends on `--paginate --slurp` choice).
   - `gh api --method DELETE repos/owner/repo/hooks/42` called for delete.
   - `state.json` no longer exists.
   - `.mcp.json` no longer contains the `ci` key (but still exists).
   - Exit code 0.
   - Stderr contains `Deleted webhook 42`, `Deleted state.json`, `Removed 'ci' from .mcp.json`.

**Scenario R2 — GitHub remove with no matching webhook on forge**:
1. Seed `state.json` + canonical `.mcp.json`.
2. Fake `gh` returns `[]` on list (hook already deleted).
3. Run `remove --repo owner/repo`.
4. Assert:
   - No DELETE called.
   - Stderr contains `no matching webhook found`.
   - State.json deleted, .mcp.json cleaned.
   - Exit code 0.

**Scenario R3 — GitHub remove with customized `.mcp.json` ci entry**:
1. Seed `state.json`.
2. Seed `.mcp.json` with a customized `ci` entry: `{ command: 'npx', args: ['-y', 'ci-channel'], env: { FOO: 'bar' } }` (extra `env` key makes it non-canonical).
3. Fake `gh` returns `[{ id: 42, config: { url: smeeUrl } }]` on list.
4. Run `remove --repo owner/repo`.
5. Assert:
   - DELETE called (webhook still removed).
   - `state.json` deleted.
   - `.mcp.json` `ci` entry **still present and byte-equal** to seeded content.
   - Stderr contains `is customized — leaving alone`.
   - Exit code 0.

**Scenario R4 — Remove without state.json (not-installed)**:
1. Do not seed `state.json`.
2. (Optional) Seed `.mcp.json` with a canonical `ci` entry.
3. Run `remove --repo owner/repo`.
4. Assert:
   - Exit code 1.
   - Stderr contains `no ci-channel install detected`.
   - No fake-`gh` call recorded.
   - `.mcp.json` untouched.

**Scenario R5 — GitLab remove happy path**:
1. Seed `state.json` + canonical GitLab `.mcp.json` entry (`args: ['-y', 'ci-channel', '--forge', 'gitlab']`).
2. Fake `glab` returns `[{ id: 77, url: smeeUrl }]` on list, `{}` on DELETE.
3. Run `remove --forge gitlab --repo group/project`.
4. Assert:
   - `glab api projects/group%2Fproject/hooks` called for list.
   - `glab api --method DELETE projects/group%2Fproject/hooks/77` called for delete.
   - State + mcp cleaned.
   - Exit code 0.

**Scenario R6 — Gitea remove happy path**:
1. Seed `state.json` + canonical Gitea `.mcp.json` entry (with `--forge gitea --gitea-url URL`).
2. Seed `.env` with `GITEA_TOKEN=fake-token`.
3. Local HTTP server responds `[{ id: 99, config: { url: smeeUrl } }]` on GET, `204` on DELETE.
4. Run `remove --forge gitea --gitea-url http://127.0.0.1:PORT --repo owner/repo`.
5. Assert:
   - GET + DELETE received with `Authorization: token fake-token`.
   - DELETE path is `/api/v1/repos/owner/repo/hooks/99`.
   - State + mcp cleaned.
   - Exit code 0.

**Scenario R7 — Gitea missing token**:
1. Seed `state.json` but no `.env`, unset `GITEA_TOKEN`.
2. Run `remove --forge gitea --gitea-url http://127.0.0.1:PORT --repo owner/repo`.
3. Assert:
   - Exit code 1.
   - Stderr contains `GITEA_TOKEN not set`.
   - **`state.json` still exists** (remove was aborted before local cleanup).
   - No HTTP request received.

**Scenario R8 — Remove with Codev integration**:
1. Seed `state.json` + canonical `.mcp.json`.
2. Seed `.codev/config.json` with `{ shell: { architect: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:ci' } }`.
3. Fake `gh` returns `[{ id: 42, config: { url: smeeUrl } }]`.
4. Run `remove --repo owner/repo`.
5. Assert:
   - `.codev/config.json` `shell.architect` is now `'claude --dangerously-skip-permissions'` (flag stripped with its leading space).
   - Stderr contains `Reverted .codev/config.json`.

**Scenario R9 — 404-during-DELETE race (webhook deleted between list and delete)**:
1. Seed `state.json` + canonical `.mcp.json`.
2. Fake `gh` returns `[{ id: 42, config: { url: smeeUrl } }]` on list (hook appears to exist), but DELETE on `/hooks/42` returns exit code 1 with stderr containing `HTTP 404: Not Found`.
3. Run `remove --repo owner/repo`.
4. Assert:
   - Stderr contains `already deleted` (or equivalent "treat as success" log from the 404-on-DELETE handler).
   - `state.json` deleted (remove continued after the soft-404).
   - `.mcp.json` cleaned.
   - Exit code 0.

This scenario is **mandatory** — it locks in the distinction between list-404 (hard) and delete-404 (soft) that the spec calls out explicitly. Cheap to add since it reuses the R1 scaffolding with a different fake DELETE response.

**Scenario R10 — Invalid `state.json` (missing `smeeUrl`)**:
1. Seed `state.json` with `{ "webhookSecret": "abc" }` (no `smeeUrl`).
2. Seed canonical `.mcp.json`.
3. Run `remove --repo owner/repo`.
4. Assert:
   - Exit code 1.
   - Stderr contains `missing a 'smeeUrl' field`.
   - **No fake-`gh` call recorded** (precondition fail-fast before network).
   - **`.mcp.json` untouched** (precondition fail-fast before local mutation).
   - **`state.json` still exists** (precondition fail-fast before unlink).

This scenario is **optional** — it locks in the state.json validity rule but is less load-bearing than the others. Fold it into R4 if budget is tight (same fail-fast shape, different trigger).

**Minimum coverage**: R1, R2, R3, R4, R5, R6, R7, R8, R9 (9 tests) are mandatory. R10 is stretch. Total cap: 10. Below 9 is a REQUEST_CHANGES.

### Test implementation hints (not rules)

- **Fake CLI extension**: the existing `mkFakeCli` (or whatever it's called post-Spec-7) needs to recognize `DELETE` in its response map. If the Spec 7 fake CLI hardcodes `POST`/`PATCH`/`PUT`/`GET`, the plan phase should generalize it.
- **Byte-equality assertions**: for `state.json-deleted` assertions, use `existsSync(statePath) === false`. For `.mcp.json after-state`, compare `JSON.parse` round-trip (not byte equality) because the installer's canonical-JSON output may differ from the seeded file's formatting.
- **Environment variable isolation**: tests that set `GITEA_TOKEN` must restore the original value in a `finally`. Tests that unset it should also restore. The existing Spec 7 tests already do this.

## Dependencies

**Spec 7 must be merged**. Already done (commit c3f91c6 on main). This spec branches from post-Spec-7 main.

## Security Considerations

- **Webhook secret is not exposed**. `remove` reads `webhookSecret` from `state.json` only to log it? **No.** `remove` does not need the secret at all — the webhook is matched by `smeeUrl`, not by secret. The plan phase must NOT log or transmit the secret. After `remove` completes, the secret is gone along with `state.json`, which is the right outcome.
- **File permissions**: `state.json` is written at mode `0o600` by setup. Deleting it does not require elevated permissions. The unlink must not change permissions on the parent directory.
- **`.env` file**: `remove` reads `GITEA_TOKEN` from `.env` if needed (for Gitea DELETE auth). It does NOT delete `.env` — the user may have other secrets in there. The `.env` file is explicitly out of scope for removal.
- **Directory preservation**: the `.claude/channels/ci/` directory is NOT removed even if empty after `state.json` deletion. Removing directories is out of scope; the next `setup` run will reuse the directory.

## Non-Goals

- **Recovery / undo of remove**: the user can re-run `setup` to reinstall. There is no "undo remove" command.
- **Remove without `--repo`**: the user must specify the repo explicitly. No auto-detection from git remote or current directory.
- **Remove across multiple projects**: one command, one project. No "remove from all installed projects" bulk operation.
- **Remove the `.env` file or the directory `.claude/channels/ci/`**: see "Security Considerations" above.
- **Dry-run mode**: see the general "no prompts, no dry-run" rule.
- **`--force` / `--keep-X` flags**: out of scope. The canonical-vs-customized check on `.mcp.json` is the only "safety valve," and it's automatic.
- **Remove the smee.io channel**: smee channels are externally provisioned and not owned by `ci-channel`. The channel URL becomes effectively abandoned after remove, and smee.io will garbage-collect it after disuse. We do not attempt to call any smee.io "delete channel" endpoint.
- **Audit log of removes**: no persistent "this project was uninstalled at <time>" trail. Remove is a fire-and-forget operation.
- **Notifying the user via some external channel** (email, Slack, etc.) that a removal happened. The only output is stderr progress lines and a final stdout "Done." message.
- **Running `remove` from outside a project directory**: `findProjectRoot()` must succeed, same as setup. Running outside a project fails fast.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| User runs `remove` on a project where another tool also uses the `ci` MCP key in `.mcp.json` (unlikely but possible) | Low | Medium | The canonical-entry check catches this. If another tool wrote a different shape to the `ci` key, `remove` leaves it alone and logs a warning. |
| User's `state.json` `smeeUrl` has drifted from the actual webhook (e.g., they re-ran setup with a fresh channel without going through `remove`) | Low | Low | `remove` would fail to find a matching webhook, log "no matching webhook found," and still clean up the local state. The stale hook on the forge remains, but `setup` has always emitted the "always-PATCH" behavior, so this state is already unlikely. |
| Gitea DELETE endpoint returns a non-204 success code (e.g., 200) | Low | Low | `giteaFetch` already checks `resp.ok`, which is true for any 2xx. No change needed. |
| User hand-edited `.codev/config.json` with the flag at a different position than what setup wrote | Medium | Low | Substring match on ` --dangerously-load-development-channels server:ci` (with leading space) handles the common case. Unusual hand edits fall back to "nothing to revert" which is acceptable. |
| Race condition: another process deletes `state.json` between "load state" and "unlink state" | Very low | Low | `unlinkSync` ENOENT is caught and treated as success. |
| 404 on `DELETE webhook/<id>` (webhook was deleted between list and delete) | Low | Low | Classified as "already gone," logged, treated as success. |
| Forge API rate limiting (429) | Very low (single DELETE per run) | Medium if it happens | Surface via the existing error classifier. Not a new case to handle. |

## Documentation Updates

- **README.md**: add a short "Uninstall" section after the "Install" section, showing the three forge commands.
- **INSTALL.md**: add a note that `ci-channel remove` now exists alongside `setup` for all three forges.
- **CLAUDE.md / AGENTS.md**: one-line mention that `ci-channel remove` is the inverse of `ci-channel setup`. Keep the two files in sync.
- **package.json**: bump version from `0.4.0` → `0.5.0`.
- **codev/resources/arch.md**: optional one-liner that `lib/setup.ts` now also exports `remove` alongside `setup`. Not required.

## Expert Consultation

To be filled in by porch/consult after 3-way review.

## Notes

**Why "remove" and not "uninstall"?** `remove` is shorter, matches the naming of `npm remove` / `cargo remove` / similar package-manager verbs, and pairs semantically with `setup` (which is itself an alias for "install" in this project). No strong preference — "uninstall" would also be acceptable and the plan phase could substitute it without changing the spec. But for consistency with the issue title, we go with `remove`.

**Why fail fast on missing `state.json` instead of "try to clean up anything we can find"?** Because the core primitive of `remove` is "find the webhook by smee URL." Without `state.json`, we don't have the smee URL, so we can't do the core primitive. Trying to clean up `.mcp.json` and `.codev/config.json` anyway is a "best effort" mode that (a) leaves the webhook orphaned on the forge, which is the worst outcome, and (b) hides the problem from the user, who wanted to uninstall and now thinks they did. Fail-fast forces the user to confront the state mismatch.

---

## Amendments

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
