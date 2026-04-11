# Plan: GitLab + Gitea installer support and Codev auto-integration

## Metadata
- **ID**: plan-2026-04-11-multi-forge-installer
- **Status**: draft
- **Specification**: codev/specs/7-spec-7-feat-gitlab-gitea-insta.md
- **Created**: 2026-04-11

## Executive Summary

Extend the single-file `lib/setup.ts` installer (currently ~194 lines, GitHub-only) to support three forges (`github` default + `gitlab` + `gitea`) and a post-install Codev auto-integration step. Target final size: ≤300 lines in `lib/setup.ts`, ≤400 lines in `tests/setup.test.ts`, ≤20 tests total. No new `package.json` dependencies. No module split. No DI. No new CLI flags beyond `--forge` and `--gitea-url`.

**Per the spec's explicit rule**, docs updates (README, INSTALL, CLAUDE, AGENTS) are part of the implementation phase — not a separate "docs" phase. Tests are their own phase (same seam as Spec 5) because porch requires ≥2 phases and implementation-vs-tests is the only natural split that respects the spec's "single PR, single logical change" rule.

**Phase 1 (`impl`)**: Extend `lib/setup.ts` with GitLab and Gitea branches, the Codev helper, and the `.env` parser. Update docs + bump version. Runs existing test suite to catch regressions. Phase 1 produces no NEW tests; existing 8 setup tests + all runtime/integration tests remain the regression gate.

**Phase 2 (`tests`)**: Add ≤12 new scenarios to `tests/setup.test.ts` covering GitLab (3), Gitea (4), and Codev (3) using the PATH-override fake-CLI pattern (generalized from `mkFakeGh` → `mkFakeCli`) and a local HTTP server for Gitea. Rewrite the existing Scenario 8 "unknown flag" assertion to use `--nonsense` instead of `--forge gitlab`.

Both phases land in a single PR. The number of git commits is porch bookkeeping; if the PR reviewer prefers a single final commit, squash-merge at merge time.

## Success Metrics

Copied from `codev/specs/7-spec-7-feat-gitlab-gitea-insta.md`:

