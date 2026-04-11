# Specification: GitLab + Gitea installer support and Codev auto-integration

## Metadata
- **ID**: spec-2026-04-11-multi-forge-installer
- **Status**: draft
- **Created**: 2026-04-11
- **Issue**: cluesmith/ci-channel#7
- **Protocol**: ASPIR (autonomous, no human gates on spec/plan)
- **Builds on**: Spec 5 (simpler installer) — follow the same single-file, no-DI discipline

## Context — Where We Are Coming From

v0.3.0 shipped `ci-channel setup --repo owner/repo` as a 150-line, GitHub-only installer (Spec 5). The runtime plugin already speaks all three forges (GitHub Actions / GitLab CI / Gitea Actions) — the gap is purely in the installer:

- GitLab and Gitea users still have to follow the manual `INSTALL.md` flow (generate a secret by hand, fetch a smee URL by hand, edit `.env`, create the webhook in the forge UI, merge `.mcp.json` by hand)
- Codev projects have to manually add `--dangerously-load-development-channels server:ci` to their architect command after running setup — they get the channel installed but not loaded

This spec fills both gaps in one go.

**Explicit carry-over from Spec 5**: every constraint from Spec 5 that is not loosened below still applies. The line caps are raised, not the quality bar. "No DI, no interactive prompts, no new dependencies, no 'skip if already correct' fast paths, always-PATCH, state-first ordering" all remain non-negotiable.

## Problem Statement

1. The `ci-channel setup` installer only works for GitHub. GitLab and Gitea users can install `ci-channel` via `npx`, but then have to do the five-step manual dance to actually register a webhook.
2. Users who develop inside a Codev project expect "install the channel" to mean "the architect session can see it." Today they get the channel binary registered in `.mcp.json` but not the loader flag on the Codev architect command, so the channel is invisible to Codev's managed sessions.

That's the entire problem. Everything else is a non-goal (see "Non-Goals" below).

## Desired State

**GitLab**:
```bash
ci-channel setup --forge gitlab --repo group/project
```

**Gitea**:
```bash
ci-channel setup --forge gitea --gitea-url https://gitea.example.com --repo owner/repo
```

Both run in under 10 seconds on a fresh project, are idempotent on re-run, and produce the same end state as the existing GitHub path (state.json + .mcp.json + a webhook on the remote forge). GitHub remains the default when `--forge` is omitted.

Additionally, after the core install finishes, if `<project-root>/.codev/config.json` exists:
- If its `shell.architect` command already contains `--dangerously-load-development-channels server:ci`, log and skip
- Otherwise append that flag to the architect command (preserving every other flag) and write the file back

If `.codev/config.json` does not exist, do nothing. Codev is optional.

## Success Criteria

- [ ] `ci-channel setup --forge gitlab --repo group/project` installs to a fresh project in <10s (human-run smoke, not automated)
- [ ] `ci-channel setup --forge gitea --gitea-url <url> --repo owner/repo` installs to a fresh project in <10s
- [ ] `ci-channel setup --repo owner/repo` (no `--forge`) still works and defaults to GitHub — **no regression**
- [ ] Re-running any of the three forge flows is idempotent (PATCH the existing hook, leave state + .mcp.json byte-equal when nothing changed)
- [ ] Codev integration is conditional on `.codev/config.json` existence; no change when absent
- [ ] All existing tests continue to pass (baseline recorded in the impl phase commit message)
- [ ] `wc -l lib/setup.ts` ≤ 300
- [ ] `wc -l tests/setup.test.ts` ≤ 400
- [ ] `tests/setup.test.ts` contains ≤ 20 tests total (8 pre-existing + ≤12 new)
- [ ] `lib/setup.ts` is still a **single file**; `lib/setup/` still does not exist
- [ ] No new runtime or dev dependencies in `package.json`
- [ ] Ships as **v0.4.0** (minor bump: two new forges + Codev integration)

## HARD CONSTRAINTS (MAX, not suggestions)

### Size caps (loosened from Spec 5)

| File | Spec 5 cap | Spec 7 cap | Rationale |
|------|-----------|-----------|-----------|
| `lib/setup.ts` | 150 lines | **300 lines** | Doubling allows a gitlab + gitea branch + codev helper without splitting |
| `tests/setup.test.ts` | 200 lines | **400 lines** | Doubling allows ~12 new scenarios using the same helper pattern |
| Tests | 8 max | **20 max** | 8 existing + ~12 new |
| `server.ts` dispatch | 5 lines | **5 lines** (unchanged) | Dispatch is already written; not touching it |

