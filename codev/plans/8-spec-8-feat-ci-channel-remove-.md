# Plan: `ci-channel remove` command

## Metadata
- **ID**: plan-2026-04-11-ci-channel-remove
- **Status**: draft
- **Specification**: codev/specs/8-spec-8-feat-ci-channel-remove-.md
- **Created**: 2026-04-11

## Executive Summary

Add a `ci-channel remove` subcommand to the single-file `lib/setup.ts` installer, next to `setup()`. Remove undoes what setup did — deletes the forge webhook, deletes `state.json`, strips the canonical `ci` entry from `.mcp.json`, and reverts the Codev integration if present. All three forges (GitHub, GitLab, Gitea) are supported with the same flag shape as `setup`.

**Per the spec's explicit rule**, code, tests, and docs updates (README, INSTALL, CLAUDE, AGENTS) land in two porch phases but a single PR. The phase split mirrors Spec 7: `impl` (implementation + docs + version bump) and `tests` (new remove test scenarios). Porch requires ≥2 phases.

**Phase 1 (`impl`)**: Extend `lib/setup.ts` with a `remove()` function, inline Codev revert logic, a merged `parseCommandArgs` replacing `parseArgs`, and a **nested `cliDelete` helper** that shares list-match-delete-with-404-soft logic across GitHub and GitLab. Gitea DELETE uses direct `fetch()` to distinguish list-404 (hard) from delete-404 (soft). Update `server.ts` dispatch to recognize `remove`. Bump version to 0.5.0. Update user-facing docs. Runs the existing test suite to catch regressions. **No new test scenarios in Phase 1.**

**Phase 2 (`tests`)**: Add 10 mandatory scenarios (R1–R10) to `tests/setup.test.ts` covering GitHub happy path, GitHub no-match, customized `.mcp.json`, missing `state.json`, GitLab happy path, Gitea happy path, Gitea missing token, Codev revert, delete-404 race, list-404 hard fail, and malformed-state (folded into R4). Target: 10 new tests, **28 total** (at the cap).

**Line-cap commitment**: the spec's pre-budget for `lib/setup.ts` projects ~420 lines pessimistic. Realistic accurate estimate after honest counting: ~425 lines with naive implementation. Phase 1 commits upfront to **five specific tightening levers** (see "Tightening commitments" in Phase 1). Projected landing: **395–405 lines**. This is genuinely tight and Phase 1 has a hard escalation gate: `wc -l lib/setup.ts > 400` at any intermediate build blocks the phase and requires notifying the architect before proceeding.

Both phases land in a single PR. The number of git commits is porch bookkeeping; squash-merge at merge time if the reviewer prefers a single commit.

## Success Metrics

Copied from `codev/specs/8-spec-8-feat-ci-channel-remove-.md`:

- [ ] `ci-channel remove --repo owner/repo` (GitHub, default) fully reverses a prior setup against the same repo — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitlab --repo group/project` does the same for GitLab — verified by fake-CLI test.
- [ ] `ci-channel remove --forge gitea --gitea-url URL --repo owner/repo` does the same for Gitea — verified by local-HTTP-server test.
- [ ] Running `remove` in a project with no `state.json` fails fast with `no ci-channel install detected in this project` and exit code 1.
- [ ] Running `remove` with `state.json` present but malformed or missing `smeeUrl` fails fast with a distinct error message, exit code 1, and no mutations to `.mcp.json`, `.codev/config.json`, or the forge.
- [ ] Running `remove` twice in a row: first succeeds (exit 0), second fails fast (exit 1).
- [ ] Non-canonical `.mcp.json` `ci` entry: left alone with a warning, other cleanup still succeeds.
- [ ] `.codev/config.json` with loader flag: flag stripped (with its leading space), file rewritten in canonical JSON.
- [ ] `.codev/config.json` without loader flag or missing: no-op, no error.
- [ ] 404 on DELETE (webhook race): soft handled, continue. 404 on LIST (repo not found): hard fail.
- [ ] All existing tests continue to pass; baseline count recorded at the start of Phase 1 via `npm test 2>&1 | tail -5`.
- [ ] `wc -l lib/setup.ts` ≤ 400
- [ ] `wc -l tests/setup.test.ts` ≤ 600
- [ ] `tests/setup.test.ts` contains ≤ 28 tests total (18 pre-existing + ≤10 new)
- [ ] `lib/setup.ts` is still a single file; `lib/setup/` still does not exist; `lib/remove.ts` still does not exist
- [ ] No new runtime or dev dependencies in `package.json`
- [ ] Ships as v0.5.0
- [ ] `server.ts` dispatch ≤ 8 lines and does not load `lib/setup.js` unless the user invoked `setup` or `remove`

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "impl", "title": "Implementation: lib/setup.ts remove() + server.ts dispatch + docs + version bump"},
    {"id": "tests", "title": "Automated tests: 9 remove scenarios in tests/setup.test.ts"}
  ]
}
```

## Phase Breakdown

### Phase 1: Implementation (`lib/setup.ts` remove() + server.ts dispatch + docs + version bump)

**Dependencies**: None

#### Objective

Extend `lib/setup.ts` with:
- A merged `parseCommandArgs(argv, command)` function that replaces the existing `parseArgs` (+2 lines over the current 24-line function)
- A `remove()` exported function with three forge branches (GitHub, GitLab, Gitea) sharing helpers with `setup()`
- A **nested `cliDelete` helper inside `remove()`** that de-duplicates the GitHub + GitLab list-match-delete-with-404-soft logic (saves ~22 lines vs. inlining both branches)
- **Inline Codev revert logic inside `remove()`** (wrapped in a local try/catch) rather than a separate top-level `codevRevert` helper — saves ~7 lines vs. a separate function
- A local try/catch-based approach to 404-on-DELETE soft handling (Option B from the spec — no change to `classifyForgeError` signature)
- Direct `readFileSync` + `JSON.parse` precondition check for `state.json` (do NOT use `loadState`, which swallows errors)
- Gitea DELETE uses direct `fetch()` with manual status handling (bypasses `giteaFetch` which throws on 404)

