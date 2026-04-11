# Plan: `ci-channel remove` command

## Metadata
- **ID**: plan-2026-04-11-ci-channel-remove
- **Status**: draft
- **Specification**: codev/specs/8-spec-8-feat-ci-channel-remove-.md
- **Created**: 2026-04-11

## Executive Summary

Add a `ci-channel remove` subcommand to the single-file `lib/setup.ts` installer, next to `setup()`. Remove undoes what setup did — deletes the forge webhook, deletes `state.json`, strips the canonical `ci` entry from `.mcp.json`, and reverts the Codev integration if present. All three forges (GitHub, GitLab, Gitea) are supported with the same flag shape as `setup`.

**Per the spec's explicit rule**, code, tests, and docs updates (README, INSTALL, CLAUDE, AGENTS) land in two porch phases but a single PR. The phase split mirrors Spec 7: `impl` (implementation + docs + version bump) and `tests` (new remove test scenarios). Porch requires ≥2 phases.

**Phase 1 (`impl`)**: Extend `lib/setup.ts` with a `remove()` function, the `codevRevert` helper, a merged `parseCommandArgs` (replacing the duplicated parseArgs path), and the 404-on-DELETE soft-handling logic. Update `server.ts` dispatch to recognize `remove`. Bump version to 0.5.0. Also update user-facing docs. Runs the existing test suite to catch regressions. **No new test scenarios in Phase 1.**

**Phase 2 (`tests`)**: Add 9 mandatory scenarios (R1–R9) to `tests/setup.test.ts` covering GitHub (3 + 1 race), GitLab (1), Gitea (2), Codev (1), and the precondition fail-fast case (1). The fake `gh`/`glab` CLI helper is extended to recognize `DELETE` responses. The Gitea HTTP server helper is extended to handle `DELETE`. Target: 9 mandatory tests; R10 is stretch.

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
- A merged `parseCommandArgs(argv, command)` function that replaces the existing `parseArgs` (saves ~10–12 lines vs. duplicating a `parseRemoveArgs`)
- A `remove()` exported function with three forge branches (GitHub, GitLab, Gitea) sharing helpers with `setup()`
- A `codevRevert` helper that strips the loader flag from `.codev/config.json`
- A local try/catch-based approach to 404-on-DELETE soft handling (Option B from the spec — no change to `classifyForgeError` signature)
- Direct `readFileSync` + `JSON.parse` precondition check for `state.json` (do NOT use `loadState`, which swallows errors)

Extend `server.ts` dispatch to recognize both `setup` and `remove`. Dynamic import of `lib/setup.js` must still only happen when the user invoked a subcommand.

Final `lib/setup.ts` must be ≤400 lines. Update user-facing docs (README, INSTALL, CLAUDE, AGENTS) and bump `package.json` + `package-lock.json` version to `0.5.0`.

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

**2. `codevRevert` helper (~25 lines)**

```typescript
function codevRevert(root: string): void {
  const codevPath = join(root, '.codev', 'config.json')
  if (!existsSync(codevPath)) return
  try {
    // biome-ignore lint/suspicious/noExplicitAny: user-owned JSON
    const config: any = JSON.parse(readFileSync(codevPath, 'utf-8'))
    const architect = config?.shell?.architect
    if (typeof architect !== 'string' || architect.length === 0) {
      log(`.codev/config.json has no shell.architect — skipping (unexpected Codev shape)`)
      return
    }
    const needle = ` ${CODEV_FLAG}`
    if (!architect.includes(needle)) {
      log(`.codev/config.json does not load ci channel — nothing to revert`)
      return
    }
    config.shell.architect = architect.replace(needle, '')
    writeFileSync(codevPath, JSON.stringify(config, null, 2) + '\n')
    log(`Reverted .codev/config.json: architect session will no longer load ci channel`)
  } catch (err) {
    log(`warning: Codev revert failed: ${(err as Error).message}. Other cleanup succeeded; edit .codev/config.json manually to remove ${CODEV_FLAG} from shell.architect.`)
  }
}
```

Mirror of `codevIntegrate` with three changes:
- `includes(needle)` checks for ` ${CODEV_FLAG}` (with leading space), matching the exact string that `codevIntegrate` wrote. This automatically handles the edge case where the flag is at the start of the string (no leading space → no match → log "nothing to revert").
- `replace(needle, '')` strips the flag and its single leading space (no whitespace collapse elsewhere).
- Log lines say "Reverted" / "nothing to revert" / "does not load ci channel" per the spec.

**3. `remove()` body (~90 lines — tight, but fits with the parseCommandArgs merge savings)**

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