**All other Spec 5 caps are unchanged.** A 301-line `lib/setup.ts` is a REQUEST_CHANGES. A 401-line `tests/setup.test.ts` is a REQUEST_CHANGES. 21 tests is a REQUEST_CHANGES.

### Single file, no module split

- **No `lib/setup/` subdirectory.** No `lib/setup-gitlab.ts`, `lib/setup-gitea.ts`, `lib/setup-codev.ts`, `lib/setup/forges.ts`, `lib/setup/http.ts`, etc.
- **No helpers module** extracted "for testability." Put helpers at the top of `lib/setup.ts` if you need them.
- **No generic "forge installer" abstraction.** No `ForgeInstaller` interface, no `FORGE_INSTALLERS` registry map, no strategy-pattern lookup. Use a plain `if/else` chain on `forge`. Three forges. An `if/else if/else` is fine. A Map of strategies is a REQUEST_CHANGES.
- **No dependency injection.** No `InstallDeps`, no `Io`, no "for testability" function arguments. Tests use real temp dirs and the PATH-override / fake-HTTP-server patterns below.

### CLI surface (this is the WHOLE added CLI surface)

```
ci-channel setup --forge github --repo owner/repo            # (default, unchanged)
ci-channel setup --forge gitlab --repo group/project
ci-channel setup --forge gitea --gitea-url URL --repo owner/repo
```

