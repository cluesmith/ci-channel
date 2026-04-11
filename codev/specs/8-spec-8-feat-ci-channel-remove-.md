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

Re-running `ci-channel remove` after a successful remove is idempotent and exits 0. Missing `state.json`, missing webhook, missing `.mcp.json`, missing `.codev/config.json` all result in a log line ("nothing to do") and no error — **except** the "no ci-channel install detected in this project" case when the user runs `remove` in a project that was never set up, which fails fast with a clear message (see "Required vs optional preconditions" below).

## Success Criteria

- [ ] `ci-channel remove --repo owner/repo` (GitHub, default) fully reverses a prior `setup` against the same repo — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitlab --repo group/project` does the same for GitLab — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitea --gitea-url URL --repo owner/repo` does the same for Gitea — verified by local-HTTP-server test.
- [ ] Running `remove` in a project that was never set up fails fast with `no ci-channel install detected in this project` and exit code 1.
- [ ] Running `remove` twice in a row on the same project: the first succeeds, the second fails fast with the same "no install detected" message (because `state.json` is gone after the first run).
- [ ] If the user's `.mcp.json` `ci` entry is non-canonical (they added extra flags, changed the command, or nested additional config), `remove` leaves the entry alone, logs a warning, and still removes everything else.
- [ ] If `.codev/config.json` exists and contains the loader flag, `remove` strips the flag (and exactly one leading space) from `shell.architect` and writes the file back in canonical 2-space JSON.
- [ ] If `.codev/config.json` does not exist, `remove` does not create it and does not log a Codev-related message.
- [ ] A deleted webhook on the forge side (`404` from the `DELETE` call, or no matching hook in the list) is NOT an error — log and skip.
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

- **`state.json` is REQUIRED.** If it's missing, `remove` fails fast with `no ci-channel install detected in this project (no state.json at <path>). Nothing to uninstall.` Rationale: without `state.json` we don't know the smee URL, so we can't match the webhook on the forge side, so we can't do the primary job of `remove`. Faking our way through "delete something that might be the right hook" is worse than just failing.
- **The forge-side webhook is OPTIONAL.** If `state.json` is present but the webhook has already been deleted (or never existed), `remove` logs `no matching webhook found on <forge>; skipping webhook delete` and continues with the local cleanup.
- **`.mcp.json` is OPTIONAL.** If missing, skip. If present but no `ci` key, skip. If present with a non-canonical `ci` key, leave it alone and log a warning (see below).
- **`.codev/config.json` is OPTIONAL.** If missing, skip silently. If present but no `shell.architect`, log and skip (same shape-check as setup). If present with `shell.architect` not containing the loader flag, log and skip.

### Arg parsing strategy

The flag set for `remove` is identical to `setup` (`--repo`, `--forge`, `--gitea-url`, same validation). Rather than duplicate a second 20-line `parseArgs` function, the plan phase SHOULD merge the two into a single `parseSetupArgs(argv, command: 'setup' | 'remove')` that reuses the same validation. The `command` parameter only affects the usage string in error messages (e.g., `Usage: ci-channel remove --repo owner/repo ...`).

This is a recommendation, not a hard rule. A 20-line duplicated `parseRemoveArgs` is acceptable if the plan phase prefers it — but then the 400-line cap tightens and sections must be compressed elsewhere. The plan phase decides.

### "Canonical entry" check for `.mcp.json`

The `ci` entry in `.mcp.json` is **canonical** if it exactly matches the shape written by `setup`:

```json
{
  "command": "npx",
  "args": ["-y", "ci-channel", ...forge-specific-args]
}
```

Forge-specific args (as written by setup):
- **GitHub**: `["-y", "ci-channel"]`
- **GitLab**: `["-y", "ci-channel", "--forge", "gitlab"]`
- **Gitea**: `["-y", "ci-channel", "--forge", "gitea", "--gitea-url", <base>]`

The canonical-check rule:

- `entry.command === 'npx'` (exact match, not startsWith, not includes)
- `entry.args` is an array
- `entry.args[0] === '-y'` and `entry.args[1] === 'ci-channel'` (exact, first two positions)
- No other properties on `entry` besides `command` and `args` (use `Object.keys(entry).sort().join(',') === 'args,command'`)

If these hold, the entry is canonical and `remove` deletes it. If any check fails, `remove` logs a warning and leaves the entry alone:

```
[ci-channel] warning: .mcp.json 'ci' entry is customized (not the canonical shape written by setup). Leaving it alone. Edit .mcp.json manually if you want to remove it.
```

**Why `args[0]` and `args[1]` only, not the whole array?** Because the forge-specific trailing args (`--forge gitlab`, `--gitea-url URL`) were written by setup based on the `--forge` flag at setup time, and we don't want `remove` to refuse to clean up a GitLab install just because the user originally set up with `--forge gitlab` and now runs `remove --forge gitlab` (the full array would match, so actually the full check would pass in the happy path). The real reason for not doing a full array-equality check is: if setup writes a 7-element args array and the user hand-edits one trailing element, we should still treat it as "customized" and leave it alone. But if we check only `[0]` and `[1]`, we correctly detect the "user added a suffix" case. The alternative — strict array equality — would refuse to remove entries that setup itself wrote after a `--gitea-url` change, which is wrong.