**Important refinement on error classification** (addresses a subtle bug in the sketch above): the outer try/catch structure for the GitHub branch is awkward because `classifyForgeError` would be called on both list errors AND the re-raised delete errors. Cleaner structure:

```typescript
// Clean pattern — two nested try/catch blocks
if (forge === 'github') {
  let hooks: unknown[]
  try {
    const listOut = await cliApi('gh', ['api', '--paginate', '--slurp', `repos/${repo}/hooks`], null)
    const pages = JSON.parse(listOut)
    hooks = Array.isArray(pages) ? pages.flat() : []
  } catch (err) {
    throw classifyForgeError('gh', err, repo)
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
  const existingHook = hooks.find((h: any) => h?.config?.url === smeeUrl)
  if (!existingHook) {
    log(`no matching webhook found on github; skipping webhook delete`)
  } else {
    log(`Found webhook ${(existingHook as any).id} on ${repo} — deleting...`)
    try {
      await cliApi('gh', ['api', '--method', 'DELETE', `repos/${repo}/hooks/${(existingHook as any).id}`], null)
      log(`Deleted webhook ${(existingHook as any).id}`)
    } catch (delErr) {
      // biome-ignore lint/suspicious/noExplicitAny: err is opaque
      const stderr = String((delErr as any)?.stderr ?? '')
      if (/HTTP 404|Not Found/i.test(stderr)) {
        log(`webhook ${(existingHook as any).id} already deleted on github; continuing`)
      } else {
        throw classifyForgeError('gh', delErr, repo)
      }
    }
  }
}
```

Two nested try/catch blocks: one for list (catches all list errors), one for delete (soft-handles 404, hard-fails on everything else). Cleaner than a single outer try. **Plan phase commitment**: use the two-block pattern.

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

- [ ] `wc -l lib/setup.ts` reports ≤ 400
- [ ] `wc -l server.ts` reports within [current - 0, current + 3] (dispatch extension only, no other changes)
- [ ] `lib/setup.ts` compiles (`npm run build` succeeds)
- [ ] `grep -E 'lib/remove\.ts|lib/setup/|ForgeUninstaller|FORGE_UNINSTALLERS' lib/` returns nothing
- [ ] `grep -c '^function ' lib/setup.ts` is exactly one more than the current count (the new `codevRevert`)
- [ ] `grep -c '^export async function ' lib/setup.ts` is 2 (setup + remove)
- [ ] `lib/setup.ts` calls `loadState` only from inside `setup()`, never from `remove()` — verified by inspection (the spec requires direct `readFileSync` + `JSON.parse` for the precondition check)
- [ ] `npm test` passes with the baseline 18 tests unchanged (no new test scenarios, no modified assertions, Phase 1 produces zero test diff beyond what might be incidentally touched by running the suite)
- [ ] `server.ts` dispatch is ≤ 8 lines and still uses `await import('./lib/setup.js')` dynamically
- [ ] `package.json` version is `0.5.0`
- [ ] `package-lock.json` version is `0.5.0` in both places
- [ ] README / INSTALL / CLAUDE / AGENTS mention `ci-channel remove`

#### Test Approach (Phase 1)

- Phase 1 runs the **existing** 18 tests as a regression gate. **No new scenarios, no modified assertions.**
- If `npm test` shows anything other than `tests 18`/`pass 18`, Phase 1 is blocked until fixed.
- Manual smoke test (not automated): `node dist/server.js remove --repo owner/repo` in a non-project directory should print `No project root found ...`. This is informational, not a Phase 1 gate.

---

### Phase 2: Automated tests (`tests/setup.test.ts`)

**Dependencies**: Phase 1

#### Objective

Add **9 mandatory scenarios** (R1–R9) to `tests/setup.test.ts` covering the remove command paths. Extend the existing fake-CLI and HTTP-server helpers to handle `DELETE` responses.

Final `tests/setup.test.ts` must be ≤600 lines and contain ≤28 tests total. Target: 9 new tests, 27 total (18 existing + 9 new).

#### Files

- **Modify**: `tests/setup.test.ts` — add 9 new scenarios + a small `runRemove` helper + extend fake-CLI response handling for DELETE + extend the Gitea server helper for DELETE

No other files touched. **No new test files** (e.g., no `tests/remove.test.ts`).

#### Implementation Sketch

**Helper extensions (~20 lines total)**

1. **`runRemove(argv, env)` helper** (~5 lines) — mirror of the existing `runSetup`, calls the `dist/server.js` binary with `remove` as the first arg. Alternatively, reuse `runSetup` with a `command: 'setup' | 'remove'` parameter. Plan phase picks whichever fits tighter — probably the two helpers share ~80% of their body so a `runCli(command, argv, env)` variant saves ~5 lines.