- **Added flags**: `--forge`, `--gitea-url`. That is all.
- **No `--yes`, `--dry-run`, `--rotate`, `--glab-host`, `--ssl-verify`, `--gitlab-url`, `--gitea-token` flag, `--secret`, or anything else.** The existing "no interactive prompts, no confirmations" rule still holds.
- `--forge` must accept exactly `github`, `gitlab`, `gitea` (lowercase). Any other value: fail fast with a usage message listing the three valid values.
- `--gitea-url` is **required when and only when** `--forge gitea`. Missing → fail fast with a clear message. Provided without `--forge gitea` → fail fast (don't silently ignore).
- `--repo` continues to be required for all three forges.

### No new dependencies

The full set of allowed dependencies is still "whatever is already in `package.json`." **Do not add**:
- `@gitbeaker/*` or any GitLab SDK
- `gitea-js` or any Gitea SDK
- `node-fetch`, `undici`, `axios` (Node 18+ has global `fetch`)
- `dotenv` (env parsing is already available via `lib/config.ts`, but you don't need it for setup)
- `yaml`, `commander`, `yargs`, `chalk`, `ora`, `@inquirer/prompts`

Use Node built-ins (`node:child_process`, `node:fs`, `node:crypto`, `node:path`, global `fetch`). If you need a helper that already exists in `lib/` (e.g., `loadState`, `findProjectRoot`, `fetchSmeeChannel`), import it — do not re-implement it.

### Always-PATCH rule (carries over)

If a matching webhook exists at the expected smee URL, **always update it** with the canonical payload. Do not implement any "skip if already correct" optimization. This applies to GitHub (existing behavior), GitLab, and Gitea. Repeated: the lesson from Spec 3 still binds.

### State-first ordering (carries over)

For every forge, state.json is written BEFORE any forge API call (list/create/update). If the forge call fails, the secret/URL are already persisted and the user can re-run to recover. This is the same conditional-write rule from Spec 5 — no mtime bump when the desired state deep-equals the existing on-disk state, but the write, when needed, happens before any network call.

### Per-forge required behaviors

Each forge branch must do the same five logical steps as the GitHub branch — the only thing that varies is the API call.

**Common flow (shared across all three forges)**:
1. Parse args, validate forge-specific required flags (e.g., `--gitea-url` for gitea)
2. Walk up to find project root (existing `findProjectRoot`)
3. Load existing `state.json` (existing `loadState`)
4. Generate webhook secret if missing
5. Fetch smee.io channel URL if missing (existing `fetchSmeeChannel`)
6. Conditionally write `state.json` (state-first rule)
7. **Forge-specific**: list existing webhooks, match by smee URL, create or update
8. Merge `.mcp.json` (existing behavior — add `mcpServers.ci` if missing, leave alone otherwise)
9. **Codev integration** (new — see section below)
10. Print next-steps message

Step 7 is the only thing that differs per-forge. Steps 1–6 and 8–10 are identical for all three forges and must not be duplicated per branch.

#### GitHub (existing — do not break)

- List: `gh api --paginate --slurp repos/OWNER/REPO/hooks`
- Create: `gh api --method POST repos/OWNER/REPO/hooks --input -`
- Update: `gh api --method PATCH repos/OWNER/REPO/hooks/ID --input -`
- Payload shape: existing canonical payload from Spec 5. Do not change it.
- Match rule: `h.config?.url === smeeUrl`. First match wins.
- Error classification: 404 → "Could not find repo X", 403 → "needs admin:repo_hook scope", auth → "gh auth login".

#### GitLab (new)

- **CLI**: `glab api`. Same subprocess pattern as `gh` (no `process.stdin` inheritance; use `stdio: ['pipe', 'pipe', 'pipe']` and write the JSON body to stdin).
- **Path encoding**: `--repo` is a `path_with_namespace` like `group/project` or `group/subgroup/project`. URL-encode it (`encodeURIComponent`) when building the API path — GitLab's REST API takes URL-encoded project paths.
- **List**: `glab api projects/{encoded-path}/hooks`. No `--paginate --slurp` — `glab` does not support that flag. Assume a single page (GitLab projects with >100 webhooks are astronomically rare, and the test suite need not cover pagination for GitLab). Parse as a JSON array directly.
- **Create**: `glab api --method POST projects/{encoded-path}/hooks --input -`
- **Update**: `glab api --method PUT projects/{encoded-path}/hooks/{id} --input -` (GitLab uses PUT, not PATCH, for hook updates — this differs from GitHub)
- **Match rule**: `h.url === smeeUrl` (GitLab hook objects have `url` at the top level, not nested under `config`). First match wins.
- **Payload shape** (use this exact shape, JSON-stringify and pipe via stdin):

```json
{
  "url": "<smeeUrl>",
  "token": "<webhookSecret>",
  "pipeline_events": true,
  "push_events": false,
  "merge_requests_events": false,
  "tag_push_events": false,
  "issues_events": false,
  "confidential_issues_events": false,
  "note_events": false,
  "confidential_note_events": false,
  "job_events": false,
  "wiki_page_events": false,
  "deployment_events": false,
  "releases_events": false,
  "enable_ssl_verification": true
}
```

The explicit `false` fields are required — GitLab defaults `push_events` to `true` on create, so omitting it would enable push notifications we don't want. The spec runtime only cares about `pipeline_events`.

- **Error classification**:
  - 404 / "Not Found" → `Could not find project '<repo>'. Check the spelling, or verify you have access (glab returned 404).`
  - 403 / "Forbidden" → `Access denied to '<repo>' hooks. Your glab token needs project maintainer/owner permission and the 'api' scope. Run \`glab auth login\` and retry.`
  - 401 / "Unauthorized" / "not logged in" → `glab is not authenticated. Run \`glab auth login\` and retry.`
  - `ENOENT` (glab not installed) → `glab CLI not found. Install from https://gitlab.com/gitlab-org/cli and run \`glab auth login\`.`
- **`glab` version**: assume `glab` ≥ 1.30 (released late 2023). Do not implement version-detection or compatibility fallbacks.

#### Gitea (new)

- **No CLI wrapper.** Use global `fetch()` directly. This is why we need `--gitea-url` — there's no `glab`-style "remembered instance" for Gitea.
- **Token**: read `GITEA_TOKEN` from (in precedence order):
  1. `process.env.GITEA_TOKEN`
  2. `<project-root>/.claude/channels/ci/.env` file `GITEA_TOKEN=...` line

  If missing from both, fail fast with: `GITEA_TOKEN not set. Generate a token at <gitea-url>/user/settings/applications (scopes: write:repository) and add it to <project-root>/.claude/channels/ci/.env as GITEA_TOKEN=... or export GITEA_TOKEN in your shell.`

  Do NOT prompt for it. Do NOT fall back to unauthenticated requests. Do NOT write the token to state.json.

  Use a minimal inline `.env` parser — a single `split('\n')` loop with `KEY=value` extraction is fine. Do NOT import `parseEnvFile` from `lib/config.ts` (that file is not exported). Do NOT add `dotenv` as a dependency. Keep the parser to ≤10 lines.

- **Base URL**: accept `--gitea-url` with or without a trailing slash. Normalize by stripping trailing `/`. Do not validate the URL beyond "it's a string that starts with `http://` or `https://`"; let `fetch` error naturally if it's malformed.
- **List**: `GET {gitea-url}/api/v1/repos/{owner}/{repo}/hooks`, with `Authorization: token <GITEA_TOKEN>`. Parse as JSON array. No pagination. Gitea's default page size is 50 hooks, which is more than any real repo has.
- **Create**: `POST {gitea-url}/api/v1/repos/{owner}/{repo}/hooks`
- **Update**: `PATCH {gitea-url}/api/v1/repos/{owner}/{repo}/hooks/{id}`
- **Match rule**: `h.config?.url === smeeUrl` (Gitea's hook shape is similar to GitHub's — `config` is a nested object). First match wins.
- **Payload shape** (create):

```json
{
  "type": "gitea",
  "config": {
    "url": "<smeeUrl>",
    "content_type": "json",
    "secret": "<webhookSecret>"
  },
  "events": ["workflow_run"],
  "active": true
}
```

**Payload shape (update)** — Gitea's edit endpoint does NOT accept `type` (it's only valid on create). Send:

```json
{
  "config": {
    "url": "<smeeUrl>",
    "content_type": "json",
    "secret": "<webhookSecret>"
  },
  "events": ["workflow_run"],
  "active": true
}
```

- **Content-Type**: `application/json` on all requests. Body must be `JSON.stringify(payload)`.
- **Error classification**:
  - `resp.status === 404` → `Could not find Gitea repo '<repo>' at <gitea-url>. Check the URL and repo path.`
  - `resp.status === 403` → `Access denied to '<repo>' hooks on <gitea-url>. Your GITEA_TOKEN needs write:repository scope.`
  - `resp.status === 401` → `GITEA_TOKEN is invalid or expired. Generate a new one at <gitea-url>/user/settings/applications.`
  - Other non-2xx → generic `Gitea API error (status N): <response body>`.
  - Network error / `fetch` throws → let the error message flow through the top-level catch.
- **Timeout**: 10 seconds per request via `AbortController`. Fail fast if exceeded (do not retry).

### Codev auto-integration (new)

After the core install finishes (webhook registered + `.mcp.json` merged), check for `<project-root>/.codev/config.json`:

- **If the file does not exist**: do nothing. Silent skip. Codev is optional.
- **If the file exists**:
  1. Read and `JSON.parse` it (let malformed JSON throw — propagates to top-level catch).
  2. Check if `config.shell?.architect` is a non-empty string. If it is missing or empty, skip with a log: `` `.codev/config.json has no shell.architect — skipping (unexpected Codev shape)` ``. Do not try to create the field.
  3. Check if the existing `shell.architect` string **already contains** the substring `--dangerously-load-development-channels server:ci`. If it does, log `` `.codev/config.json already loads ci channel — skipping` `` and return.
  4. Otherwise, **append** ` --dangerously-load-development-channels server:ci` to the existing `shell.architect` string (with a single leading space). Do not try to insert it in any particular position, do not re-parse the command, do not quote-aware-split. A simple string concat is correct: the architect command is a shell command line, and Codev invokes it via the shell, so appending a flag at the end works.
  5. Write the file back using `JSON.stringify(config, null, 2) + '\n'`. Do not change any other field (`shell.builder`, `shell.anythingElse`, other top-level keys must remain byte-equal when re-serialized — which they will, because we only mutated `shell.architect`).
  6. Log `Updated .codev/config.json: architect session will now load ci channel`.

**Hard rules for Codev integration**:
- **Only modify `shell.architect`.** If the file has a `shell.builder` or any other field, leave it alone. Don't add a `--dangerously-load-development-channels` to the builder — that's a different concern.
- **Substring match is sufficient.** Don't try to handle edge cases like "someone put the flag in the middle surrounded by custom quoting." If the substring is present, skip. If not, append.
- **One field mutated, nothing else.** No reordering of keys, no adding fields, no canonical formatting — just `JSON.parse` → mutate one string → `JSON.stringify(…, null, 2) + '\n'`. This will reorder keys alphabetically if they weren't already, which is fine; the Codev CLI handles arbitrary key order.

  Correction: `JSON.stringify` **preserves insertion order** in Node.js — it does not alphabetize. The output should therefore have the same key order as the input. The sentence above is a misnomer; the guarantee we actually rely on is that `JSON.parse` → mutate → `JSON.stringify` round-trips key order. **This is the intended behavior.** If a reviewer cites "JSON.stringify reorders keys" — they are wrong; point them at ECMA-262 §24.5.2 which specifies `EnumerableOwnProperties` order.

### No interactive prompts (carries over)

Running the command is the confirmation. No `@inquirer/prompts`, no `readline`, no TTY detection, no `Io`/`confirm`/`prompt` abstraction, no `UserDeclinedError`.

### Progress output (carries over from v0.3.1)

Each step prints a short `[ci-channel] ...` line to stderr (the existing `log()` helper). Keep the v0.3.1 UX improvements: "Project root: ...", "Target repo: ...", "Provisioning smee.io channel...", "Wrote state.json (mode 0o600)", "Listing existing webhooks...", "Creating new webhook..." etc. Add equivalent lines for the new branches. The final "Done. Launch Claude Code with ..." line goes to stdout.

## .env File Handling

For Gitea, reading `GITEA_TOKEN` from `<project-root>/.claude/channels/ci/.env` requires a minimal inline parser. This is NOT a dependency on `lib/config.ts`'s `parseEnvFile` — the installer must work even if `lib/config.ts` is restructured later, and calling `loadConfig()` from inside the installer would be circular (loadConfig needs a state path which needs a project root which the installer already has — just avoid the whole mess).

**Minimal parser** (add to `lib/setup.ts`):

```typescript
function readEnvToken(envPath: string, key: string): string | undefined {
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const k = trimmed.slice(0, eq).trim()
      if (k !== key) continue
      let v = trimmed.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v
    }
  } catch {
    return undefined
  }
}
```

~15 lines. Fits in the 300-line budget.

## Test Scenarios

Tests use real temp directories, the PATH-override fake-`gh`/`glab` pattern from Spec 5, and a **real local HTTP server** for Gitea (since Gitea uses `fetch`, not a CLI wrapper). All tests cap at ≤20 total in one ≤400-line file.

### Test mocking strategy

- **`gh` CLI** — PATH-override fake (existing pattern from Spec 5 tests 1–6)
- **`glab` CLI** — **same PATH-override pattern**. Write a fake `glab` POSIX shell script next to the fake `gh`. The existing `mkFakeGh` helper should be renamed to `mkFakeCli` or parameterized by binary name so it works for both. Alternatively, have two helpers (`mkFakeGh`, `mkFakeGlab`) — pick whichever keeps the test file under 400 lines.
- **Gitea HTTP API** — use a local `http.createServer` instance on an ephemeral port (`listen(0)`). Each test starts a fresh server, registers a request handler that matches on URL + method and returns canned JSON, and tears down in a `finally`. The `--gitea-url` flag points at `http://127.0.0.1:${port}`. No external network calls, no `globalThis.fetch` stubbing.
- **`fetchSmeeChannel`** — still not mocked. Prepopulate state.json with a fake `smeeUrl` + `webhookSecret` before calling `setup()`, as in Spec 5.

Windows: the fake-CLI tests (github + gitlab paths) skip on `win32` just like Spec 5's scenarios 1–6. The Gitea HTTP-server tests **do not** require POSIX shell and can run on Windows — but if you're short on budget, skip them on win32 too for consistency. (Not a hard rule; reviewer's call.)

### Scenarios to ADD (≤12 new, aim for 10)

**Pre-existing scenarios (keep unchanged, renumbered if needed)**: the 8 scenarios from Spec 5 stay exactly as they are. They test the GitHub path and the default-forge behavior. No regression.

**New GitLab scenarios**:
1. **GitLab happy path**: seed state.json with fake `smeeUrl` + `webhookSecret`, no `.mcp.json`, fake `glab` returns `[]` on list + `{}` on POST. Assert: `glab api projects/group%2Fproject/hooks` called for list; `glab api --method POST projects/group%2Fproject/hooks --input -` called for create; POST body contains `url: smeeUrl`, `token: webhookSecret`, `pipeline_events: true`, `push_events: false`; state.json byte-equal; `.mcp.json` created with canonical `ci` entry.
2. **GitLab idempotent re-run**: seed state.json, fake `glab` list returns `[{ id: 77, url: smeeUrl }]`, PUT succeeds. Assert: PUT called exactly once on `/hooks/77` with the canonical payload; state + .mcp.json byte-equal (re-run after scenario 1 state).
3. **GitLab subgroup path encoding**: seed state, use `--repo group/subgroup/project`, fake `glab` list returns `[]`, POST succeeds. Assert: `glab api` path is `projects/group%2Fsubgroup%2Fproject/hooks`. (Confirms `encodeURIComponent` is applied to the whole path_with_namespace, not just parts.)

**New Gitea scenarios**:
4. **Gitea happy path**: start local HTTP server that responds `[]` on `GET /api/v1/repos/owner/repo/hooks` and `{}` on `POST /api/v1/repos/owner/repo/hooks`. Seed state.json + `GITEA_TOKEN=fake-token` in `.env`. Run setup with `--forge gitea --gitea-url http://127.0.0.1:PORT --repo owner/repo`. Assert: POST received with body `{ type: 'gitea', config: { url: smeeUrl, ... }, events: ['workflow_run'], active: true }`; `Authorization: token fake-token` header present; state.json byte-equal; `.mcp.json` has canonical `ci` entry.
5. **Gitea idempotent re-run**: server returns `[{ id: 99, config: { url: smeeUrl } }]` on list, `{}` on PATCH. Assert: PATCH called on `/hooks/99`; update body does NOT contain `type` field; state + .mcp.json byte-equal.
6. **Gitea missing token**: seed state.json but NOT `.env`, no `GITEA_TOKEN` env var. Run with `--forge gitea --gitea-url http://... --repo owner/repo`. Assert: `process.exit(1)` called; stderr contains `GITEA_TOKEN not set`. No HTTP request made (server's request log is empty).
7. **Gitea 401 from server**: seed state.json + `.env` token, server returns 401 on list. Assert: `process.exit(1)`; stderr contains `GITEA_TOKEN is invalid or expired`; state.json contains the pre-seeded secret (state-first ordering preserved).

**New Codev scenarios** (these can use the GitHub path — Codev integration is forge-agnostic):
8. **Codev config gets the flag**: seed `.codev/config.json` with `{ shell: { architect: 'claude --dangerously-skip-permissions' } }`, run setup (GitHub path, fake `gh`). Assert: after setup, `.codev/config.json` `shell.architect` is `'claude --dangerously-skip-permissions --dangerously-load-development-channels server:ci'`. Stderr contains `Updated .codev/config.json`.
9. **Codev config already has the flag**: seed `.codev/config.json` with the flag already present. Run setup. Assert: file byte-equal after setup; stderr contains `already loads ci channel`.
10. **No .codev/ directory**: no `.codev/` at all. Run setup. Assert: setup succeeds; `.codev/` still does not exist after; no Codev-related log lines in stderr.

**Optional stretch** (add only if budget allows):
11. **CLI validation: `--forge invalid`** → exit 1 with usage
12. **CLI validation: `--forge gitea` without `--gitea-url`** → exit 1 with clear message

10 scenarios is the target. 12 is the cap. Fewer than 10 is a REQUEST_CHANGES (we need coverage of at least the 3 GitLab, 3 Gitea core, and 3 Codev scenarios).

### Test implementation hints (not rules)

- The existing `mkFakeGh` helper generalizes nicely: rename the `bin` path from `gh.*` to `<name>.*` and pass the binary name as an argument. Or just write `mkFakeCli(bin, name, responses)`.
- The Gitea HTTP server helper goes at the top of the test file (inline, not a separate module):

  ```typescript
  async function withGiteaServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    fn: (url: string) => Promise<void>
  ): Promise<void> {
    const server = http.createServer(handler)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    try { await fn(`http://127.0.0.1:${port}`) }
    finally { await new Promise<void>(r => server.close(() => r())) }
  }
  ```

  ~12 lines. The handler captures requests into a log array the test can assert on.

- State.json seeding stays the same as Spec 5.

## Dispatch Integration

**Already done in Spec 5.** `server.ts` already has the 5-line dispatch:

```typescript
if (process.argv[2] === 'setup') {
  const { setup } = await import('./lib/setup.js')
  await setup(process.argv.slice(3))
  process.exit(0)
}
```

Spec 7 does NOT modify `server.ts`. All new work lives in `lib/setup.ts` and `tests/setup.test.ts`.

## Documentation Updates

Docs updates land in the **implement** phase, not a separate phase (the spec explicitly rules out a "docs" phase).

- **README.md**: add a GitLab example and a Gitea example to the installation section. Keep each ≤5 lines.
- **INSTALL.md**: add a short note pointing users to `ci-channel setup --forge gitlab` / `--forge gitea` as the recommended path. Do not remove the manual instructions (advanced users may still want them).
- **CLAUDE.md / AGENTS.md**: bump the "Installation" section to mention all three forges are supported by the installer. Keep the two files in sync (the existing note at the top of CLAUDE.md already requires this).
- **package.json**: bump version from `0.3.1` → `0.4.0`.

No changes to architecture docs beyond the one-line mention in `codev/resources/arch.md` that the setup subcommand now supports GitLab + Gitea.

## Non-Goals

Explicit non-goals — do **not** implement these even if they seem tempting:

- **Webhook rotation** (`--rotate`, `--regenerate-secret`) — users who want to rotate delete state.json and re-run
- **GitLab self-hosted instance URL flag** (`--gitlab-url`) — `glab` already handles instance selection via its own config (`GITLAB_URI` env var, `~/.config/glab-cli/config.yml`); don't duplicate it. Users on self-hosted GitLab point `glab auth login` at their instance before running our installer.
- **Gitea organization-level hooks** — only repo-level
- **Multiple webhooks per project per forge** — one smee channel, one webhook, period
- **Dry-run mode** — no
- **Smee channel reuse across projects** — each project gets its own, same as Spec 5
- **Fallback if `fetchSmeeChannel` fails** — no, just error out (same as Spec 5)
- **`--yes` / `--confirm`** — no prompts to skip
- **Telemetry** — no
- **Migration from global `.env` to project `.env`** — not in scope; if the user has an old global `.env` with `GITEA_TOKEN`, point them at the existing v0.2.0 migration notes (runtime already handles this via `getDefaultEnvPath` precedence)
- **Writing `GITEA_TOKEN` to `.env` on the user's behalf** — no; the user generates the token and adds it themselves
- **Testing `fetchSmeeChannel` network calls** — still covered by `tests/bootstrap.test.ts`; setup tests prepopulate state

## Review Gate Enforcement

At PR review time, the reviewer MUST verify each of the following. **Any violation is an automatic REQUEST_CHANGES.**

- [ ] `wc -l lib/setup.ts` ≤ 300
- [ ] `wc -l tests/setup.test.ts` ≤ 400
- [ ] `lib/setup.ts` is a single file; `lib/setup/` does not exist
- [ ] `tests/setup.test.ts` contains ≤ 20 test cases total (`grep -cE '^ *(test|it)\(' tests/setup.test.ts`)
- [ ] `grep -rE 'InstallDeps|Io interface|SetupError|UserDeclinedError|ForgeInstaller' lib/setup.ts` returns nothing
- [ ] `grep '"@inquirer\|"commander\|"yargs\|"dotenv\|"@gitbeaker\|"gitea-js\|"node-fetch\|"undici\|"axios' package.json` returns nothing (new deps forbidden)
- [ ] `grep -rE 'readline|prompt\(|confirm\(' lib/setup.ts` returns nothing
- [ ] No files added under `lib/setup/` or `lib/forge-installers/`
- [ ] `server.ts` is unchanged (git diff should show 0 lines in `server.ts`)
- [ ] GitLab PUT (not PATCH) is used for hook updates — `grep '--method PUT' lib/setup.ts` OR the PUT is implicit in the glab command; confirm by reading the code
- [ ] Gitea update payload does NOT include `type` field (read the code)
- [ ] Gitea token precedence: `process.env` first, then `.env` file (read the code)
- [ ] `.mcp.json` merge still uses key-presence check (`'ci' in servers`), not truthiness
- [ ] State-first ordering preserved on ALL three forge branches (grep for the forge call, confirm the state write comes before it)
- [ ] `.codev/config.json` is read/modified only if it exists; non-existence is silent
- [ ] `package.json` version is `0.4.0`
- [ ] All existing tests still pass (diff test count before/after; new tests added = ≤12, old tests unchanged)

## Dependencies

- `crypto.randomBytes`, `node:fs`, `node:path`, `node:child_process`, `node:http` (for tests), `fetch` (global, Node ≥18) — all Node built-ins
- `findProjectRoot` from `lib/project-root.ts` (existing, unchanged)
- `loadState` from `lib/state.ts` (existing, unchanged)
- `fetchSmeeChannel` from `lib/bootstrap.ts` (existing, unchanged)
- `gh` CLI ≥ 2.29 (user-provided) — for GitHub branch
- `glab` CLI ≥ 1.30 (user-provided) — for GitLab branch
- No CLI for Gitea — `fetch` + `GITEA_TOKEN`

**No new `package.json` entries.** No new runtime or dev dependencies.

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| 300-line budget overshoot in `lib/setup.ts` | Medium | High (spec violation) | Keep forge branches inline (`if/else`), share the common flow steps, don't duplicate error-classification blocks per forge (use a helper that takes a name+stderr). |
| 400-line budget overshoot in `tests/setup.test.ts` | Medium | High | Generalize `mkFakeGh` → `mkFakeCli`. Share `inProject` + `runSetup` + `seedState` helpers. Compress Codev scenarios (smaller bodies — just read/write + one assert each). |
| GitLab API uses PUT not PATCH, builder writes PATCH | Medium | Medium (tests catch it but burns an iter) | Spec has a dedicated review checklist item. |
| Gitea update payload includes `type` field, Gitea rejects | Medium | Medium (tests catch it) | Spec has a dedicated review checklist item; spec explicitly shows two different payload shapes for Gitea create vs update. |
| `fetch` AbortController timeout doesn't work in all Node versions | Low | Low | Node ≥18 has stable AbortController support; `package.json` `engines` should already set Node ≥18 (verify in impl phase). |
| Codev `JSON.stringify` re-ordering user's keys | Very Low | Low | Node's `JSON.stringify` preserves insertion order; spec notes this explicitly. If a user's Codev config has comments, those were already lost (JSON doesn't support comments). |
| Scope creep — reviewer asks for a forge-installer abstraction during plan review | Medium | High | Spec explicitly forbids it (see "Single file, no module split"). The plan reviewer MUST reject any abstraction proposal citing this spec section. |
| Scope creep — reviewer asks for `--gitlab-url` flag | Low | Medium | Spec explicitly non-goals it; `glab` handles instance selection via its own config. |

## Expected Review Flow

- **Spec review (3-way, ASPIR-auto-approved)**: reviewers should focus on completeness. Likely concerns: "what about self-hosted GitLab?" (non-goal, `glab` handles it), "what if `.codev/config.json` is malformed?" (throws, flows through top-level catch), "what about Gitea token scopes?" (spec says `write:repository`, classify 403 accordingly).
- **Plan review (3-way, ASPIR-auto-approved)**: the plan should essentially be "extend the existing `setup()` function with a `switch(forge)` block, add a `codevIntegrate()` helper at the end, rename `mkFakeGh` to `mkFakeCli` in tests, add 10 test scenarios." Anything larger is over-engineered.
- **Impl phase**: one phase (call it `impl`). The spec explicitly rejects a separate "docs" phase; docs updates are folded into impl.
- **PR review**: run the review-gate checklist above. Single PR, single merge.

## Success Looks Like

A PR that:
- Adds ≤150 lines to `lib/setup.ts` (bringing it from ~195 to ~345 max — under the 300-line cap means tightening the existing code too) — actually: **target total ≤300 lines in the final `lib/setup.ts`**, which means the diff is likely +~100 lines after cleanup/deduplication
- Adds ≤200 lines to `tests/setup.test.ts` (bringing it from ~198 to ~398 max)
- Modifies no other `lib/` files
- Modifies no other `tests/` files
- Bumps `package.json` version to `0.4.0`
- Updates README / INSTALL / CLAUDE / AGENTS with short GitLab + Gitea examples
- Passes all existing tests + the 10 new ones
- Is reviewable in one sitting
- Ships in one iteration (ASPIR — no human gates on spec/plan, one human gate on PR)

## Amendments

This section tracks all TICK amendments to this specification. None yet.
