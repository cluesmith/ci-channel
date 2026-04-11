# Specification: Interactive Installer (`ci-channel setup`)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Metadata
- **ID**: spec-2026-04-10-interactive-installer
- **Status**: draft
- **Created**: 2026-04-10
- **Issue**: cluesmith/ci-channel#3

## Clarifying Questions Asked

The issue (#3) is detailed and prescriptive. Key decisions extracted from it:

1. **Q**: Should the installer be a separate binary or a subcommand? **A**: Subcommand. `ci-channel` with no args continues to run the MCP server (current default behavior). `ci-channel setup [opts]` runs the installer.
2. **Q**: Interactive or non-interactive by default? **A**: Interactive by default (prompts before every side-effecting step). A `--yes`/`-y` flag skips prompts for scripting / AI agents.
3. **Q**: Which forges are supported in v1? **A**: GitHub only. GitLab and Gitea are explicitly deferred to follow-up work — the subcommand should accept `--forge`, but non-GitHub values should fail fast with a "not yet implemented" error.
4. **Q**: Which prompt library? **A**: `@inquirer/prompts` (the maintained rewrite of Inquirer) — better UX than bare readline, ESM-native, tree-shakeable.
5. **Q**: Where does the installer write state? **A**: Into the detected project root: `<project-root>/.claude/channels/ci/state.json`. A `.env` file is **not** written by the installer — the secret lives in `state.json` only, which is exactly what the runtime plugin already reads via `loadConfig` → `ensureSecretReal` → `loadState`. This avoids the two-source-of-truth problem and respects the existing `.env`-is-user-override model.
6. **Q**: Should the installer modify `.mcp.json`? **A**: Yes, but idempotently — only insert the `ci` server entry if it isn't already present. If present, warn and skip.
7. **Q**: What happens when re-running on an already-configured project? **A**: The installer is idempotent. It detects existing state.json, reuses the smee URL + secret, and skips webhook creation if a webhook already exists for that smee URL.
8. **Q**: What about rotation? **A**: Out of scope for v1. Re-running is safe but does not rotate. A `--rotate` flag is mentioned in the issue as future work — not implemented here.
9. **Q**: Should it authenticate as the user or require `gh` to already be authenticated? **A**: Require `gh` authenticated. The installer shells out to `gh api` and surfaces the error if auth is missing. It does not attempt to run `gh auth login`.
10. **Q**: What happens on non-TTY stdin (CI / pipes / redirected input)? **A**: `@inquirer/prompts` throws on non-TTY. The installer detects `!process.stdin.isTTY` at startup and: (a) if `--yes` is set, proceed non-interactively; (b) otherwise, fail fast with a message instructing the user to pass `--yes`. No automatic fall-through — an agent calling the installer without `--yes` is almost certainly a bug.
11. **Q**: Does the old global `~/.claude/channels/ci/` state still matter? **A**: The installer always writes project-local state. If a legacy global state file exists, it is **not** read, migrated, or deleted. Runtime `loadState` already falls back to the global path when no project root is detected, but the `setup` subcommand requires a project root and therefore only operates on project-local state. Existing installs using the global path continue to work as-is (no change to runtime).

## Problem Statement

Installing `ci-channel` into a new project is currently a five-step manual process that has a chicken-and-egg ordering problem and is error-prone for humans and AI agents alike.

Today a user must:
1. Run `claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel"]}'`
2. Launch Claude Code once with `--dangerously-load-development-channels server:ci` so the plugin's bootstrap code generates a webhook secret and provisions a smee.io channel, writing them to `.claude/channels/ci/state.json`.
3. Read credentials out of that state file.
4. Create the GitHub webhook with `gh api repos/OWNER/REPO/hooks POST` using the credentials from step 3.
5. Relaunch Claude Code with the same channel flag for the webhook to actually be consumed.

This process has three major problems:

- **Chicken-and-egg ordering**: The webhook in step 4 needs credentials (smee URL + secret) that only exist after step 2. Users can't do the webhook-creation step upfront.
- **Requires two Claude launches**: Steps 2 and 5 are otherwise identical, the only difference being that the second launch now has a working webhook. This is confusing and slow.
- **Hard for agents to automate**: Each step has a subtle failure mode (project vs user scope, server key vs package name, `.mcp.json` format, webhook config JSON shape) documented in INSTALL.md troubleshooting. An LLM agent trying to run the install end-to-end will hit these repeatedly.

## Current State

- Installation is documented in `INSTALL.md` as a five-step process.
- The README recommends the same five-step flow.
- Bootstrap logic already exists in `lib/bootstrap.ts` — it generates the secret and provisions the smee channel when the plugin first runs. But it's only callable as a side effect of running the MCP server.
- Project detection (`findProjectRoot`) and state persistence (`loadState`, `saveState`) already exist in the `lib/` directory and are forge-agnostic.
- There is no CLI entry point apart from `server.ts`. The package `bin` points at the built server.
- The only dependencies beyond MCP SDK are `smee-client`. No prompt library is installed.

## Desired State

A single command completes the entire install flow end-to-end:

```bash
npx ci-channel setup --repo owner/project
```

This replaces all five manual steps. The new flow:

1. **Detect project root** by walking up from cwd (same logic used by the plugin at runtime).
2. **Provision credentials upfront** by reusing the existing `bootstrap` logic's building blocks (generate secret, fetch smee.io channel) *without* having to run the MCP server.
3. **Write state.json** into `<project-root>/.claude/channels/ci/` (single source of truth for auto-provisioned secret + smee URL; `.env` is untouched so it remains available as a user-managed override).
4. **Create the GitHub webhook** via `gh api repos/OWNER/REPO/hooks POST` with the freshly provisioned URL + secret.
5. **Update `.mcp.json`** to register the `ci` server entry if it isn't already registered.
6. **Print next steps** — tell the user to launch Claude Code with `claude --dangerously-load-development-channels server:ci` (or that it's already wired in the existing session) and that CI notifications will flow.

Interactive by default: before each side-effecting step (provisioning a smee channel, writing files, creating a webhook, editing `.mcp.json`), the installer shows the planned action and asks confirmation. `--yes` / `-y` skips every prompt. `--dry-run` prints all planned actions without executing any of them.

Idempotent: re-running the installer on an already-set-up project detects existing state, reuses it, and skips any step that has already been completed. Re-running is safe — it never duplicates webhooks, never overwrites valid credentials, and never corrupts `.mcp.json`.

The README and INSTALL.md are rewritten to recommend `ci-channel setup --repo owner/project` as the primary installation method, with the manual five-step flow kept as a fallback / advanced reference.

## Stakeholders
- **Primary Users**: Developers (human and AI agent) installing ci-channel into a new project for the first time.
- **Secondary Users**: Existing users re-running setup against an already-configured project (must be safe).
- **Technical Team**: ci-channel maintainers — new code path must be covered by tests and must not regress the existing MCP server flow.
- **Business Owners**: Project owner (@cluesmith) — wants a one-command install so that docs, demos, and agent-driven setup all work without friction.

## Success Criteria

- [ ] `npx ci-channel setup --repo owner/repo` runs end-to-end on a fresh project and produces a working ci-channel install (webhook registered, state.json written, `.mcp.json` updated).
- [ ] `ci-channel setup` without any subcommand args runs the MCP server (existing behavior preserved).
- [ ] Interactive mode prompts before each side-effecting step (smee provisioning, state write, webhook create/update, `.mcp.json` edit).
- [ ] `--yes` flag suppresses all prompts.
- [ ] `--dry-run` prints each planned action without executing it and does not make any network calls for mutating operations (smee fetch and webhook POST are skipped).
- [ ] Non-TTY stdin without `--yes` → fail fast with a clear error message (`stdin is not a TTY; pass --yes to run non-interactively`). Non-TTY stdin with `--yes` → proceed non-interactively.
- [ ] `--forge github` (or default) works; `--forge gitlab` and `--forge gitea` fail fast with a clear message: "`setup` subcommand only supports GitHub in v1 — the MCP server itself supports all three forges; use the manual install flow in INSTALL.md for GitLab/Gitea".
- [ ] Idempotency: re-running the installer on an already-configured project does not create a duplicate webhook, does not overwrite a valid state.json, and does not duplicate the `ci` entry in `.mcp.json`.
- [ ] `gh` not authenticated → installer surfaces the `gh api` error and exits non-zero with a clear message telling the user to run `gh auth login`.
- [ ] Works from **any subdirectory** of the target project (not just the root) — `findProjectRoot` locates the project root.
- [ ] Works regardless of whether ci-channel is installed from source, from npm, or run via `npx ci-channel setup`.
- [ ] Unit tests cover the state-file, `.mcp.json` update, and webhook-creation logic with mocks for `gh` and filesystem.
- [ ] Existing 170 tests continue to pass (no regression).
- [ ] README.md and INSTALL.md updated to recommend `setup` as the primary installation method.

## Constraints

### Technical Constraints
- Must reuse existing project-detection, state-persistence, and secret-generation code from `lib/` (no copy-paste; share the real implementations). Where an existing helper takes an implicit cwd path (e.g., `ensureSecretReal` internally calls `loadState()` with no args), either (a) happen to align because the installer's cwd *is* the project root context, or (b) pass an explicit project-local state path via the already-supported `saveState(state, path)` / `loadState(path)` overloads. Plan phase must resolve which path each call site takes; the spec requires that the installer always operates on project-local state regardless of how the helpers are wired.
- Must preserve the existing default behavior: invoking `ci-channel` with no args (or with server-mode args like `--forge`, `--repos`) still runs the MCP server. Subcommand dispatch must not break `.mcp.json` entries like `{"command":"npx","args":["-y","ci-channel","--forge","gitlab"]}`. Dispatch triggers **only** on exact match `process.argv[2] === 'setup'`.
- `--dry-run` must not perform any **mutating** network operations: no POST to smee.io, no webhook POST/PATCH to GitHub, no file writes. Read-only network calls (e.g., `gh api GET repos/{repo}/hooks` to preview idempotency behavior) are allowed because they give the user a more accurate preview of what the non-dry-run would do. The trade-off is that dry-run requires `gh` to be authenticated, which is the same prerequisite as the non-dry-run install. If dry-run is supposed to be a "would anything break?" check, calling the read API is exactly what the user wants.
- Webhook creation goes through `gh` CLI (spawned subprocess). Do not call the GitHub REST API directly — reusing `gh` inherits the user's auth setup.
- **Subprocess stdio pattern**: The MCP stdio isolation rule is "subprocesses must not inherit `process.stdin`" so they don't consume bytes from the MCP client's JSON-RPC stream. The mechanism used until now has been `stdin: 'ignore'`. For the installer's `gh api --method POST --input -` call, a JSON payload must be delivered on stdin, so `stdin: 'ignore'` is not viable. Use `stdio: ['pipe', 'pipe', 'pipe']` (a dedicated pipe, explicitly *not* `'inherit'`) and write the payload to the child's stdin. An alternative that preserves `stdin: 'ignore'` is writing the payload to a temp file and passing `--input /path/to/tmp.json`; this is explicitly allowed if the implementer prefers it. Either approach satisfies the isolation invariant (`process.stdin` is never inherited by the child). The `setup` subcommand is also never invoked from inside the running MCP server (it exits via subcommand dispatch before the server starts), so the risk surface is smaller than for server subprocesses — but the invariant is preserved anyway to keep the codebase consistent.
- **Dynamic import of the installer module**: Approach 1 (subcommand dispatch in `server.ts`) must use `await import('./lib/setup/index.js')` inside the `setup` branch, not a top-level import. This ensures the normal MCP server startup does not pay the load cost of `@inquirer/prompts` or any installer-only code.
- `@inquirer/prompts` must be added as a runtime dependency. It is ESM-only and small (no heavy transitive deps).
- No new transitive surface area: avoid bringing in commander, yargs, or oclif. Reuse the existing `process.argv` iteration pattern from `lib/config.ts` (or a minimal ad-hoc parser) for subcommand/flag parsing.
- TypeScript: subcommand source files live under `lib/setup/` (a new subdirectory). The rest of `lib/` is flat, but the installer has several tightly-coupled files (arg parsing, prompt runner, `.mcp.json` merger, `gh` wrapper) that benefit from grouping. Nothing outside the installer imports from `lib/setup/`.

### Business Constraints
- GitHub-only in v1. Do not block the feature on GitLab/Gitea parity.
- Must not break existing installs — users already set up via the five-step flow must still work without change.
- The old manual flow must remain documented as a fallback in INSTALL.md. It's the "source of truth" reference for understanding what `setup` is automating.

## Assumptions

- Users running `ci-channel setup` for GitHub have the `gh` CLI installed and authenticated (`gh auth status` succeeds). The installer does not attempt to install or authenticate `gh`.
- Users have `admin:repo_hook` scope on their `gh` token (required by GitHub to create webhooks). If missing, `gh api hooks POST` returns 404/403; the installer surfaces that error verbatim with a hint about the required scope.
- `smee.io` is reachable from the user's network. This is already a hard requirement of the runtime plugin; reusing it here doesn't add new risk. If smee.io is down or blocked, `--dry-run` still works (doesn't hit the network) and non-dry-run fails fast with a clear error.
- The target repo exists and the user has admin access to it (required to create webhooks). Failures here are reported verbatim via `gh` error text.
- Node.js v20.17.0+ (bumped from `>=20` in Spec 3 to match the `@inquirer/prompts` transitive dep floor from `mute-stream`).
- The project to install into is either a Claude Code project (has `.mcp.json`) or a git repo (has `.git/`). Projects that are neither are out of scope — the installer refuses with a clear error.

## Solution Approaches

### Approach 1: Subcommand dispatch in `server.ts` top-level

**Description**: Add a check at the top of `server.ts`: if `process.argv[2] === 'setup'`, delegate to a new `lib/setup/index.ts` module and exit. Otherwise, continue the existing server-startup code path.

**Pros**:
- Single entry point — `package.json` `bin` field doesn't change.
- No need to juggle a second binary.
- Works unchanged with `npx ci-channel setup` and with the installed `ci-channel setup`.

**Cons**:
- `server.ts` is at the top level — mixing MCP server bootstrap with CLI dispatch is a small readability cost.
- If someone ever passes `setup` as a positional somewhere else, we'd need to guard against misrouting (mitigated: `setup` is the only subcommand; nothing else uses positional args).

**Estimated Complexity**: Low
**Risk Level**: Low — additive, the fallback is the existing server code path unchanged.

### Approach 2: Separate `bin/setup.ts` entry point

**Description**: Add a second binary in `package.json`: `ci-channel-setup` → `dist/setup.js`. Keep `server.ts` untouched.

**Pros**:
- Strict separation of concerns — MCP server code and installer code never mix.
- Easier to unit-test in isolation.

**Cons**:
- Users have to remember a second binary name, or we double up entries in `package.json` `bin`.
- `npx ci-channel setup` wouldn't work naturally — it'd need `npx ci-channel-setup` instead, which is uglier and breaks the spec's UX goal.
- More build-time plumbing to wire up a second `dist/` entry point.

**Estimated Complexity**: Medium
**Risk Level**: Low

### Recommended Approach

**Approach 1** — subcommand dispatch at the top of `server.ts`. It matches the UX in the issue (`npx ci-channel setup ...`), keeps the package `bin` map simple, and the dispatch logic is trivial (four or five lines). The readability cost is outweighed by the single-entry-point benefit.

## Subcommand Surface

```
ci-channel                  # run MCP server (existing behavior, unchanged)
ci-channel setup [options]  # interactive installer (new)
```

### `setup` options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--repo OWNER/REPO` | yes (see matrix below) | — | Target repository in `owner/repo` format. |
| `--forge FORGE` | no | `github` | Forge to install for. `gitlab` and `gitea` are not supported by the installer in v1. |
| `--yes`, `-y` | no | false | Skip all confirmation prompts. |
| `--dry-run` | no | false | Print planned actions without executing them. No network calls for mutating ops. |
| `--smee-url URL` | no | — | Use an explicit smee.io channel instead of auto-provisioning a new one. Useful for persistent channels or re-binding an existing channel. |

Flag validation:
- Unknown flags → fail fast with a clear error.
- `--forge` with a value other than `github` → fail fast with the v1-scoping message (see Success Criteria).

### Interactive / non-interactive matrix

The installer's behavior for missing `--repo` depends on TTY state and flags. This is the authoritative matrix:

| TTY stdin? | `--yes`? | `--dry-run`? | `--repo` missing → behavior |
|-----------|----------|--------------|-----------------------------|
| Yes | No | Yes or No | Prompt interactively for the repo. |
| Yes | Yes | Yes or No | Fail fast: `--yes requires --repo`. |
| No | No | Yes or No | Fail fast: `stdin is not a TTY; pass --yes to run non-interactively`. |
| No | Yes | Yes or No | Fail fast: `--yes requires --repo` (non-TTY cannot prompt). |

Rationale: `--yes` means "no prompts allowed". If `--repo` is missing in that mode, there's no valid way to obtain it, so the only safe behavior is to fail fast. `--dry-run` does not relax this — a dry run with no target repo still has nothing to show. Interactive TTY mode without `--yes` is the only case where the installer prompts for the repo.

When `--repo` is present, the other flags behave independently: `--yes` skips confirmation prompts, `--dry-run` skips all mutating ops regardless of prompts.

## Installer Step Sequence

Each step is preceded by an interactive confirmation (unless `--yes`). In `--dry-run` mode, each step prints what it would do and continues without executing.

**Critical ordering invariant**: the webhook reconciliation (steps 6–7) happens **before** the state.json write (step 5 in the numbered list but step 8 in execution order — see below). This is because a fresh webhookSecret must never be persisted to state.json until the corresponding webhook has been created or PATCH-updated. Otherwise, a decline or failure at the webhook step would leave state.json carrying a secret that does not match anything on GitHub, and the next run would (incorrectly) treat the persisted secret as "reused from valid state" and skip the PATCH path entirely — silently breaking HMAC validation. See the `runInstall` comment block in `lib/setup/orchestrator.ts` for the full rationale.

1. **Detect project root** (`findProjectRoot(process.cwd())`). If no root is detected, fail fast with: "Could not locate project root (no `.mcp.json` or `.git/` found walking up from $CWD). Run this from inside the project you want to install into."
2. **Check existing state**: Load `<project-root>/.claude/channels/ci/state.json`. If present and contains `webhookSecret` + `smeeUrl`, remember "state exists — will reuse".
3. **Provision smee channel** (skip if state already has a valid smeeUrl, or if `--smee-url` was passed). Reuses `fetchSmeeChannel()` from `lib/bootstrap.ts`.
4. **Generate webhook secret** (skip if state already has one). Reuses `ensureSecretReal()` from `lib/bootstrap.ts` with `existing = null`.
5. **Write state.json** into `<project-root>/.claude/channels/ci/`. Contains `{ webhookSecret, smeeUrl }`. Uses `saveState(state, path)` from `lib/state.ts` with an explicit project-local path. **Does not write `.env`** — the `.env` file is reserved for user-supplied overrides, and writing auto-provisioned secrets into it would create a two-source-of-truth problem (runtime `loadConfig` reads `.env` first, then falls back to `state.json`). Keeping auto-provisioned secrets in `state.json` only is consistent with how the running plugin already does first-run bootstrap (`lib/bootstrap.ts`).
6. **List existing webhooks** via `gh api --paginate repos/OWNER/REPO/hooks` and check whether any webhook's `config.url` already matches the smee URL. The `--paginate` flag is **required** — default pagination returns only 30 hooks, which would cause false negatives on repos with many hooks. If a match is found, print "Webhook already exists for smee URL $URL — skipping". Otherwise proceed.
7. **Create webhook** via `gh api repos/OWNER/REPO/hooks --method POST --input -` with payload:
   ```json
   {
     "config": { "url": "$SMEE_URL", "content_type": "json", "secret": "$WEBHOOK_SECRET" },
     "events": ["workflow_run"],
     "active": true
   }
   ```
8. **Update `.mcp.json`**: Read `<project-root>/.mcp.json`. The handling matrix is:

   | Current `.mcp.json` state | Behavior |
   |---------------------------|----------|
   | File does not exist | Create with `{ "mcpServers": { "ci": { "command": "npx", "args": ["-y", "ci-channel"] } } }` |
   | File exists, valid JSON, has `mcpServers.ci` | Print "ci server already registered — skipping". Do not modify. |
   | File exists, valid JSON, has `mcpServers` object without `ci` | Merge `ci` into `mcpServers`, preserving all other keys. |
   | File exists, valid JSON, has **no** `mcpServers` key | Add `mcpServers` with just the `ci` entry, preserving all other top-level keys. |
   | File exists, valid JSON, `mcpServers` is not an object (e.g., array, null, string) | **Fail fast** with an error: `.mcp.json has invalid mcpServers (expected object). Fix the file and re-run setup.` Do not modify. |
   | File exists, valid JSON, top-level is not an object (e.g., array) | **Fail fast** with a similar error. |
   | File exists, invalid JSON (parse error) | **Fail fast** with `.mcp.json is not valid JSON: <error message>. Fix the file and re-run setup.` Do not modify. |

   In all fail-fast cases, the installer exits non-zero *before* doing any other write in this step. Steps 1–7 may already have completed (state.json written, webhook created); that is acceptable — a failed `.mcp.json` step leaves a reportable, fixable error.

   When writing, preserve the existing indentation style (detect from the first indented line, default to 2 spaces). Use a round-trip-safe merge: parse → merge → `JSON.stringify(obj, null, indent)` → write.

9. **Print next steps**: Tell the user the install is complete and to launch (or relaunch) Claude Code with `claude --dangerously-load-development-channels server:ci`. If `.mcp.json` was newly created or modified, remind them about the "project-scoped servers need explicit approval" gotcha from INSTALL.md.

## Idempotency Rules

The installer has two overlapping concepts: **reuse** (re-run on existing state, leave it alone) and **override** (CLI flag explicitly supplies a different value). The rules:

| Condition | Behavior |
|-----------|----------|
| `state.json` exists with valid `webhookSecret` + `smeeUrl`, no overriding CLI flags | **Reuse**; skip steps 3–5. |
| `state.json` missing or incomplete, no overriding CLI flags | Run steps 3–5 to auto-provision. |
| `--smee-url URL` passed, state.json has no smeeUrl | Use the CLI-provided URL, write it into state.json. No override — the stored value was absent. |
| `--smee-url URL` passed, state.json has a **matching** smeeUrl | No-op for smeeUrl; continue with webhook idempotency on the matching URL. |
| `--smee-url URL` passed, state.json has a **different** smeeUrl | **Explicit override**: honor the CLI value, update state.json to the new URL, and proceed with webhook creation for the new URL. This *will* create a new webhook (the existing webhook for the old URL is left in place — not deleted). The webhook secret is **not** regenerated; the installer reuses the existing `webhookSecret` from state.json for the new webhook. Emit a warning: `Overriding smeeUrl in state.json (old: ..., new: ...). Existing webhook for the old URL is left in place; delete it manually if no longer needed.` |
| Webhook already exists for our smee URL (any condition) | **Always PATCH** the existing hook via `gh api --method PATCH repos/{repo}/hooks/{id}` with the canonical ci-channel config (url, content_type=json, secret, insecure_ssl=0, events=['workflow_run'], active=true). There is NO skip path. See the "webhook reconciliation model" note below for the rationale. |
| Multiple webhooks point at our smee URL (user has duplicates) | Warn the user with a count and the first hook's id. PATCH only the first; leave the duplicates untouched (user should delete them manually). |
| Webhook exists for a *different* smee URL | Ignore it; proceed with step 7 (user may have multiple relays). Do not delete any existing webhook. |

**Webhook reconciliation model**: After four PR-review iterations finding silent-failure modes in the skip path (secret-not-rotated when state deleted; state-persisted-before-webhook race; URL-mismatch skip; active=false/wrong-events/wrong-content_type skip), the skip path was removed entirely in iter5. The installer now always PATCHes an existing hook with the canonical ci-channel config whenever a matching URL is found. The cost is one extra API call per re-run; the benefit is eliminating an entire class of bug by construction.

**Webhook payload audit** (canonical shape sent in both CREATE and PATCH):

| Field | Value | Rationale |
|-------|-------|-----------|
| `config.url` | expectedSmeeUrl | Destination — must match runtime's webhook endpoint |
| `config.content_type` | `"json"` | Signature validation depends on JSON body encoding |
| `config.secret` | state.webhookSecret | HMAC key. Write-only on GitHub — cannot read-and-compare |
| `config.insecure_ssl` | `"0"` | Strict TLS. Set explicitly to avoid GitHub's ambiguous config-replace semantics |
| `events` | `["workflow_run"]` | The only event ci-channel handles. Installer owns the hook; user additions are intentionally clobbered |
| `active` | `true` | Disabled hook = no events delivered |
| `name` | (not set) | Read-only on PATCH, GitHub always uses `"web"` |
| `add_events` / `remove_events` | (not set) | We use `events` for auditability (exact set after PATCH) |
| `config.token`, `config.digest` | (not set) | Unused auth mode / deprecated field |
| `.mcp.json` exists with `mcpServers.ci` entry | Skip step 8. Warn the user the entry is already present (show the current value). |
| `.mcp.json` exists without `mcpServers.ci` | Merge a new entry in, preserving all other servers. |
| `.mcp.json` does not exist | Create it with just the `ci` entry. |

**No destructive operations.** The installer never deletes, overwrites, or rotates any secret automatically. The one user-driven exception is `--smee-url` override, which replaces the stored `smeeUrl` but reuses the existing `webhookSecret`. Rotation (`--rotate`) is out of scope for v1 — users who want to rotate must manually delete state.json and the old webhook, then re-run `setup`.

## Open Questions

### Critical (Blocks Progress)
- [x] Entry point strategy → Subcommand dispatch in `server.ts` (Approach 1).
- [x] Prompt library → `@inquirer/prompts`.

### Important (Affects Design)
- [x] Where to write state → `<project-root>/.claude/channels/ci/state.json` using existing `saveState` helper with explicit path.
- [x] How to call GitHub API → Shell out to `gh api` (inherits user auth, matches existing INSTALL.md flow).
- [x] `.mcp.json` merge behavior → JSON read-modify-write with indentation preserved (use 2-space indent default; read existing file to detect if we should match).

### Nice-to-Know (Optimization)
- [ ] Should we offer a `--rotate` flag to regenerate secrets and update an existing webhook? Out of scope for v1.
- [ ] Should we prompt to install `gh` if missing? Out of scope — document the prerequisite and fail fast if absent.
- [ ] Should the setup subcommand be colorized? Nice-to-have but not required; `@inquirer/prompts` handles its own styling.

## Performance Requirements

Not performance-sensitive. The installer runs once per project. Target: entire install completes in under 10 seconds on a fast connection (dominated by smee.io fetch and `gh api` round-trips).

## Security Considerations

- **Webhook secret** is generated via `crypto.randomBytes(32)` (256 bits of entropy) — same mechanism as the existing bootstrap.
- **state.json file permissions**: written with `chmod 600` (owner read/write only) because it contains the webhook secret. The directory `.claude/channels/ci/` should be in `.gitignore` already at the project level; the installer does not modify `.gitignore`. (If the user doesn't have it gitignored, that's a pre-existing concern not introduced by this feature — but the installer prints a warning if `.claude/channels/ci/` is not in any ancestor `.gitignore`.)
- **`.env` is not written** by the installer. The `.env` file remains a user-managed override mechanism — no installer-generated secrets live there.
- **`gh` auth**: the installer relies on the user's already-authenticated `gh` token. It does not store, transmit, or log the token.
- **Webhook URL**: the smee.io URL is the primary secret-protection mechanism — the secret is also sent in the webhook config, and the plugin validates signatures on every incoming webhook.
- **No token logging**: the installer never prints the webhook secret to stdout in plain form (only to state.json and to the `gh api` stdin pipe / temp-file payload). Dry-run mode is explicit: it prints `[redacted]` in place of the secret.
- **`gh` payload delivery**: if the temp-file approach is used instead of stdin piping, the temp file must (a) be created with `mode 0600`, (b) live inside `os.tmpdir()`, (c) be deleted in a `finally` block regardless of `gh` success/failure.
- **Input validation**: `--repo` must match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`. Reject any other value before passing to `gh`. Same regex applies to interactively-prompted input.

## Test Scenarios

### Functional Tests

1. **Happy path (mocked)**: `setup --repo owner/repo --yes` on a fresh project → state.json (with `webhookSecret` + `smeeUrl`, `chmod 600`) and `.mcp.json` created; `gh api hooks POST` invoked once with correct payload. No `.env` is written.
2. **Idempotent re-run (mocked)**: Run setup twice. Second run detects existing state, detects existing webhook, detects existing `.mcp.json` entry, and exits cleanly without mutating anything.
3. **Existing `.mcp.json` with other servers**: `.mcp.json` already has `mcpServers.other-server` → setup merges in `ci` without disturbing `other-server`.
4. **Existing `.mcp.json` with ci entry**: `.mcp.json` already has `mcpServers.ci` → setup warns and leaves `.mcp.json` unchanged.
5. **Dry-run**: `setup --repo owner/repo --dry-run --yes` → no files written, no smee.io provisioning, no `gh api POST`/`PATCH`. Read-only `gh api --paginate --slurp repos/{repo}/hooks` IS called (it's not mutating, and the result makes the preview accurate). Prints all planned actions.
6. **Missing `--repo` + `--yes`**: `setup --yes` → fail fast with `--yes requires --repo`.
7. **Missing `--repo` + non-TTY**: simulate `!process.stdin.isTTY` + no `--yes` → fail fast with TTY error.
8. **Missing `--repo` + TTY + no `--yes`**: interactive test → prompts for the repo value.
9. **Non-GitHub forge**: `setup --repo owner/repo --forge gitlab` → fail fast with the v1-scoping message (explicitly contains "MCP server itself supports all three forges").
10. **No project root**: Run from `/tmp` → fail fast with "could not locate project root".
11. **Running from a subdirectory**: Run setup from `<project>/src/foo/` → detects project root correctly.
12. **Webhook already exists for our smee URL**: Mock `gh api --paginate /hooks` to return a hook whose `config.url` matches the smee URL → setup skips webhook creation.
13. **Webhook pagination**: Mock `gh api --paginate` to return many pages where the matching hook is on a later page → idempotency check still finds it.
14. **Webhook POST failure**: Mock `gh api POST` to fail → setup exits non-zero with the `gh` stderr surfaced.
15. **`--smee-url` override diverges from state**: State has URL A; user passes `--smee-url B` → setup updates state.json to B, reuses existing webhookSecret, creates a new webhook for B, prints the "old webhook left in place" warning.
16. **`--smee-url` matches state**: State has URL A; user passes `--smee-url A` → no-op for state.json; webhook idempotency check runs as normal.
17. **Invalid `--repo` format**: `setup --repo 'bad"value'` → rejected before invoking `gh`.
18. **Interactive confirmation flow (integration)**: Programmatic test injecting `y` answers to each prompt; verifies the sequence of prompts.
19. **Interactive decline**: User declines a prompt (e.g., "Create webhook? n") → setup exits cleanly without running that step or subsequent steps, prints partial-install guidance.
20. **`.mcp.json` malformed JSON**: Pre-existing `.mcp.json` is invalid JSON → fail fast with a parse-error message. State.json and webhook (already created in steps 1–7) are left as-is.
21. **`.mcp.json` has top-level array**: `[]` at top level → fail fast with a "not an object" error.
22. **`.mcp.json` has `mcpServers` as a string/null/array**: Fail fast.
23. **`.mcp.json` with other servers preserved**: `.mcp.json` already has `mcpServers.other` → setup merges in `ci` without disturbing `other`.
24. **`state.json` malformed**: Pre-existing `state.json` is invalid JSON → `loadState` returns `{}` (existing behavior); installer treats it as missing and runs steps 3–5 as if fresh.
25. **Missing `gh` binary**: `gh` not found on PATH → fail fast with `gh CLI not found. Install from https://cli.github.com/ and run 'gh auth login'.`
26. **Legacy global state ignored**: `~/.claude/channels/ci/state.json` exists with different values → setup does NOT read or migrate it; always uses the project-local path. Emit a one-line informational note (`Note: legacy global state at ~/.claude/channels/ci/state.json is not used by setup — install is project-scoped.`) only if the global state actually exists.
27. **Existing tests**: All 170 pre-existing tests continue to pass with no modification.

### Non-Functional Tests
1. **No subprocess leaks**: Ensure any `gh` subprocesses are properly awaited and their stdio closed (reuse the `stdin: 'ignore'` pattern).
2. **No MCP-server regression**: `node server.ts` (no args) still boots the MCP server identically. A smoke test or at minimum the existing server integration tests confirm this.

### Fixture Requirements
- Mock `gh api` response fixtures for: list-hooks (empty), list-hooks (with matching hook), list-hooks (with unrelated hook), create-hook success, create-hook failure (403 / 404).
- Stub `fetchSmeeChannel` to return a deterministic URL without hitting the network.
- Use a temporary directory as the project root in each test.

## Dependencies

- **New runtime dependency**: `@inquirer/prompts` (latest stable, ESM).
- **Existing runtime dependency reused**: `smee-client` (already present — for channel provisioning via `fetchSmeeChannel`).
- **External tools**: `gh` CLI (GitHub). Same assumption as the existing INSTALL.md flow.
- **No changes**: MCP SDK, TypeScript version, engine constraints.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Subcommand dispatch accidentally swallows server-mode args | Low | High | Dispatch only triggers on exact match `process.argv[2] === 'setup'`. Everything else → server. Covered by existing server integration tests. |
| `.mcp.json` edit corrupts existing servers | Low | High | Read-modify-write with a round-trip test (parse, merge, stringify, re-parse equality check). Unit tests cover every merge branch. |
| `gh api` payload format changes or rejects | Low | Medium | Follow the documented shape in `INSTALL.md` step 4, which is known to work. Surface errors verbatim. |
| `@inquirer/prompts` pulls in heavy deps or is incompatible with ESM-only package | Low | Low | Verified before implementation — `@inquirer/prompts` is designed for ESM, maintained by the Inquirer team, no heavy deps. |
| Users run `setup` inside a wrong directory (parent of the project they meant) | Medium | Medium | `findProjectRoot` walks upward, so "wrong directory" usually means too-deep (correct) or outside any project (fails fast). Show the detected project root before the first mutating action and require confirmation unless `--yes`. |
| Existing webhook idempotency check mis-identifies an unrelated hook | Low | Low | Match strictly on `config.url` exact string equality. |
| Rotating secrets later (v2 `--rotate`) conflicts with the current design | Low | Low | Out of scope; the current layout doesn't preclude adding rotation later. |

## Documentation Requirements

- **README.md**: Replace the multi-step install block with a single `npx ci-channel setup --repo owner/repo` command. Link to INSTALL.md for the manual fallback.
- **INSTALL.md**: Lead with the `setup` subcommand as the primary, recommended flow. Keep the existing five-step manual flow as a secondary section titled "Manual install (advanced / troubleshooting)".
- **AGENTS.md**: Update the "how to install ci-channel" section to recommend `setup` (the AI agent that couldn't previously automate the install can now use `setup --yes`).
- **CLAUDE.md**: Update the "Development" section to mention the new subcommand and where its source lives.

## References

- **Spec 0**: `codev/specs/0-ci-channel-plugin.md` — original plugin spec with the webhook/bootstrap model.
- **Spec 1**: `codev/specs/1-feat-multi-forge-support-githu.md` — multi-forge refactor that created `lib/forge.ts` and the existing bootstrap module. This spec extends the installer but does not touch the forge abstraction.
- **`INSTALL.md`** — the current five-step flow this feature replaces.
- **`lib/bootstrap.ts`** — source of truth for `fetchSmeeChannel` and `ensureSecretReal`, both reused verbatim by the installer.
- **`lib/project-root.ts`** — `findProjectRoot` helper, reused.
- **`lib/state.ts`** — `saveState`/`loadState`, reused with an explicit path argument.
- **`@inquirer/prompts` docs** — https://www.npmjs.com/package/@inquirer/prompts

## Notes

- This feature is a pure addition on top of the existing plugin — it doesn't change how the MCP server runs, what events it accepts, or the notification format. It only changes the *install UX*.
- Once `setup` exists, the `setup` flow itself becomes the thing that should be tested end-to-end on cluesmith/ci-channel (follow-up work — can re-use the E2E validation requirement from Spec 1).
- The `--rotate` flag is explicitly deferred. If a user needs to rotate the webhook secret today, they can delete the webhook, delete state.json, and re-run `setup`. That's acceptable manual effort for v1.

## Expert Consultation

**Date**: 2026-04-10
**Models Consulted**: Codex (GPT-5), Gemini Pro, Claude (Opus)

**Codex verdict**: REQUEST_CHANGES (HIGH confidence)
**Gemini verdict**: APPROVE (HIGH confidence)
**Claude verdict**: COMMENT (HIGH confidence)

**Key feedback addressed (iteration 1)**:

- **`.env` ownership conflict** (Codex, Claude): Removed `.env` writes entirely. Installer now writes only `state.json`; `.env` remains a user-managed override. Runtime `loadConfig` already reads state.json as a fallback, so this is consistent with the existing model. Added clarifying question #5 and security note.
- **Non-interactive flag semantics** (Codex): Added the Interactive / non-interactive matrix specifying exact behavior for every combination of TTY, `--yes`, `--dry-run`, and missing `--repo`.
- **Idempotency vs `--smee-url` override** (Codex, Claude): Added explicit override rules. `--smee-url` that differs from stored state is the one user-driven exception to "no overwrites", and its full semantics (secret reuse, new webhook creation, old webhook preserved) are spelled out.
- **`.mcp.json` malformed handling** (Codex): Added explicit fail-fast matrix for all `.mcp.json` shapes (missing, valid-with-ci, valid-without-mcpServers, non-object mcpServers, non-object top-level, invalid JSON).
- **Legacy global state** (Codex): Added clarifying question #11 — installer never reads, migrates, or touches global state. Added test scenario 26.
- **`stdin: 'ignore'` contradicts `--input -`** (Gemini, Claude): Replaced hard rule with a nuanced constraint explaining the invariant (don't inherit `process.stdin`), allowing either a dedicated pipe or temp-file approach.
- **Dynamic import of setup module** (Gemini): Added constraint requiring `await import('./lib/setup/index.js')` to avoid loading installer-only deps during MCP server startup.
- **TTY handling** (Claude): Added clarifying question #10 plus success criterion and the full interactive matrix.
- **Forge messaging** (Claude): Corrected "not yet implemented" wording to reflect that the MCP server supports all three forges — only the installer is GitHub-only in v1.
- **Webhook pagination** (Claude): Step 6 and constraints now require `gh api --paginate`, and test scenario 13 explicitly covers multi-page results.
- **`ensureSecretReal` path parameter** (Claude): Added to technical constraints — plan phase must resolve how the installer passes an explicit project-local state path (either cwd-alignment or helper overload). `saveState`/`loadState` already accept explicit paths.
- **`lib/setup/` vs flat layout** (Claude): Added one-line justification in technical constraints.
- **state.json `chmod 600`** (Claude): Explicit file-mode requirement added to security section.
- **Missing `gh` binary test** (Codex): Added test scenario 25.
- **`state.json` malformed test** (Codex): Added test scenario 24.