2. **Extend `mkFakeCli` (or equivalent)** to recognize `DELETE` in the response map. Current (Spec 7) fake CLI probably has a `POST`/`PATCH`/`PUT`/`GET` branch structure; add a `DELETE` branch that returns the configured response (or exits 1 with a configurable stderr for the 404 race test). ~5 lines.

3. **Extend `withGiteaServer`** to handle `DELETE` requests. The existing handler is a `(req, res) => void` function; the new test fixtures just register `req.method === 'DELETE'` paths. No helper change needed if the handler is already general-purpose. If it isn't, ~5 lines to generalize.

**Scenarios R1–R9 (details from spec; implementation notes here)**

| ID | Lines | Notes |
|----|-------|-------|
| R1 | ~30 | GitHub happy path. Use nested-array list response `[[{id:42, config:{url:smeeUrl}}]]` to match `--paginate --slurp` shape. Fake DELETE returns `{}`. |
| R2 | ~20 | GitHub no matching webhook. List returns `[[]]`. No DELETE recorded. |
| R3 | ~25 | GitHub customized .mcp.json. Seed ci entry with extra `env` key, assert it's untouched after remove. Webhook still deleted. |
| R4 | ~15 | No state.json. Fail fast, exit 1. No fake-gh call. |
| R5 | ~25 | GitLab happy path. Fake glab with list + DELETE responses. Assert path encoding `group%2Fproject`. |
| R6 | ~30 | Gitea happy path. HTTP server with GET + DELETE handlers. Assert `Authorization: token fake-token` and DELETE path. |
| R7 | ~20 | Gitea missing token. Assert state.json still exists, no HTTP request received. |
| R8 | ~25 | Codev revert. Seed config.json with loader flag, assert it's stripped after. |
| R9 | ~25 | 404-during-DELETE race. Fake gh DELETE returns exit 1 with `HTTP 404: Not Found` in stderr. Assert "already deleted" log and exit 0. |

Total new test body: ~215 lines. Plus helper extensions ~20 lines, helpers shared with existing tests ~0 overhead. **Estimated final file size**: 399 (current) + 20 (helpers) + 215 (scenarios) = **~634 lines**.

**Over the 600-line cap by ~34 lines.** Tightening options for Phase 2:
1. Share the `runSetup`/`runRemove` helpers (save ~10 lines).
2. Extract per-scenario state.json seeding into a helper (`seedState(tmp, overrides)`) (save ~10 lines).
3. Extract per-scenario canonical .mcp.json seeding (`seedMcp(tmp, forge)`) (save ~10 lines).
4. Collapse R4 into a one-liner assertion inside R1's setup (save ~5 lines).
5. Drop R3 "extra keys" variant to just "changed command" (save ~5 lines).

Applying (1) + (2) + (3) lands at ~604 lines. Plus (4) = ~599 lines. **Plan phase commitment**: apply tightening options 1, 2, 3, and 4. If the final file is still over 600, drop R10 (which is optional and not counted in this estimate anyway — R10 was already excluded above).

If after all tightening the file is still over 600, the Phase 2 acceptance check fails and the builder must escalate to the architect. **Do NOT silently raise the cap.**

#### Acceptance Criteria

- [ ] `wc -l tests/setup.test.ts` reports ≤ 600
- [ ] Test count: `grep -cE "^  (it|test)\\(" tests/setup.test.ts` or whatever the existing pattern is, reports ≤ 28 (target: 27)
- [ ] All 9 mandatory scenarios R1–R9 are present (identified by a comment or test name matching `/remove.*[Rr]emove/` etc.)
- [ ] `npm test` passes with 27 tests (18 existing + 9 new)
- [ ] No flaky tests introduced (run `npm test` three times in a row; all three passes must show the same count and all green)
- [ ] No new test files (`ls tests/*.test.ts` still returns only `setup.test.ts` and whatever existed before)

#### Test Approach (Phase 2)

- Run `npm test` after each scenario is added, not all at once. Catch mistakes early.
- For R7 (Gitea missing token), the test MUST assert `existsSync(statePath) === true` after the failure — this is the explicit "precondition check before local mutation" guarantee from the spec.
- For R9 (404 race), fake `gh` must return stderr containing `HTTP 404: Not Found` to match the existing `classifyForgeError` regex and the new soft-handling branch.
- For R3 (customized .mcp.json), compare `JSON.parse` round-trip, not byte equality — the installer's canonical-JSON output may differ from the seeded file's formatting.
- For R6 (Gitea happy path), the fake HTTP server handler should log all received requests into an array the test can assert on. Same pattern as Spec 7's `withGiteaServer` scenarios.
- Environment variable isolation: R7 (and any test touching `GITEA_TOKEN`) must save and restore the original value in a `finally`.

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