Extend `server.ts` dispatch to recognize both `setup` and `remove`. Dynamic import of `lib/setup.js` must still only happen when the user invoked a subcommand.

Final `lib/setup.ts` must be ≤400 lines. Update user-facing docs (README, INSTALL, CLAUDE, AGENTS) and bump `package.json` + `package-lock.json` version to `0.5.0`.

#### Tightening commitments (upfront, not contingent)

The naive implementation counts to ~425 lines. To land at ≤400, Phase 1 commits to **all five** of these tightening levers from the start. These are not "if overage persists" fallbacks.

1. **Nested `cliDelete` helper inside `remove()`** (~20 lines) — shared by GitHub and GitLab DELETE paths. Call sites are 1 line each. Saves ~22 lines vs. inlining both branches (22+22=44 → 20+2=22).
2. **Inline Codev revert into `remove()`** (~18 lines inside a local try/catch), NOT a separate `codevRevert` helper. Saves ~7 lines vs. a top-level helper (function signature, closing brace, call site, return statements add up).
3. **Compact `.mcp.json` revert block** (~18 lines) — use a single `if/else` chain instead of nested guards. Compact canonical check using `&&` chaining inside the same `if`.
4. **Compact state.json precondition** (~12 lines) — one outer `if (!existsSync)` + one try/catch for JSON.parse + one smeeUrl check. No intermediate variables beyond `state` and `smeeUrl`.
5. **Terse log strings** — reuse setup's existing log line shapes. Don't add verbose explanatory messages. Skip blank separator lines between sections inside `remove()` (setup has a few; remove should omit them).

**Baseline expected impact (with all five levers applied):**

| Change | Lines | Running Total |
|--------|-------|---------------|
| Current `lib/setup.ts` | — | 300 |
| `parseCommandArgs` rename/extension (+2) | +2 | 302 |
| `unlinkSync` import (+1) | +1 | 303 |
| `remove()` prelude + args + findProjectRoot + logs (~7) | +7 | 310 |
| state.json precondition (Lever 4, ~12) | +12 | 322 |
| Gitea token check (~8) | +8 | 330 |
| Nested `cliDelete` helper (Lever 1, ~20) | +20 | 350 |
| GitHub + GitLab branch call sites (~4) | +4 | 354 |
| Gitea DELETE branch inline (~22, with direct fetch) | +22 | 376 |
| state.json unlink (~5) | +5 | 381 |
| `.mcp.json` revert (Lever 3, ~18) | +18 | 399 |
| Inline Codev revert (Lever 2, ~18) | +18 | 417 |
| Final stdout + outer catch (~5) | +5 | 422 |

Naive projection: **~422**. Still over. **Additional compression required**:

6. **Compress Gitea branch**: reuse `giteaFetch` for the LIST call (existing behavior, ~2 lines in `remove()`), and inline DELETE fetch in ~14 lines instead of 22. Drop the separate `authHdrs`/`jsonHdrs` vars and inline the headers at the call site. **Saves ~8 lines.** New total: **414**.

7. **Compress `.mcp.json` revert** further by building `expectedArgs` inline inside the `JSON.stringify` check, and using a single compound expression for the canonical-check. **Saves ~5 lines.** New total: **409**.

8. **Drop the "Forge:        ${forge}" log line**: it duplicates the `--forge` flag the user just typed. **Saves 1 line.** New total: **408**.

9. **Inline state.json precondition's error message variables**: no `statePath` reuse inside the error text, just `${statePath}` literal. **Saves ~2 lines** (removing intermediate error variable constructions). New total: **406**.

10. **Reduce outer catch to a single line**: `} catch (err) { console.error(...); process.exit(1); }` on one physical line (acceptable in TypeScript). **Saves ~2 lines.** New total: **404**.

Realistic landing zone after all 10 levers: **400–410**, with **400** as the hard target.

**Phase 1 escalation gate**: after the implementation builds and compiles, `wc -l lib/setup.ts` must return ≤400. If it returns 401–410, apply additional compression (tighten variable names, shorten log strings, drop blank lines). If it returns >410, Phase 1 stops and the builder notifies the architect via `afx send architect "Project 8: lib/setup.ts landed at N lines, exceeds 400-line cap after all tightening levers. Requesting cap increase or scope reduction."`. The builder does NOT silently exceed the cap.

#### Files

- **Modify**: `lib/setup.ts` — extend the existing 300-line file with `remove()` and `codevRevert`, merge `parseArgs` into `parseCommandArgs`
- **Modify**: `server.ts` — extend the 5-line setup dispatch (lines 20–24) to also match `remove`. Must stay ≤8 lines total.
- **Modify**: `package.json` — version bump `0.4.0` → `0.5.0`
- **Modify**: `package-lock.json` — version bump `0.4.0` → `0.5.0` in BOTH `version` fields (root + first package block). Lockfile-only edit, no `npm install` re-run needed (no dependencies change).
- **Modify**: `README.md` — add short "Uninstall" section with the three forge commands (≤5 lines each)
- **Modify**: `INSTALL.md` — add a note that `ci-channel remove` is the inverse of `ci-channel setup` for all three forges
- **Modify**: `CLAUDE.md` and `AGENTS.md` — add one-line mention that `remove` is the inverse of `setup`. Keep the two files in sync.
- **Modify**: `codev/resources/arch.md` — one-line note that `lib/setup.ts` also exports `remove()`. If the file has no mention of `setup.ts`, this edit is a no-op and can be skipped.
- **Modify**: `tests/setup.test.ts` — NO test changes in Phase 1. The existing 18 tests stay unchanged. Phase 1's `npm test` gate is regression-only.

No other files touched. **Do NOT create `lib/remove.ts`.** **Do NOT create `lib/setup/` directory.**

#### Implementation Sketch