- [ ] `ci-channel setup --forge gitlab --repo group/project` installs to a fresh project in <10s (human-run smoke, not automated)
- [ ] `ci-channel setup --forge gitea --gitea-url <url> --repo owner/repo` installs to a fresh project in <10s
- [ ] `ci-channel setup --repo owner/repo` (no `--forge`) still works and defaults to GitHub — no regression
- [ ] Re-running any of the three forge flows is idempotent (PATCH/PUT the existing hook; state + .mcp.json byte-equal when nothing changed)
- [ ] Codev integration is conditional on `.codev/config.json` existence; no change when absent
- [ ] All existing tests continue to pass; baseline count recorded at the start of Phase 1 via `npm test 2>&1 | tail -5` (do NOT trust numbers in the spec)
- [ ] `wc -l lib/setup.ts` ≤ 300
- [ ] `wc -l tests/setup.test.ts` ≤ 400
- [ ] `tests/setup.test.ts` contains ≤ 20 tests total
- [ ] `lib/setup.ts` is still a single file; `lib/setup/` still does not exist
- [ ] No new runtime or dev dependencies in `package.json`
- [ ] Ships as v0.4.0

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "impl", "title": "Implementation: lib/setup.ts + docs + version bump"},
    {"id": "tests", "title": "Automated tests: tests/setup.test.ts"}
  ]
}
```

## Phase Breakdown

### Phase 1: Implementation (`lib/setup.ts` + docs + version bump)

**Dependencies**: None

#### Objective

Extend `lib/setup.ts` with:
- `--forge` and `--gitea-url` CLI flags (parsed in `parseArgs`)
- A shared error classification helper that replaces the existing `GhError` class
- A GitHub branch that preserves the existing behavior
- A new GitLab branch using `glab api` subprocess (URL-encoded project path, PUT for update)
- A new Gitea branch using global `fetch()` (Authorization token header, AbortController timeout, error classification by status code)
- A `readEnvToken` helper for reading `GITEA_TOKEN` from `<project-root>/.claude/channels/ci/.env`
- A `codevIntegrate` helper wrapped in its own try/catch that warns and continues on error
- Forge-specific input validation (step 3 in the spec's common flow) — Gitea token check happens BEFORE state provisioning

Final `lib/setup.ts` must be ≤300 lines. Also update user-facing docs (README, INSTALL, CLAUDE, AGENTS) and bump `package.json` version to `0.4.0`.

#### Files

- **Modify**: `lib/setup.ts` — extend the existing 194-line file
- **Modify**: `package.json` — version bump `0.3.1` → `0.4.0`
- **Modify**: `README.md` — add short GitLab + Gitea install examples (≤5 lines each)
- **Modify**: `INSTALL.md` — add a pointer to `--forge gitlab` / `--forge gitea` as the recommended path
- **Modify**: `CLAUDE.md` and `AGENTS.md` — update installation section to mention all three forges (keep in sync)
- **Modify**: `codev/resources/arch.md` — one-line mention that `setup` supports GitLab + Gitea

No other files touched. **Do NOT modify `server.ts`** — the dispatch is already wired.

#### Implementation Sketch

Starting point: `lib/setup.ts` is currently 194 lines with `GhError` class, `ghApi` helper, `parseArgs`, and the GitHub-only `setup()` body. The refactor plan:

**1. Imports + constants (~15 lines)**
- Add imports for `http`-free `fetch` usage (already global in Node ≥20)
- Keep existing imports from `./bootstrap.js`, `./project-root.js`, `./state.js`
- Constants: `CI_MCP_ENTRY`, `CODEV_FLAG = '--dangerously-load-development-channels server:ci'`, `VALID_FORGES = ['github', 'gitlab', 'gitea'] as const`

**2. `parseArgs` (~20 lines)**
- Loop through argv looking for `--repo`, `--forge`, `--gitea-url`
- Validate `--forge` against `VALID_FORGES`. Error message: `Invalid --forge '${value}'. Must be one of: github, gitlab, gitea (lowercase).`
- Validate `--gitea-url` is required if and only if `--forge gitea`
- Any other arg → throw `Usage: ci-channel setup --repo owner/repo [--forge github|gitlab|gitea] [--gitea-url URL] (unexpected arg: ${arg})`
- Returns `{ repo, forge, giteaUrl? }`

**3. `readEnvToken` (~17 lines)** — verbatim from spec section ".env File Handling". Handles `KEY=value`, `export KEY=value`, quoted values; returns `undefined` on any error.

**4. `cliApi` subprocess helper (~25 lines)** — generalized `ghApi`. Takes a binary name (`'gh'` or `'glab'`), argv, and optional stdin body. Returns stdout or rejects with `{ bin, code, stderr, args }` on non-zero exit / ENOENT. Replaces existing `ghApi`.

**5. Shared error classification helper (~20 lines)**
```typescript
function classifyForgeError(bin: 'gh' | 'glab', err: any, repo: string): Error {
  if (err?.code === 'ENOENT') return new Error(`${bin} CLI not found. Install and authenticate it, then retry.`)
  const stderr = String(err?.stderr ?? '')
  if (/HTTP 404|Not Found/i.test(stderr)) return new Error(`Could not find ${bin === 'glab' ? 'project' : 'repo'} '${repo}'. Check the spelling, or verify you have access (${bin} returned 404).`)
  if (/HTTP 403|Forbidden/i.test(stderr)) return new Error(`Access denied to '${repo}' hooks. ${bin === 'glab' ? "Your glab token needs project maintainer+ and the 'api' scope." : "Your gh token needs the 'admin:repo_hook' scope."} Run \`${bin} auth login\` and retry.`)
  if (/HTTP 401|Unauthorized|not logged in|authentication/i.test(stderr)) return new Error(`${bin} is not authenticated. Run \`${bin} auth login\` and retry.`)
  return err instanceof Error ? err : new Error(String(err))
}
```
- Replaces the existing `GhError.is404` / `.is403` / `.isAuth` getters
- Called from the GitHub and GitLab branches' catch blocks

**6. Common flow steps 1–2, 4–7, 9–11 (~65 lines)**
- Parse args, find project root (existing)
- Step 3: dispatch forge-specific input validation (only non-trivial for Gitea — see below)
- Load state, generate secret, fetch smee URL, conditionally write state (existing logic, unchanged)
- After forge branch: `.mcp.json` merge (existing), Codev integration (new), next-steps message
- **One `if/else if/else`** on `forge`. No strategy registry. No Map lookup.

**7. GitHub branch (~25 lines)** — shrunk from existing by:
- Removing the `GhError` class (~15 lines deleted)
- Removing the inline 404/403/auth checks (~10 lines deleted)
- Replacing with a `try { await cliApi('gh', ...) } catch (err) { throw classifyForgeError('gh', err, repo) }` wrapper
- Payload shape: unchanged (url, content_type, secret, events=['workflow_run'], active=true)
- List: `cliApi('gh', ['api', '--paginate', '--slurp', \`repos/${repo}/hooks\`])`
- Create: `cliApi('gh', ['api', '--method', 'POST', ..., '--input', '-'], payload)`
- Update: `cliApi('gh', ['api', '--method', 'PATCH', \`repos/${repo}/hooks/${id}\`, '--input', '-'], payload)`

**8. GitLab branch (~35 lines)**
```typescript
const encoded = encodeURIComponent(repo)  // encodes slashes in group/project
const listOut = await cliApi('glab', ['api', `projects/${encoded}/hooks`], null)
const hooks = JSON.parse(listOut)  // no --paginate --slurp on glab; single page
const existingHook = Array.isArray(hooks) ? hooks.find(h => h?.url === smeeUrl) : null
const payload = JSON.stringify({
  url: smeeUrl,
  token: secret,
  pipeline_events: true,
  push_events: false,
  merge_requests_events: false,
  tag_push_events: false,
  issues_events: false,
  confidential_issues_events: false,
  note_events: false,
  confidential_note_events: false,
  job_events: false,
  wiki_page_events: false,
  deployment_events: false,
  releases_events: false,
  enable_ssl_verification: true,
})
if (existingHook) {
  await cliApi('glab', ['api', '--method', 'PUT', `projects/${encoded}/hooks/${existingHook.id}`, '--input', '-'], payload)
} else {
  await cliApi('glab', ['api', '--method', 'POST', `projects/${encoded}/hooks`, '--input', '-'], payload)
}
// Wrap the above in try/catch → classifyForgeError('glab', err, repo)
```
- **Note**: PUT, not PATCH (GitLab uses PUT for hook updates; GitHub uses PATCH)
- **Note**: `h.url` at top level, not `h.config?.url` (GitLab hook shape differs from GitHub/Gitea)
- Match rule: first match wins

**9. Gitea branch (~55 lines)**
```typescript
// Step 3: token check BEFORE state provisioning
if (forge === 'gitea') {
  const envPath = join(root, '.claude', 'channels', 'ci', '.env')
  const token = (process.env.GITEA_TOKEN?.trim() || readEnvToken(envPath, 'GITEA_TOKEN')?.trim() || '')
  if (!token) {
    throw new Error(`GITEA_TOKEN not set. Generate a token at ${giteaUrl}/user/settings/applications (scopes: write:repository) and add it to ${envPath} as GITEA_TOKEN=... or export GITEA_TOKEN in your shell.`)
  }
  // store in closure for use by the Gitea branch below
}

// Step 8 (Gitea branch):
const base = giteaUrl.replace(/\/$/, '')
const url = `${base}/api/v1/repos/${repo}/hooks`
const authHdrs = { Authorization: `token ${token}` }
const jsonHdrs = { ...authHdrs, 'Content-Type': 'application/json' }
const listResp = await giteaFetch(url, { headers: authHdrs }, repo, base)
const hooks = await listResp.json()
const existingHook = Array.isArray(hooks) ? hooks.find(h => h?.config?.url === smeeUrl) : null
const createBody = JSON.stringify({ type: 'gitea', config: { url: smeeUrl, content_type: 'json', secret }, events: ['workflow_run'], active: true })
const updateBody = JSON.stringify({ config: { url: smeeUrl, content_type: 'json', secret }, events: ['workflow_run'], active: true })
if (existingHook) {
  await giteaFetch(`${url}/${existingHook.id}`, { method: 'PATCH', headers: jsonHdrs, body: updateBody }, repo, base)
} else {
  await giteaFetch(url, { method: 'POST', headers: jsonHdrs, body: createBody }, repo, base)
}
```

Plus a thin `giteaFetch(url, init, repo, base)` helper (~15 lines) that:
- Wraps `fetch` with a 10-second AbortController timeout
- On non-OK response, reads body text and throws a classified error based on `resp.status` (404/403/401/other)
- Uses string templates for the error messages directly from the spec's "Error classification" section

**10. `codevIntegrate` helper (~25 lines)**
```typescript
async function codevIntegrate(root: string): Promise<void> {
  const codevPath = join(root, '.codev', 'config.json')
  if (!existsSync(codevPath)) return
  try {
    const config = JSON.parse(readFileSync(codevPath, 'utf-8'))
    const architect = config?.shell?.architect
    if (typeof architect !== 'string' || architect.length === 0) {
      log(`.codev/config.json has no shell.architect — skipping (unexpected Codev shape)`)
      return
    }
    if (architect.includes(CODEV_FLAG)) {
      log(`.codev/config.json already loads ci channel — skipping`)
      return
    }
    config.shell.architect = `${architect} ${CODEV_FLAG}`
    writeFileSync(codevPath, JSON.stringify(config, null, 2) + '\n')
    log(`Updated .codev/config.json: architect session will now load ci channel`)
  } catch (err) {
    log(`warning: Codev integration failed: ${(err as Error).message}. Webhook install succeeded; edit .codev/config.json manually to add ${CODEV_FLAG} to shell.architect.`)
    // Deliberately swallow — webhook install already succeeded
  }
}
```
- Called at the end of the main `setup()` body, after `.mcp.json` merge
- Local try/catch; warning logged; no re-throw

**11. Docs updates (not in `lib/setup.ts`)**
- `README.md`: add a short GitLab + Gitea example right after the existing GitHub example. Keep each example ≤5 lines (a code block with the command + a one-sentence description).
- `INSTALL.md`: add a note at the top that `ci-channel setup --forge gitlab` / `--forge gitea` is the recommended install path, with a link to the detailed manual steps for advanced users.
- `CLAUDE.md` and `AGENTS.md`: update the `## Installation` (or equivalent) section to mention all three forges. Keep both files in sync per the existing note at the top of CLAUDE.md.
- `codev/resources/arch.md`: one line added under the setup section mentioning multi-forge support.
- `package.json`: `"version": "0.3.1"` → `"version": "0.4.0"`.

#### Acceptance Criteria

- [ ] `wc -l lib/setup.ts` reports ≤ 300
- [ ] `lib/setup.ts` compiles (`npm run build` succeeds)
- [ ] `grep -E 'InstallDeps|Io interface|SetupError|UserDeclinedError|ForgeInstaller' lib/setup.ts` returns nothing
- [ ] `grep -E 'readline|prompt\(|confirm\(' lib/setup.ts` returns nothing
- [ ] `ls lib/setup/` fails (directory does not exist)
- [ ] `grep '"@inquirer\|"commander\|"yargs\|"dotenv\|"@gitbeaker\|"gitea-js\|"node-fetch\|"undici\|"axios' package.json` returns nothing
- [ ] `git diff server.ts` returns nothing (server.ts unchanged)
- [ ] `package.json` version is `0.4.0`
- [ ] GitLab branch uses `PUT` for updates, not `PATCH` (grep: `'--method', 'PUT'` present)
- [ ] GitLab branch URL-encodes the repo path (grep: `encodeURIComponent(repo)` present)
- [ ] Gitea update payload does NOT include `type` field (code review)
- [ ] Gitea token is read from `process.env.GITEA_TOKEN` first, then `.env` file (code review)
- [ ] Gitea token check happens BEFORE state provisioning / smee fetch (code review)
- [ ] `.mcp.json` merge still uses `'ci' in servers` key-presence check
- [ ] `.codev/config.json` wrapped in a local try/catch that warns and continues
- [ ] `npm test` passes with the same test count as baseline (no new tests added in Phase 1; existing count recorded in commit message)
- [ ] README / INSTALL / CLAUDE / AGENTS all mention GitLab + Gitea install examples

#### Test Plan

Phase 1 adds no automated tests. The TypeScript compiler + existing test suite + existing runtime integration tests (`tests/integration-gitlab.test.ts`, `tests/integration-gitea.test.ts`) are the regression gate. The existing 8 setup tests verify the GitHub happy path still works post-refactor.

A **manual smoke run** is documented in the Phase 1 commit message if feasible — requires live `gh`/`glab`/Gitea + a disposable repo — but is NOT an acceptance criterion. Full automated coverage comes in Phase 2.

#### Rollback Strategy

Revert the Phase 1 commit. `lib/setup.ts` returns to the GitHub-only v0.3.1 state. Docs revert. `package.json` version reverts. No migrations, no schema changes, no external state to unwind. Anyone who ran `ci-channel setup --forge gitlab` or `--forge gitea` between Phase 1 landing and the revert will have a working webhook + `state.json` on the forge — but re-running `setup --repo` on GitHub would still work, and the orphan state.json is harmless (it just won't be used unless they re-run `setup --forge <the-forge>` against the reinstated feature).

#### Risks

- **Risk**: Line-budget overshoot (300-line cap). The per-section pre-budget in the spec totals ~302; real implementations tend to drift higher.
  - **Mitigation**: Check `wc -l lib/setup.ts` after each section is added. If over, compress by (a) inlining one-use log strings, (b) removing verbose comments, (c) consolidating error-classification calls. Do NOT extract to a second file. If the budget is truly infeasible, STOP and escalate to the architect — do NOT quietly raise the cap.
- **Risk**: `GhError` class removal breaks existing tests. The existing GitHub tests assert on error messages that currently route through `GhError.is404` etc.
  - **Mitigation**: Error messages should remain behaviorally identical after replacing `GhError` with `classifyForgeError`. Specifically: the 404 message still says "Could not find repo", 403 still says "admin:repo_hook scope", auth still says "gh auth login". The existing setup tests 5 (CREATE failure) doesn't inspect error classification, it only checks state-first ordering, so it's insensitive to the refactor. Still, run the full suite after the refactor and before moving to Phase 2.
- **Risk**: `glab api` doesn't support `--paginate --slurp` and GitLab has >100 hooks on some project.
  - **Mitigation**: Spec explicitly accepts this limitation (non-goal: pagination beyond first page). Document in commit message. If a user reports a missed hook, the fix is a followup spec.
- **Risk**: Node `fetch` AbortController timeout not wired correctly, causing tests to hang.
  - **Mitigation**: Use the standard pattern: `const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000); try { await fetch(url, { signal: ac.signal, ... }) } finally { clearTimeout(t) }`. Matches what `lib/forges/gitea.ts` already does for runtime API calls.
- **Risk**: Codev integration wraps a try/catch that swallows exceptions, which is a Spec 5 anti-pattern.
  - **Mitigation**: Spec 7 explicitly carves out this single exception and documents the rationale ("webhook is already live"). The `catch` block logs a warning via `log()` so the user sees what went wrong, and tells them exactly how to fix it manually. This is user-centered error handling, not silent failure.
- **Risk**: Docs drift — CLAUDE.md and AGENTS.md need to stay in sync per the existing note.
  - **Mitigation**: Update both in the same commit, diff them after update, confirm installation sections match.

---

### Phase 2: Automated tests (`tests/setup.test.ts`)

**Dependencies**: Phase 1 (committed)

#### Objective

Add ≤12 new scenarios to `tests/setup.test.ts` covering GitLab (3), Gitea (4), and Codev (3). Modify the existing Scenario 8 to use a truly-unknown flag instead of `--forge gitlab`. Final file ≤400 lines, ≤20 tests total.

#### Files

- **Modify**: `tests/setup.test.ts` — extend the existing 198-line file

No other files touched. In particular, no `lib/setup.ts` modifications "for testability."

#### Helper generalizations

1. **`mkFakeGh` → `mkFakeCli`** (parameterized by binary name). Current helper writes `gh` + `gh.out.N`, `gh.err.N`, `gh.exit.N`, `gh.counter`, `gh.args.N`, `gh.stdin.N`. Generalize to take a `name` parameter (e.g., `'gh'` or `'glab'`) and use it as the file name prefix. Also update `ghArgs` and `ghStdin` helpers similarly.
2. **`inProject`** unchanged — still mkdtemps, creates `.git/`, prepends `bin` to PATH.
3. **`runSetup`** unchanged — still captures stderr, intercepts `process.exit`.
4. **`seedState`** unchanged.
5. **New**: `withGiteaServer(handler, fn)` — starts a local `http.createServer` on an ephemeral port, passes `http://127.0.0.1:PORT` to `fn`, tears down on finally. ~12 lines.

   ```typescript
   async function withGiteaServer(
     handler: (req: IncomingMessage, res: ServerResponse, reqs: any[]) => void,
     fn: (url: string, reqs: any[]) => Promise<void>,
   ): Promise<void> {
     const reqs: any[] = []
     const server = http.createServer((req, res) => {
       let body = ''
       req.on('data', c => body += c)
       req.on('end', () => { reqs.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, reqs) })
     })
     await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
     const addr = server.address() as AddressInfo
     try { await fn(`http://127.0.0.1:${addr.port}`, reqs) }
     finally { await new Promise<void>(r => server.close(() => r())) }
   }
   ```

#### Scenario List (verbatim from spec, final numbering)

**Pre-existing scenarios**:
- 1. Fresh install with prepopulated state (GitHub, POST + `.mcp.json` created) — unchanged
- 2. Idempotent re-run (GitHub, PATCH once) — unchanged
- 3. State present, webhook missing (GitHub, CREATE with existing secret) — unchanged
- 4. `.mcp.json` with other servers (GitHub) — unchanged
- 5. CREATE failure → state written before POST (GitHub, state-first ordering) — unchanged
- 6. Project root from subdirectory (GitHub) — unchanged
- 7. No project root → exit 1 — unchanged
- 8. Missing `--repo` OR unknown flag → exit 1 — **MODIFIED**. Second half of the test (`['--repo', 'foo/bar', '--forge', 'gitlab']`) is replaced with `['--repo', 'foo/bar', '--nonsense']` to preserve the "unknown flag" assertion without conflicting with Spec 7's valid `--forge gitlab` input.

**New scenarios**:

9. **GitLab happy path**: seed state.json (webhookSecret + smeeUrl), no `.mcp.json`, fake `glab` returns `[]` on list and `{}` on POST. Run `setup(['--repo', 'group/project', '--forge', 'gitlab'])`. Assert:
   - `glab api projects/group%2Fproject/hooks` called for list
   - `glab api --method POST projects/group%2Fproject/hooks --input -` called for create
   - POST body contains `url: smeeUrl`, `token: webhookSecret`, `pipeline_events: true`, `push_events: false`, `enable_ssl_verification: true`
   - state.json byte-equal to seed
   - `.mcp.json` created with canonical `ci` entry

10. **GitLab idempotent re-run**: seed state.json, seed `.mcp.json` with canonical `ci` entry, fake `glab` list returns `[{ id: 77, url: smeeUrl }]`, PUT succeeds. Run `setup(['--repo', 'group/project', '--forge', 'gitlab'])`. Assert:
    - `glab api --method PUT projects/group%2Fproject/hooks/77 --input -` called exactly once
    - Update payload is the canonical GitLab shape
    - state.json byte-equal
    - `.mcp.json` byte-equal

11. **GitLab subgroup path encoding**: seed state, fake `glab` list returns `[]`, POST succeeds. Run `setup(['--repo', 'group/subgroup/project', '--forge', 'gitlab'])`. Assert:
    - `glab api` path is `projects/group%2Fsubgroup%2Fproject/hooks`
    - `decodeURIComponent` of the path segment round-trips to `group/subgroup/project`

12. **Gitea happy path**: seed state.json, write `GITEA_TOKEN=fake-token\n` to `<root>/.claude/channels/ci/.env`, start local HTTP server that returns `[]` on GET + `{}` on POST. Run `setup(['--repo', 'owner/repo', '--forge', 'gitea', '--gitea-url', 'http://127.0.0.1:PORT'])`. Assert:
    - POST received at `/api/v1/repos/owner/repo/hooks`
    - POST body is `{ type: 'gitea', config: { url, content_type, secret }, events: ['workflow_run'], active: true }`
    - `Authorization: token fake-token` header present on both GET and POST
    - POST request has `Content-Type: application/json`; GET request does NOT
    - state.json byte-equal
    - `.mcp.json` has canonical `ci` entry

13. **Gitea idempotent re-run (update payload excludes `type`)**: seed state.json + `.env` token, server returns `[{ id: 99, config: { url: smeeUrl } }]` on GET + `{}` on PATCH. Run setup. Assert:
    - PATCH received at `/api/v1/repos/owner/repo/hooks/99`
    - PATCH body does NOT contain a `type` field (it's only valid on create)
    - PATCH body contains `config`, `events`, `active`
    - state.json + `.mcp.json` byte-equal

14. **Gitea missing token (token check ordering)**: do NOT seed state.json, do NOT create `.env`, unset `process.env.GITEA_TOKEN`. Start a server that would fail the test if reached. Run setup. Assert:
    - `process.exit(1)` called
    - stderr contains `GITEA_TOKEN not set`
    - Server's `reqs` array is empty (no HTTP request made)
    - `state.json` does NOT exist on disk at the expected path
    - (Optionally, run a back-to-back `GITEA_TOKEN=` empty-string case and assert same behavior)

15. **Gitea 401 → state still written (state-first ordering)**: seed `.env` token but NOT state.json, server returns 401 on GET. Run setup. Assert:
    - `process.exit(1)` called; stderr contains `GITEA_TOKEN is invalid or expired`
    - state.json now exists on disk with a fresh secret + smeeUrl (seeded by smee) — **but wait**: this test requires the real `fetchSmeeChannel`, which hits the network. Revise: seed state.json with only `smeeUrl` (no secret). Then run setup — installer computes a fresh secret, writes state, hits GET, server returns 401. Assert state.json has smeeUrl + a non-empty secret (the write happened before the API call). Mirrors Scenario 5 structure.

16. **Codev config gets the flag**: seed `<root>/.codev/config.json` with `{ shell: { architect: 'claude --dangerously-skip-permissions' } }`, run the GitHub happy path. Assert:
    - after setup, `config.shell.architect === 'claude --dangerously-skip-permissions --dangerously-load-development-channels server:ci'`
    - other keys unchanged
    - stderr contains `Updated .codev/config.json`

17. **Codev config already has the flag**: seed `.codev/config.json` with the flag already in `shell.architect`. Run setup. Assert:
    - file contents byte-equal after setup
    - stderr contains `already loads ci channel`

18. **No `.codev/` directory**: do not create `.codev/`. Run setup. Assert:
    - setup succeeds (exit code null / 0)
    - `.codev/` still does not exist
    - stderr does NOT contain any `Codev` / `.codev` log line

Total: 18 tests (7 unchanged + 1 modified + 10 new). Well under the 20 cap, leaving 2 slots of headroom for future small extensions without a spec revision.

#### Test implementation constraints

- Use `node:test` — same as existing `tests/setup.test.ts`
- Skip GitHub + GitLab scenarios (9–11) on win32 (PATH-override shell script won't run)
- Gitea HTTP-server scenarios (12–15) can run on win32 in principle, but skip for consistency if it saves complexity
- Codev scenarios (16–18) run on all platforms since they don't require fake CLIs — they reuse the existing GitHub fake-gh scenarios' fake-`gh` setup
- State.json seeding via `seedState` as-is
- `fetchSmeeChannel` is still never called (all tests prepopulate state.json, except Scenario 15 which seeds `smeeUrl` only and expects the installer to compute a fresh secret — same pattern as existing Scenario 5)

#### Acceptance Criteria

- [ ] `wc -l tests/setup.test.ts` reports ≤ 400
- [ ] `grep -cE '^ *(test|it)\(' tests/setup.test.ts` reports ≤ 20 (target: 18)
- [ ] `npm test` passes with baseline + 10 new tests (platform-skipped count as skipped, not failed)
- [ ] No files under `lib/setup/`
- [ ] No changes to `lib/setup.ts` relative to Phase 1
- [ ] On unix CI, scenarios 9–15 run (not skipped); on win32 CI, scenarios 9–15 are skipped
- [ ] Scenario 8 uses `--nonsense` (or equivalent) instead of `--forge gitlab`

#### Test Plan

Phase 2 IS the test plan. Meta-validation:

- Run `node --import tsx/esm --test tests/setup.test.ts` to verify the new file runs in isolation
- Run `npm test` to verify no regressions in the existing suite
- On failure, read captured stdout/stderr and gh.log / glab.log / Gitea server reqs from the temp dir

#### Rollback Strategy

Revert the Phase 2 commit. `tests/setup.test.ts` returns to the 198-line, 8-test state. Phase 1's `lib/setup.ts` remains functional but untested for the new forges.

#### Risks

- **Risk**: 400-line budget overshoot. 10 new scenarios + helpers + Gitea HTTP server is tight.
  - **Mitigation**: Generalize `mkFakeGh` → `mkFakeCli` (saves ~20 lines vs. two copies). Write compact scenario bodies (~15–20 lines each). Use the existing `inProject` / `runSetup` / `seedState` helpers without duplication. If still over cap, compress Codev scenarios (16–18) — they can be ~10 lines each.
- **Risk**: Local HTTP server port conflicts or teardown races in CI.
  - **Mitigation**: Use `listen(0)` for ephemeral ports. Always tear down in `finally`. Tests are sequential via node:test (no parallel tests). If CI still flakes, add a diagnostic log of the server's address and the reqs array on failure.
- **Risk**: `process.exit` interception leaks between tests if a Gitea HTTP server hang.
  - **Mitigation**: `runSetup` already intercepts `process.exit` via try/finally. Add the AbortController timeout check in Phase 1's `giteaFetch` helper to ensure no fetch hangs beyond 10s. Tests that expect failure should trigger the error path quickly (401/404 responses are sync on the server side).
- **Risk**: Fake `glab` + real `gh` on the same test run means PATH must route both correctly.
  - **Mitigation**: Both fake binaries live in the same `<root>/_bin/` directory. PATH prepends `_bin`. Tests that use only `glab` create only the `glab` script; `gh` is absent (no ENOENT because real `gh` on the system PATH still works, but if we want to prevent accidental real `gh` calls, write a `gh` script that exits non-zero with a diagnostic — belt and suspenders).

---

## Dependency Map

```
Phase 1 (impl) ──→ Phase 2 (tests)
```

Phase 2 strictly depends on Phase 1 because the tests import `setup` from `../lib/setup.js`.

## Validation Checkpoints

1. **After Phase 1**: `npm run build` passes; `wc -l lib/setup.ts` ≤ 300; all existing setup tests + runtime tests still green; `git diff server.ts` returns nothing; `package.json` is 0.4.0; docs updated in README, INSTALL, CLAUDE, AGENTS.
2. **After Phase 2**: `npm test` passes with ≤20 setup tests; `wc -l tests/setup.test.ts` ≤ 400; baseline test count + 10 new = final count; Scenario 8 uses `--nonsense`.
3. **Before PR merge**: Reviewer runs the full spec review-gate checklist.

## Integration Points

- **External**: `gh` CLI ≥ 2.29 (user-provided) — GitHub branch
- **External**: `glab` CLI ≥ 1.30 (user-provided) — GitLab branch
- **External**: `smee.io` — `fetchSmeeChannel` reaches `https://smee.io/new` on first-run installs (unchanged)
- **External**: Gitea instance at `--gitea-url` — Gitea branch uses `fetch`
- **Internal**: reuses `findProjectRoot` (`lib/project-root.ts`), `loadState` (`lib/state.ts`), `fetchSmeeChannel` (`lib/bootstrap.ts`). No changes to these modules.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Line budget overshoot on `lib/setup.ts` (≤300) | Medium | High (spec violation → REQUEST_CHANGES) | Pre-budget in spec, check `wc -l` after each section, compress not extract |
| Line budget overshoot on `tests/setup.test.ts` (≤400) | Medium | Medium | `mkFakeCli` generalization, compact scenarios, share helpers |
| Removing `GhError` breaks existing GitHub setup tests | Medium | Medium | Keep error messages identical; run full suite after Phase 1 refactor |
| GitLab PUT vs PATCH confusion | Medium | Medium | Spec checklist has a dedicated item; plan sketches PUT explicitly |
| Gitea update payload includes `type` field | Medium | Medium | Spec shows two separate payload shapes; plan sketches both; test 13 asserts absence |
| Codev JSON.parse failure during test seeding | Low | Low | Tests control the input; use `JSON.stringify` to seed, never manual strings |
| Docs drift between CLAUDE.md and AGENTS.md | Low | Low | Both files updated in the same commit; diff them after |
| 300-line cap turns out to be infeasible | Low | Very High (plan blocker) | Escalate to architect; do NOT quietly raise the cap |

## What This Plan Does NOT Include

- No separate helpers module (`lib/setup-gitlab.ts`, `lib/setup-gitea.ts`, etc.)
- No new interface files (`lib/types.ts`, `lib/forge-installer.ts`)
- No refactor of `lib/bootstrap.ts`, `lib/state.ts`, `lib/project-root.ts`, or `lib/config.ts`
- No changes to `server.ts` (dispatch is unchanged from Spec 5)
- No changes to runtime forge plugins (`lib/forges/github.ts`, `gitlab.ts`, `gitea.ts`)
- No changes to runtime webhook handler / reconciler
- No changes to `tsconfig.json`
- No CI workflow changes
- No new `package.json` dependencies
- No version bump beyond `0.3.1` → `0.4.0`
- No separate "docs" phase — docs updates are in Phase 1 alongside the code
- No interactive prompts, no `--yes`, no `--dry-run`, no `--rotate`, no `--gitlab-url`
- No webhook rotation, no multiple webhooks per project, no org-level hooks, no telemetry

## Expert Review

_(To be filled after the plan-iter1 consultation completes.)_

## Notes

- The 300-line cap on `lib/setup.ts` is the MAXIMUM, not a target. If the impl lands at 280, that is better than 299.
- If Phase 1 discovers the cap is genuinely infeasible (e.g., after all reasonable compression), STOP, write a blocker message, and notify the architect. Do NOT smuggle in abstraction layers or extract helpers to a second file.
- `codev/resources/lessons-learned.md` entry "Prefer single-file implementations + real-fs tests for install/bootstrap commands" is the authoritative post-mortem from Spec 3. Re-read before Phase 1 if in doubt about any trade-off.
- The spec's per-section line-count pre-budget is guidance, not a second cap axis. A reviewer who rejects the PR because "the Gitea section is 58 lines, not the projected 55" is being pedantic — the only hard cap is `wc -l ≤ 300`.