The `command === 'npx'` + `args[0:2] === ['-y', 'ci-channel']` + key-count check is the right tradeoff: strict enough to catch "the user replaced `command` with `node` and a hand-path" or "the user wrapped the whole thing in extra config keys," lenient enough to not false-positive on users who reran setup with a different forge.

When the `ci` entry IS removed, the `.mcp.json` file is rewritten in canonical 2-space JSON with a trailing newline, same as setup does on write. If removing the `ci` key leaves `mcpServers` as an empty object `{}`, **leave the empty object** — do not delete the `mcpServers` key itself. If removing the `ci` key makes `.mcp.json` have NO top-level keys (impossible in practice — `mcpServers` stays), write it as `{}`. Do not delete the file.

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

### Idempotency

Running `remove` after a successful remove:
- `state.json` is gone → fail fast with `no ci-channel install detected in this project`. Exit 1.

Running `remove` against a forge where the webhook is already deleted (but `state.json` is still present — user deleted the hook manually):
- List hooks, find no match → log `no matching webhook found on <forge>; skipping webhook delete` → continue.
- Delete `state.json`, revert `.mcp.json`, revert `.codev/config.json`, exit 0.

Running `remove` after a partial failure (e.g., webhook delete succeeded, state.json delete failed, user re-runs):
- List hooks, find no match (already deleted) → log "no matching webhook found" → continue.
- Delete `state.json` → succeeds this time.
- Continue with `.mcp.json` and `.codev/config.json` cleanup.
- Exit 0.

**Hard failures (exit 1 with classified error)**:
- Forge API authentication failure (401).
- Forge API permission denied (403).
- Local file write failure (EACCES, EPERM) — bubbled through the top-level catch with the filename in the error.
- **NOT** 404 on webhook delete (treated as "already gone", continue).
- **NOT** missing `.mcp.json` / `.codev/config.json` / webhook match.

### Order of operations

The order matters because we're deleting the piece of state (`state.json`) that lets us identify the webhook. The correct order is:

1. **Validate args** (parse, check forge-specific flags).
2. **Find project root** (`findProjectRoot`).
3. **Load `state.json`** — fail fast if missing. This gives us `smeeUrl` to match the webhook.
4. **For Gitea only**: read `GITEA_TOKEN` from env or `.env` — fail fast if missing (same ordering as setup).
5. **Delete the webhook on the forge** (by smeeUrl match). 404 during the match lookup or the DELETE call is not an error.
6. **Delete `state.json`** (unlink). If the file is gone between step 3 and step 6 (race with another process), `ENOENT` from unlink is not an error.
7. **Remove canonical `ci` entry from `.mcp.json`** (or warn and skip if customized).
8. **Revert `.codev/config.json`** (if present, if contains loader flag).
9. **Print summary** of what was done.

The key invariant: **step 5 happens before step 6**. If we deleted `state.json` first and then tried to delete the webhook, we'd have no way to match it and would have to either (a) list all hooks and try to guess which one is ours or (b) give up. Neither is acceptable.

**Failure recovery note**: if step 5 fails (e.g., network error mid-DELETE), we exit 1 without touching anything else. The user's `state.json` is intact and re-running `remove` will retry. This is the "state-first ordering" principle from Spec 5/7, applied in reverse: for setup, state is written before network calls so a mid-install failure is recoverable. For remove, state is deleted after network calls so a mid-remove failure is recoverable. Both rules point at the same shape: `state.json` is the source of truth for what's installed, and the installer touches it last on the way in and last on the way out (after the network operation it gates).

Wait — that's backwards. Let me re-read: for setup, state is written BEFORE the network call. For remove, state is deleted AFTER the network call. So the rule is "state.json exists iff the install is 'active' on the local side, regardless of network state." That's the right invariant.

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
- **New remove tests**: up to 10, targeting 8–9.
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
3. Fake `gh` returns `[{ id: 42, config: { url: smeeUrl } }]` on list, `{}` on DELETE.
4. Run `remove --repo owner/repo`.
5. Assert:
   - `gh api repos/owner/repo/hooks` called for list.
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

**Scenario R9 (OPTIONAL)** — Codev file with no loader flag:
1. Seed `state.json` + canonical `.mcp.json`.
2. Seed `.codev/config.json` with `{ shell: { architect: 'claude --dangerously-skip-permissions' } }` (no loader flag).
3. Fake `gh` returns matching hook.
4. Run `remove --repo owner/repo`.
5. Assert:
   - `.codev/config.json` byte-equal after.
   - Stderr contains `does not load ci channel — nothing to revert`.

**Scenario R10 (OPTIONAL)** — Running setup then remove, end-to-end round-trip:
1. Start with a clean temp dir (no state, no .mcp.json, no .codev).
2. Seed state.json + webhookSecret so `fetchSmeeChannel` is never called.
3. Run `setup --repo owner/repo` with a fake `gh` that accepts create.
4. Run `remove --repo owner/repo` with a fake `gh` that returns the created hook and accepts DELETE.
5. Assert: after remove, `state.json` is gone, `.mcp.json` has no `ci` key, temp dir looks as it did before setup (modulo directories that setup creates: `.claude/channels/ci/` may still exist as an empty dir — acceptable).

**Minimum coverage**: R1, R2, R3, R4, R5, R6, R7, R8 (8 tests) are mandatory. R9 and R10 are stretch. Total cap: 10. Below 8 is a REQUEST_CHANGES.

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