Starting point: `lib/setup.ts` is 300 lines, 11 sections (imports, constants, parseArgs, readEnvToken, cliApi, classifyForgeError, giteaFetch, codevIntegrate, setup body). The additions:

**1. Merge `parseArgs` into `parseCommandArgs` (replace existing, net -0 to +5 lines)**

```typescript
function parseCommandArgs(argv: string[], command: 'setup' | 'remove'): { repo: string; forge: Forge; giteaUrl?: string } {
  const usageFlags = '--repo owner/repo [--forge github|gitlab|gitea] [--gitea-url URL]'
  const usage = `Usage: ci-channel ${command} ${usageFlags}`
  let repo: string | undefined
  let forge: Forge = 'github'
  let giteaUrl: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo' && i + 1 < argv.length) { repo = argv[++i]; continue }
    if (a === '--forge' && i + 1 < argv.length) {
      const v = argv[++i]
      if (!VALID_FORGES.includes(v as Forge)) {
        throw new Error(`Invalid --forge '${v}'. Must be one of: github, gitlab, gitea (lowercase).`)
      }
      forge = v as Forge
      continue
    }
    if (a === '--gitea-url' && i + 1 < argv.length) { giteaUrl = argv[++i]; continue }
    throw new Error(`${usage} (unexpected arg: ${a})`)
  }
  if (!repo) throw new Error(usage)
  if (forge === 'gitea' && !giteaUrl) throw new Error('--gitea-url is required when --forge gitea')
  if (forge !== 'gitea' && giteaUrl) throw new Error('--gitea-url is only valid with --forge gitea')
  if (giteaUrl && !/^https?:\/\//i.test(giteaUrl)) throw new Error(`--gitea-url must start with http:// or https:// (got '${giteaUrl}')`)
  return { repo, forge, giteaUrl }
}
```

The existing `setup()` body calls `parseCommandArgs(argv, 'setup')` and `remove()` calls `parseCommandArgs(argv, 'remove')`. The only user-visible change is the usage string in error messages, which correctly reads `ci-channel setup ...` or `ci-channel remove ...`.

**Net line impact**: the current `parseArgs` is 24 lines. The new `parseCommandArgs` is ~26 lines (adds the `command` parameter and the usage string variable). Net +2 lines in this section, but eliminates the need for a separate 20-line `parseRemoveArgs`. **Total savings**: ~18 lines vs. duplication.

**2. Codev revert is inlined into `remove()` (NOT a separate helper)**

The iter1 plan proposed a top-level `codevRevert` helper mirroring `codevIntegrate` (~25 lines). Claude's iter1 review flagged that the line cap is tight and a top-level helper wastes lines on function boilerplate. The revised plan **inlines the revert logic directly in `remove()`** inside a local try/catch (Lever 2 from "Tightening commitments"), saving ~7 lines. The logic is identical to what `codevRevert` would have done:

```typescript
// At the end of remove(), right before the final stdout
const codevPath = join(root, '.codev', 'config.json')
if (existsSync(codevPath)) {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: user-owned JSON
    const config: any = JSON.parse(readFileSync(codevPath, 'utf-8'))
    const architect = config?.shell?.architect
    const needle = ` ${CODEV_FLAG}`
    if (typeof architect !== 'string' || architect.length === 0) {
      log(`.codev/config.json has no shell.architect — skipping (unexpected Codev shape)`)
    } else if (!architect.includes(needle)) {
      log(`.codev/config.json does not load ci channel — nothing to revert`)
    } else {
      config.shell.architect = architect.replace(needle, '')
      writeFileSync(codevPath, JSON.stringify(config, null, 2) + '\n')
      log(`Reverted .codev/config.json: architect session will no longer load ci channel`)
    }
  } catch (err) {
    log(`warning: Codev revert failed: ${(err as Error).message}. Other cleanup succeeded; edit .codev/config.json manually to remove ${CODEV_FLAG} from shell.architect.`)
  }
}
```

**~18 lines inlined.** The local try/catch preserves the "log and continue on failure" contract from the spec — a malformed `.codev/config.json` logs a warning and `remove` proceeds to the final "Done" message.

**Implementation rules**:
- `needle = ` ${CODEV_FLAG}`` (with leading space) matches the exact string `codevIntegrate` wrote. Substring-match-with-leading-space handles the edge case where the flag is at the start of the string (no match → "nothing to revert" path, which is acceptable).
- `replace(needle, '')` strips the flag and its single leading space (no whitespace collapse elsewhere).
- Log lines: "Reverted" / "nothing to revert" / "no shell.architect" — verbatim from spec.
- Use an `if/else if/else` chain instead of early returns to avoid duplicating the `try { ... } catch { ... }` boilerplate.

**3. `remove()` body (~108 lines with all tightening levers applied; 127 naive)**

This sketch is the canonical structure Phase 1 commits to. Comments in parentheses show approximate line counts per block.

```typescript
export async function remove(argv: string[]): Promise<void> {
  try {
    const { repo, forge, giteaUrl } = parseCommandArgs(argv, 'remove')
    const root = findProjectRoot()
    if (!root) {
      throw new Error('No project root found (no .git/ or .mcp.json in any ancestor). Run this from inside the project you want to uninstall from.')
    }
    log(`Project root: ${root}`)
    log(`Target repo:  ${repo}`)
    log(`Forge:        ${forge}`)

    // Step 3: strict precondition check on state.json (do NOT use loadState)
    const statePath = join(root, '.claude', 'channels', 'ci', 'state.json')
    if (!existsSync(statePath)) {
      throw new Error(`no ci-channel install detected in this project (no state.json at ${statePath}). Nothing to uninstall.`)
    }
    // biome-ignore lint/suspicious/noExplicitAny: state.json is user-owned
    let state: any
    try {
      state = JSON.parse(readFileSync(statePath, 'utf-8'))
    } catch (err) {
      throw new Error(`state.json at ${statePath} is unreadable or malformed: ${(err as Error).message}. Fix or delete the file, then retry.`)
    }
    const smeeUrl: unknown = state?.smeeUrl
    if (typeof smeeUrl !== 'string' || smeeUrl.length === 0) {
      throw new Error(`state.json at ${statePath} is missing a 'smeeUrl' field. Cannot match webhook. If you want to force a reinstall, delete state.json and re-run \`ci-channel setup\`.`)
    }

    // Step 4: Gitea token check BEFORE any webhook API call
    let giteaToken: string | undefined
    if (forge === 'gitea') {
      const envPath = join(root, '.claude', 'channels', 'ci', '.env')
      giteaToken = (process.env.GITEA_TOKEN ?? '').trim() || (readEnvToken(envPath, 'GITEA_TOKEN') ?? '').trim() || undefined
      if (!giteaToken) {
        throw new Error(`GITEA_TOKEN not set. Generate a token at ${giteaUrl}/user/settings/applications (scopes: write:repository) and add it to ${envPath} as GITEA_TOKEN=... or export GITEA_TOKEN in your shell.`)
      }
    }

    // Step 5: Delete webhook on forge (forge-specific; shared 404-on-DELETE soft handling)
    if (forge === 'github') {
      log(`Listing existing webhooks on ${repo}...`)
      try {
        const listOut = await cliApi('gh', ['api', '--paginate', '--slurp', `repos/${repo}/hooks`], null)
        const pages = JSON.parse(listOut)
        const hooks = Array.isArray(pages) ? pages.flat() : []
        // biome-ignore lint/suspicious/noExplicitAny: untyped webhook JSON
        const existingHook = hooks.find((h: any) => h?.config?.url === smeeUrl)
        if (!existingHook) {
          log(`no matching webhook found on github; skipping webhook delete`)
        } else {
          log(`Found webhook ${existingHook.id} on ${repo} — deleting...`)
          try {
            await cliApi('gh', ['api', '--method', 'DELETE', `repos/${repo}/hooks/${existingHook.id}`], null)
            log(`Deleted webhook ${existingHook.id}`)
          } catch (delErr) {
            // 404 on DELETE = webhook gone (race); any other error is hard fail
            // biome-ignore lint/suspicious/noExplicitAny: err is opaque
            const stderr = String((delErr as any)?.stderr ?? '')
            if (/HTTP 404|Not Found/i.test(stderr)) {
              log(`webhook ${existingHook.id} already deleted on github; continuing`)
            } else {
              throw classifyForgeError('gh', delErr, repo)
            }
          }
        }
      } catch (err) {
        // This catches list errors AND re-raised delete errors (classified above).
        // If the error is already an Error from classifyForgeError, don't re-classify.
        if (err instanceof Error && !/^gh /.test(err.message) && !(err as any).stderr) throw err
        throw classifyForgeError('gh', err, repo)
      }
    } else if (forge === 'gitlab') {
      // ... (similar shape to github, with glab + url top-level + 404-on-DELETE soft)
    } else {
      // gitea — direct fetch, manual 404-on-DELETE handling
    }

    // Step 6: Delete state.json (ENOENT is fine)
    try {
      unlinkSync(statePath)
      log(`Deleted state.json`)
    } catch (err) {
      // biome-ignore lint/suspicious/noExplicitAny: err is opaque
      if ((err as any)?.code !== 'ENOENT') throw err
      log(`state.json already gone`)
    }

    // Step 7: Remove canonical ci entry from .mcp.json
    const mcpPath = join(root, '.mcp.json')
    if (!existsSync(mcpPath)) {
      log(`no .mcp.json found — skipping`)
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: user-owned JSON
      const mcp: any = JSON.parse(readFileSync(mcpPath, 'utf-8'))
      const servers = mcp?.mcpServers
      if (servers == null) {
        log(`no 'ci' entry in .mcp.json — skipping`)
      } else if (typeof servers !== 'object' || Array.isArray(servers)) {
        log(`warning: .mcp.json mcpServers is not an object — skipping`)
      } else if (!('ci' in servers)) {
        log(`no 'ci' entry in .mcp.json — skipping`)
      } else {
        const entry = servers.ci
        const expectedArgs: string[] = ['-y', 'ci-channel']
        if (forge !== 'github') expectedArgs.push('--forge', forge)
        if (forge === 'gitea') expectedArgs.push('--gitea-url', giteaUrl!.replace(/\/$/, ''))
        const isCanonical = entry
          && typeof entry === 'object'
          && Object.keys(entry).sort().join(',') === 'args,command'
          && entry.command === 'npx'
          && Array.isArray(entry.args)
          && JSON.stringify(entry.args) === JSON.stringify(expectedArgs)
        if (isCanonical) {
          delete servers.ci
          writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
          log(`Removed 'ci' from ${mcpPath}`)
        } else {
          log(`warning: .mcp.json 'ci' entry does not match the canonical shape for --forge ${forge}. Leaving it alone. Edit .mcp.json manually if you want to remove it.`)
        }
      }
    }

    // Step 8: Codev revert (local try/catch inside codevRevert)
    codevRevert(root)

    // Step 9: Summary
    console.log(`\nDone. ci-channel removed from ${repo}.`)
  } catch (err) {
    console.error(`[ci-channel] remove failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
```

**Shared `cliDelete` nested helper (~20 lines, Lever 1)**

The GitHub and GitLab branches have the same list-match-delete-with-404-soft shape — only the CLI binary, list path, match key, and delete path differ. Nest a helper inside `remove()` (not at the top of the file) to share the structure:

```typescript
async function cliDelete(
  bin: 'gh' | 'glab',
  listArgs: string[],
  matchFn: (h: any) => boolean,
  delPath: (id: number) => string,
): Promise<void> {
  log(`Listing existing hooks for ${bin} ${repo}...`)
  let hooks: unknown[]
  try {
    const listOut = await cliApi(bin, listArgs, null)
    const parsed = JSON.parse(listOut)
    hooks = bin === 'gh' ? (Array.isArray(parsed) ? parsed.flat() : []) : (Array.isArray(parsed) ? parsed : [])
  } catch (err) { throw classifyForgeError(bin, err, repo) }
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
  const hit = hooks.find(matchFn) as any
  if (!hit) { log(`no matching webhook found on ${bin === 'gh' ? 'github' : 'gitlab'}; skipping webhook delete`); return }
  log(`Found webhook ${hit.id} on ${repo} — deleting...`)
  try {
    await cliApi(bin, ['api', '--method', 'DELETE', delPath(hit.id)], null)
    log(`Deleted webhook ${hit.id}`)
  } catch (delErr) {
    // biome-ignore lint/suspicious/noExplicitAny: err is opaque
    if (/HTTP 404|Not Found/i.test(String((delErr as any)?.stderr ?? ''))) log(`webhook ${hit.id} already deleted; continuing`)
    else throw classifyForgeError(bin, delErr, repo)
  }
}
```

**~20 lines.** Closure captures `repo` and (for match functions) `smeeUrl` from the enclosing scope. The two outer try/catch blocks disambiguate LIST errors (hard fail via `classifyForgeError`) from DELETE 404 (soft fail, log and continue).

**Call sites (GitHub + GitLab = 4 lines total)**:

```typescript
if (forge === 'github') {
  await cliDelete('gh', ['api', '--paginate', '--slurp', `repos/${repo}/hooks`],
    (h: any) => h?.config?.url === smeeUrl, (id) => `repos/${repo}/hooks/${id}`)
} else if (forge === 'gitlab') {
  const enc = encodeURIComponent(repo)
  await cliDelete('glab', ['api', `projects/${enc}/hooks`],
    (h: any) => h?.url === smeeUrl, (id) => `projects/${enc}/hooks/${id}`)
} else {
  // gitea — inline, see below
}
```

**Savings**: ~44 inline lines (22 GitHub + 22 GitLab) reduced to ~28 lines (20 helper + 4 call sites + 4 scaffolding). **Net savings: ~16 lines**, not ~22 as I projected in iter1 — but still the best available tightening lever for remove()'s forge branches.

**Gitea DELETE branch (~22 lines inline)**: Gitea uses `fetch()` for the DELETE path specifically (to distinguish list-404 hard from delete-404 soft) but reuses the existing `giteaFetch` for the LIST call (where 404 is a hard fail — this is the existing behavior and matches the spec's 404-handling rule). Only the DELETE uses direct `fetch` with manual status handling.

**4. GitLab branch inside `remove()` (~25 lines)**

Same two-block shape. Differences from GitHub:
- Use `glab api` instead of `gh api`
- Path is `projects/${encodeURIComponent(repo)}/hooks` and `projects/${encoded}/hooks/${id}`
- Match rule: `h.url === smeeUrl` (not `h.config?.url`)
- DELETE method flag: `--method DELETE`
- 404-on-DELETE detection: same `/HTTP 404|Not Found/i.test(stderr)` pattern
- `classifyForgeError('glab', err, repo)` for hard errors

**5. Gitea branch inside `remove()` (~35 lines)**

Gitea is trickier because the existing `giteaFetch` throws on non-2xx. Plan-phase decision: **bypass `giteaFetch` for the DELETE call only**. Use direct `fetch()` with manual status handling, so we can distinguish 404 (soft) from other errors (hard) at the call site.

```typescript
// gitea — giteaUrl and giteaToken are guaranteed defined at this point
const base = giteaUrl!.replace(/\/$/, '')
const url = `${base}/api/v1/repos/${repo}/hooks`
const authHdrs = { Authorization: `token ${giteaToken!}` }
log(`Listing existing hooks at ${url}...`)
const listResp = await giteaFetch(url, { headers: authHdrs }, repo, base)
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON
const hooks = (await listResp.json()) as any[]
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON
const existingHook = Array.isArray(hooks) ? hooks.find((h: any) => h?.config?.url === smeeUrl) : null
if (!existingHook) {
  log(`no matching webhook found on gitea; skipping webhook delete`)
} else {
  log(`Found webhook ${existingHook.id} on ${repo} — deleting...`)
  // Direct fetch with manual 404 soft-handling (bypass giteaFetch for DELETE)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10000)
  let delResp: Response
  try { delResp = await fetch(`${url}/${existingHook.id}`, { method: 'DELETE', headers: authHdrs, signal: ac.signal }) }
  finally { clearTimeout(timer) }
  if (delResp.status === 404) {
    log(`webhook ${existingHook.id} already deleted on gitea; continuing`)
  } else if (!delResp.ok) {
    const body = await delResp.text().catch(() => '')
    if (delResp.status === 403) throw new Error(`Access denied to '${repo}' hooks on ${base}. Your GITEA_TOKEN needs write:repository scope.`)
    if (delResp.status === 401) throw new Error(`GITEA_TOKEN is invalid or expired. Generate a new one at ${base}/user/settings/applications.`)
    throw new Error(`Gitea API error (status ${delResp.status}): ${body}`)
  } else {
    log(`Deleted webhook ${existingHook.id}`)
  }
}
```

The direct-fetch block for DELETE is ~15 lines. The plan phase could alternatively grow `giteaFetch` with a `{ soft404: true }` option (~3 lines added to `giteaFetch`, ~2 lines removed from remove), but that couples the helper to remove's semantics. The direct-fetch approach is slightly more explicit and easier to read. **Plan phase commitment**: use direct `fetch` for the Gitea DELETE call.

**6. `server.ts` dispatch extension**

Current (lines 20–24):
```typescript
if (process.argv[2] === "setup") {
  const { setup } = await import("./lib/setup.js");
  await setup(process.argv.slice(3));
  process.exit(0);
}
```

New (still 5 lines — `process.exit(0);` and `}`):
```typescript
if (process.argv[2] === "setup" || process.argv[2] === "remove") {
  const mod = await import("./lib/setup.js");
  await (process.argv[2] === "setup" ? mod.setup : mod.remove)(process.argv.slice(3));
  process.exit(0);
}
```

**Exactly 5 lines**, within the 8-line cap. Dynamic import only fires on `setup`/`remove` invocation; the server startup path still does not load installer code.

**7. Docs updates (not in `lib/setup.ts`)**

- `README.md`: add a "## Uninstall" section right after the existing "## Install" section with the three forge commands. Keep each example ≤5 lines. Point out the `--repo` must be explicit.
- `INSTALL.md`: add a note under the automatic installer section that `ci-channel remove` is the inverse and supports all three forges with the same flags.
- `CLAUDE.md` and `AGENTS.md`: one-line mention in the Installation section, e.g., "Run `ci-channel remove --repo OWNER/REPO` to uninstall (supports `--forge gitlab|gitea` the same way setup does)." Keep both files in sync per the existing note at the top of CLAUDE.md.
- `codev/resources/arch.md`: if the file mentions `lib/setup.ts` anywhere, add a one-liner noting that `remove()` is exported alongside `setup()`. Otherwise skip.
- `package.json`: `"version": "0.4.0"` → `"version": "0.5.0"`.
- `package-lock.json`: update both `version` fields (root + first package block) to `0.5.0`. Lockfile-only edit, no `npm install` re-run.

#### Acceptance Criteria

- [ ] `wc -l lib/setup.ts` reports ≤ 400 (if 401–410, tighten further; if >410, escalate — see Tightening commitments)
- [ ] `wc -l server.ts` reports within [current - 0, current + 3] (dispatch extension only, no other changes)
- [ ] `lib/setup.ts` compiles (`npm run build` succeeds)
- [ ] `grep -E 'lib/remove\.ts|lib/setup/|ForgeUninstaller|FORGE_UNINSTALLERS' lib/` returns nothing
- [ ] `grep -c '^export async function ' lib/setup.ts` is 2 (setup + remove)
- [ ] `lib/setup.ts` calls `loadState` only from inside `setup()`, never from `remove()` — verified by inspection (the spec requires direct `readFileSync` + `JSON.parse` for the precondition check)
- [ ] `npm test` passes. The repo currently reports `tests 191` / `pass 191` across 11 test files (18 of which are in `tests/setup.test.ts`). Phase 1 makes no test edits, so the count must still be exactly `191` after Phase 1. If the baseline is not 191 at Phase 1 start, record the actual baseline from `npm test 2>&1 | tail -5` and compare to it instead.
- [ ] `server.ts` dispatch is ≤ 8 lines and still uses `await import('./lib/setup.js')` dynamically
- [ ] `package.json` version is `0.5.0`
- [ ] `package-lock.json` version is `0.5.0` in **both** places (verify with `grep -c '"version": "0.5.0"' package-lock.json` reports exactly 2)
- [ ] README / INSTALL / CLAUDE / AGENTS mention `ci-channel remove`

#### Test Approach (Phase 1)

- Phase 1 runs the **existing** full test suite (`npm test`, currently `tests 191`) as a regression gate. **No new scenarios, no modified assertions.**
- **First action of Phase 1**: run `npm test 2>&1 | tail -5` to record the actual baseline count. Copy this count into the phase commit message.
- If `npm test` shows any regression from the recorded baseline (fewer passes, any fails), Phase 1 is blocked until fixed.
- Manual smoke test (not automated, not a Phase 1 gate): build with `npm run build`, then run `node dist/server.js remove --repo owner/repo` in a non-project directory and confirm it prints `No project root found ...`. Informational only.

---

### Phase 2: Automated tests (`tests/setup.test.ts`)

**Dependencies**: Phase 1

#### Objective

Add **10 mandatory scenarios** (R1–R10) to `tests/setup.test.ts` covering the remove command paths. Reuse existing test scaffolding (`mkFakeCli`, `withGiteaServer`, `inProject`, `seedState`) — do NOT extend `mkFakeCli` (it's already method-agnostic).

Final `tests/setup.test.ts` must be ≤600 lines and contain ≤28 tests total. Target: 10 new tests, **28 total** (18 existing + 10 new).

#### Files

- **Modify**: `tests/setup.test.ts` — add 10 new scenarios + a small `runRemove` helper (5 lines, in-process, mirrors existing `runSetup` at lines 64–76)

No other files touched. **No new test files** (e.g., no `tests/remove.test.ts`). **No modifications to `mkFakeCli` or `withGiteaServer`.**

#### Factual corrections about the existing test scaffolding

The plan-iter1 Claude and Codex reviews caught two factual errors in the iter1 plan draft that are now fixed:

1. **`runSetup` is in-process, not dist-based.** The existing helper (tests/setup.test.ts:64–76) imports `setup` from `../lib/setup.js` at the top of the file (line 8) and invokes it directly in-process, stubbing `process.exit` and capturing `process.stderr.write`. **`runRemove` must mirror this exact pattern** — import `remove` alongside `setup` at line 8, and build a `runRemove` helper that's a 5-line copy of `runSetup` but calls `remove(argv)` instead. No `dist/server.js` spawning, no build step dependency.

2. **`mkFakeCli` is counter-based, not method-dispatched.** The helper (tests/setup.test.ts:19–36) writes responses indexed by call count (`${name}.out.${n}`) and reads them by an incrementing counter at script invocation time. It has no HTTP-method dispatch — it just returns the Nth response on the Nth call, regardless of what args the CLI was invoked with. **No helper extension is needed for DELETE support.** Tests just seed `responses[0]` as the list response and `responses[1]` as the DELETE response, in that order. The fake CLI returns them in sequence.

3. **`withGiteaServer` is already method-agnostic.** The handler signature `(req, res) => void` takes full control of request routing. Gitea tests register `req.method === 'DELETE'` branches in their handler closure. No helper change needed.

**Net helper changes**: zero. Add only the 5-line `runRemove` helper.

#### Helper extension (5 lines)

```typescript
// Add at tests/setup.test.ts line 8 (alongside the existing import)
import { setup, remove } from '../lib/setup.js'

// Add a runRemove helper right after runSetup (tests/setup.test.ts line 76)
async function runRemove(argv: string[]): Promise<Result> {
  return runCommand(remove, argv)
}
```

Even shorter: factor `runSetup` and `runRemove` through a shared `runCommand(fn, argv)` that both delegate to. `runSetup` becomes 1 line (`return runCommand(setup, argv)`), `runRemove` is 1 line. **Saves ~8 lines total across the two helpers.**

**Scenarios R1–R10 (details from spec; implementation notes here)**

| ID | Lines | Notes |
|----|-------|-------|
| R1 | ~32 | GitHub happy path. List response: `[[{id:42, config:{url:smeeUrl}}]]` (nested array — matches setup's `gh api --paginate --slurp` shape). Fake DELETE returns `{}` on success. **Also folds in the "remove-twice" assertion**: after the first `runRemove` succeeds, a second `runRemove` call asserts exit code 1 and stderr contains `no ci-channel install detected`. This addresses Codex issue 2 ("remove twice not tested") without a separate test. ~4 extra lines for the second assertion. |
| R2 | ~18 | GitHub no matching webhook. List returns `[[]]`. No DELETE recorded. Assert `no matching webhook found`, exit 0, state.json deleted, .mcp.json cleaned. |
| R3 | ~24 | GitHub customized .mcp.json. Seed ci entry with extra `env` key. **Assertion string**: stderr contains `does not match the canonical shape for --forge github` (matches the actual log line from `remove()` — NOT the earlier "is customized — leaving alone" phrasing from iter1, which was a drafting error). Assert ci entry byte-equal after remove, webhook still deleted, exit 0. |
| R4 | ~18 | **Two sub-assertions folded into one test**: (a) no state.json at all → fail fast with `no ci-channel install detected`; (b) state.json present but missing `smeeUrl` → fail fast with `missing a 'smeeUrl' field`. Both assert exit code 1, no fake-gh call recorded, .mcp.json untouched, state.json untouched (in case b). This covers spec criterion for R10 (malformed/missing-smeeUrl) by folding R10 into R4. **R10 is not a separate test.** |
| R5 | ~24 | GitLab happy path. Fake glab with list response `[{ id: 77, url: smeeUrl }]` (top-level `url`, no `config` nesting, no pagination). DELETE returns `{}`. Assert `glab api projects/group%2Fproject/hooks` for list and `glab api --method DELETE projects/group%2Fproject/hooks/77` for delete. |
| R6 | ~30 | Gitea happy path. HTTP server with GET + DELETE handlers (same `withGiteaServer` helper). Assert `Authorization: token fake-token` on both requests, DELETE path `/api/v1/repos/owner/repo/hooks/99`. |
| R7 | ~20 | Gitea missing token. Assert exit 1, stderr `GITEA_TOKEN not set`, **state.json still exists** (precondition fail-fast before local mutation), **no HTTP request received by the server**. |
| R8 | ~24 | Codev revert. Seed `.codev/config.json` with `{ shell: { architect: 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:ci' } }`. After remove, assert architect is `'claude --dangerously-skip-permissions'` (flag + leading space stripped). Stderr contains `Reverted .codev/config.json`. |
| R9 | ~22 | 404-during-DELETE race. Fake gh returns hook on list, DELETE exits 1 with stderr `HTTP 404: Not Found`. Assert `already deleted` in stderr, state.json deleted, .mcp.json cleaned, exit 0. |
| R10 | ~20 | **LIST-404 hard failure** (addresses Codex issue 3). Fake gh returns exit 1 with stderr `HTTP 404: Not Found` on the LIST call (before any DELETE). Assert exit 1, stderr contains `Could not find repo` (the existing `classifyForgeError` message), **state.json still exists**, **.mcp.json untouched**. This is distinct from R9 (which tests 404 on DELETE); R10 tests 404 on LIST. R10 is mandatory. |

Total new test body: ~232 lines. Plus helper extension (runRemove + shared runCommand refactor): ~0 net (the refactor saves lines by deduplicating the two helpers).

**Estimated final file size**: 399 (current) + 232 (scenarios) - 3 (helper refactor savings) + 5 (imports + minor changes) = **~633 lines**.

**Over the 600-line cap by ~33 lines.** Phase 2 commits upfront to **all four** tightening strategies:

1. **Shared `runCommand(fn, argv)` helper** backing both `runSetup` and `runRemove` (saves ~8 lines vs. two full copies).
2. **Compact canonical .mcp.json seeding** via a local `makeMcp(forge)` helper (~5 lines) shared by R1, R2, R3, R4, R9 (saves ~15 lines of duplicated seeding).
3. **Compact state.json seeding** — already available via existing `seedState` helper. Use it in all tests. No additional savings (already factored).
4. **Tight assertion style** — use `assert.match(stderr, /.../)` with combined regex patterns instead of multiple `assert.ok` checks. Saves ~1 line per test × 10 = ~10 lines.

Applied: 633 - 8 - 15 - 10 = **~600 lines** (right at the cap).

**Phase 2 escalation gate**: after all scenarios are added and `npm test` passes, `wc -l tests/setup.test.ts` must return ≤600. If 601–620, apply further compression (inline small assertions, drop blank lines). If >620, Phase 2 stops and the builder notifies the architect. **Do NOT silently raise the cap.**

#### Acceptance Criteria

- [ ] `wc -l tests/setup.test.ts` reports ≤ 600
- [ ] Test count in `tests/setup.test.ts` specifically is 28 (`grep -c "^\s*test(" tests/setup.test.ts` reports 28, being 18 existing + 10 new remove scenarios)
- [ ] All 10 mandatory scenarios R1–R10 are present, identified by `test('remove ...', ...)` naming
- [ ] `npm test` passes with the updated total test count. The repo currently reports `tests 191` / `pass 191` (11 test files combined; 18 from setup.test.ts). After Phase 2, total should be `tests 201` / `pass 201` (18 + 10 = 28 in setup.test.ts, other files unchanged). Record the exact baseline count from `npm test 2>&1 | tail -5` at the start of Phase 2 before making any edits — if the baseline is not 191, adjust the target accordingly.
- [ ] No flaky tests introduced (run `npm test` three times in a row; all three passes must show the same count and all green)
- [ ] No new test files (`ls tests/*.test.ts` unchanged)
- [ ] `mkFakeCli`, `withGiteaServer`, `runSetup` are unchanged — no extensions or modifications to existing helpers

#### Test Approach (Phase 2)

- Run `npm test` after each scenario is added, not all at once. Catch mistakes early.
- `runRemove` is in-process (mirrors `runSetup` at tests/setup.test.ts:64–76) — it does NOT spawn `dist/server.js`. Import `remove` alongside `setup` at the top of the test file.
- `mkFakeCli` returns responses by call index, not by HTTP method. Seed `responses` in call order: for a test where remove lists first then deletes, `responses[0]` is the list response and `responses[1]` is the DELETE response.
- For R4 (folds missing-state + missing-smeeUrl): write two `runRemove` calls inside the same test, one per sub-case. Both assert the same exit-code-1 and local-files-untouched pattern, with different stderr regex matches.
- For R7 (Gitea missing token), the test MUST assert `existsSync(statePath) === true` after the failure — this is the explicit "precondition check before local mutation" guarantee from the spec.
- For R9 (404 race), fake `gh` must return stderr containing `HTTP 404: Not Found` to match the existing `classifyForgeError` regex and the new soft-handling branch.
- For R10 (404-on-LIST hard fail), fake `gh` returns the same stderr but on the LIST call (responses[0]). Assert the exit code 1 and the existing `Could not find repo '...'` error message — this locks in that classifyForgeError still kicks in on LIST 404.
- For R3 (customized .mcp.json), compare `JSON.parse` round-trip, not byte equality — the installer's canonical-JSON output may differ from the seeded file's formatting. **Assertion string must be `does not match the canonical shape for --forge github`** to match the actual log line.
- For R6 (Gitea happy path), the `withGiteaServer` handler captures requests into an array the test can assert on (same pattern as Spec 7). The handler distinguishes GET vs DELETE via `req.method`.
- Environment variable isolation: R7 (and any test touching `GITEA_TOKEN`) is already handled by `inProject` which saves and restores `GITEA_TOKEN` in its finally block (tests/setup.test.ts:82–92).

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Phase 1 overshoots the 400-line cap on `lib/setup.ts` | Spec's pre-budget projects ~420 pessimistic; `parseCommandArgs` merge saves ~18 lines → ~402; tight `remove()` body saves another ~5 lines → ~397. If overage persists, compress log strings and comments. Escalate to architect if >400 after all tightening. |
| Phase 2 overshoots the 600-line cap on `tests/setup.test.ts` | Plan commits to 4 tightening strategies upfront (see Phase 2 section). If still over after all 4, escalate. |
| `classifyForgeError` signature change breaks existing `setup()` call sites | Not doing a signature change — Option B (local pre-catch in `remove()`) avoids touching `classifyForgeError`. |
| Gitea `giteaFetch` throws on 404 in list (correct) but also on 404 in delete (wrong for remove) | Bypass `giteaFetch` for the DELETE call only; use direct `fetch()` with manual status handling. `giteaFetch` signature and existing setup-path callers unchanged. |
| `server.ts` dispatch overshoots the 8-line cap | Sketch above is 5 lines, identical to current. No risk. |
| 404-race test (R9) false-positives because fake-gh stderr regex doesn't match | Use the exact same regex `/HTTP 404\|Not Found/i` in both the fake-gh stderr and the remove() detection. Write R9 last, after the happy-path tests prove the fake-gh pattern works. |
| `loadState` vs direct-readFile inconsistency trips a reviewer | Spec explicitly requires direct readFile for remove — will be highlighted in the PR body. |
| Canonical `.mcp.json` check is too strict and fails on a legitimate setup state | The canonical args are derived from the `--forge` flag passed to remove, which matches what setup wrote. Should be 100% match on any clean install. Tested by R1/R5/R6 (happy paths on each forge). |
| Two back-to-back setup runs with different `--forge` flags leave a non-canonical state | Edge case: user runs `setup --forge github` then `setup --forge gitlab` on the same project. Setup doesn't touch the `.mcp.json` ci entry if it already exists, so the second run leaves the GitHub-shape entry in place. Running `remove --forge gitlab` then fails the canonical check and logs a warning. This is correct behavior — the entry belongs to the github install, not the gitlab install. Not a bug. |
| R9 (404 race) requires the fake-gh DELETE response to fail with a specific stderr | Document the fake-gh DELETE failure mode in the test comments. Use the same stderr text the real `gh` returns (checked against `gh` docs). |

## Non-goals (Explicit, per Spec 8)

- No `lib/remove.ts`. No `lib/setup/` subdirectory. No `lib/uninstall.ts`.
- No `ForgeUninstaller` interface or strategy map.
- No dependency injection in `remove()`.
- No new CLI flags beyond `--repo`, `--forge`, `--gitea-url` (same as setup).
- No `--force` / `--dry-run` / `--keep-*` flags.
- No prompts or confirmation.
- No deletion of the `.env` file or the `.claude/channels/ci/` directory.
- No smee.io channel deletion.
- No audit log.
- No external notifications (email, Slack).
- Running outside a project directory fails fast.
- Second run without state.json fails fast with exit 1 (NOT "idempotent exit-0").

## Dependencies

- **Spec 7 must be merged**: done (commit c3f91c6 on main). This plan branches from post-Spec-7 main.
- No other dependencies.

## Expert Consultation

To be filled in by porch/consult after 3-way review.
