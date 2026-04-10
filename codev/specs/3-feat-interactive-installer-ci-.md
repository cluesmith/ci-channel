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
5. **Q**: Where does the installer write state? **A**: Into the detected project root: `<project-root>/.claude/channels/ci/state.json` and `<project-root>/.claude/channels/ci/.env`. Project detection reuses `findProjectRoot()` (`.mcp.json` or `.git/`).
6. **Q**: Should the installer modify `.mcp.json`? **A**: Yes, but idempotently — only insert the `ci` server entry if it isn't already present. If present, warn and skip.
7. **Q**: What happens when re-running on an already-configured project? **A**: The installer is idempotent. It detects existing state.json, reuses the smee URL + secret, and skips webhook creation if a webhook already exists for that smee URL.
8. **Q**: What about rotation? **A**: Out of scope for v1. Re-running is safe but does not rotate. A `--rotate` flag is mentioned in the issue as future work — not implemented here.
9. **Q**: Should it authenticate as the user or require `gh` to already be authenticated? **A**: Require `gh` authenticated. The installer shells out to `gh api` and surfaces the error if auth is missing. It does not attempt to run `gh auth login`.

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
3. **Write state.json and .env** into `<project-root>/.claude/channels/ci/`.
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
- [ ] Interactive mode prompts before each side-effecting step (smee provisioning, state write, `.env` write, webhook POST, `.mcp.json` edit).
- [ ] `--yes` flag suppresses all prompts.
- [ ] `--dry-run` prints each planned action without executing it and does not make any network calls for mutating operations (smee fetch and webhook POST are skipped).
- [ ] `--forge github` (or default) works; `--forge gitlab` and `--forge gitea` fail fast with a clear "not yet implemented" error.
- [ ] Idempotency: re-running the installer on an already-configured project does not create a duplicate webhook, does not overwrite a valid state.json, and does not duplicate the `ci` entry in `.mcp.json`.
- [ ] `gh` not authenticated → installer surfaces the `gh api` error and exits non-zero with a clear message telling the user to run `gh auth login`.
- [ ] Works from **any subdirectory** of the target project (not just the root) — `findProjectRoot` locates the project root.
- [ ] Works regardless of whether ci-channel is installed from source, from npm, or run via `npx ci-channel setup`.
- [ ] Unit tests cover the state-file, `.mcp.json` update, and webhook-creation logic with mocks for `gh` and filesystem.
- [ ] Existing 170 tests continue to pass (no regression).
- [ ] README.md and INSTALL.md updated to recommend `setup` as the primary installation method.

## Constraints

### Technical Constraints
- Must reuse existing project-detection, state-persistence, and secret-generation code from `lib/` (no copy-paste; share the real implementations).
- Must preserve the existing default behavior: invoking `ci-channel` with no args (or with server-mode args like `--forge`, `--repos`) still runs the MCP server. Subcommand dispatch must not break `.mcp.json` entries like `{"command":"npx","args":["-y","ci-channel","--forge","gitlab"]}`.
- Must not require network access in `--dry-run` mode. `--dry-run` must not POST to smee.io, GitHub, or anywhere else.
- Webhook creation goes through `gh` CLI (spawned subprocess). Do not call the GitHub REST API directly — reusing `gh` inherits the user's auth setup.
- All subprocess calls must use `stdin: 'ignore'` (MCP stdio isolation pattern; see `codev/resources/lessons-learned.md`). Although `setup` itself doesn't share stdio with an MCP client, keeping the pattern consistent avoids accidents if the subcommand is ever invoked from inside a running MCP server.
- `@inquirer/prompts` must be added as a runtime dependency. It is ESM-only and small (no heavy transitive deps).
- No new transitive surface area: avoid bringing in commander, yargs, or oclif. Reuse the existing `process.argv` iteration pattern from `lib/config.ts` (or a minimal ad-hoc parser) for subcommand/flag parsing.
- TypeScript: subcommand source files live under `lib/setup/` and are compiled as part of the existing `tsc` build. No separate build target.

### Business Constraints
- GitHub-only in v1. Do not block the feature on GitLab/Gitea parity.
- Must not break existing installs — users already set up via the five-step flow must still work without change.
- The old manual flow must remain documented as a fallback in INSTALL.md. It's the "source of truth" reference for understanding what `setup` is automating.

## Assumptions

- Users running `ci-channel setup` for GitHub have the `gh` CLI installed and authenticated (`gh auth status` succeeds). The installer does not attempt to install or authenticate `gh`.
- Users have `admin:repo_hook` scope on their `gh` token (required by GitHub to create webhooks). If missing, `gh api hooks POST` returns 404/403; the installer surfaces that error verbatim with a hint about the required scope.
- `smee.io` is reachable from the user's network. This is already a hard requirement of the runtime plugin; reusing it here doesn't add new risk. If smee.io is down or blocked, `--dry-run` still works (doesn't hit the network) and non-dry-run fails fast with a clear error.
- The target repo exists and the user has admin access to it (required to create webhooks). Failures here are reported verbatim via `gh` error text.
- Node.js v20+ (same engine constraint as the rest of the package).
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
| `--repo OWNER/REPO` | yes (for GitHub) | — | Target repository in `owner/repo` format. |
| `--forge FORGE` | no | `github` | Forge to install for. `gitlab` and `gitea` reserved for future work; fail fast if passed. |
| `--yes`, `-y` | no | false | Skip all confirmation prompts. |
| `--dry-run` | no | false | Print planned actions without executing them. No network calls for mutating ops. |
| `--smee-url URL` | no | — | Use an explicit smee.io channel instead of auto-provisioning a new one. Useful for persistent channels or re-binding an existing channel. |

Flag validation:
- Unknown flags → fail fast with a clear error.
- `--repo` missing → fail fast with a usage error (unless `--dry-run` is set, in which case prompt for it interactively).
- `--forge` with a value other than `github` → fail fast with "not yet implemented" message.

## Installer Step Sequence

Each step is preceded by an interactive confirmation (unless `--yes`). In `--dry-run` mode, each step prints what it would do and continues without executing.

1. **Detect project root** (`findProjectRoot(process.cwd())`). If no root is detected, fail fast with: "Could not locate project root (no `.mcp.json` or `.git/` found walking up from $CWD). Run this from inside the project you want to install into."
2. **Check existing state**: Load `<project-root>/.claude/channels/ci/state.json`. If present and contains `webhookSecret` + `smeeUrl`, remember "state exists — will reuse".
3. **Provision smee channel** (skip if state already has a valid smeeUrl, or if `--smee-url` was passed). Reuses `fetchSmeeChannel()` from `lib/bootstrap.ts`.
4. **Generate webhook secret** (skip if state already has one). Reuses `ensureSecretReal()` from `lib/bootstrap.ts` with `existing = null`.
5. **Write state.json and .env** into `<project-root>/.claude/channels/ci/`. state.json contains `{ webhookSecret, smeeUrl }`; `.env` contains `WEBHOOK_SECRET=...` (and forge-specific secrets if applicable). Uses `saveState` from `lib/state.ts`.
6. **List existing webhooks** via `gh api repos/OWNER/REPO/hooks` and check whether any webhook's `config.url` already matches the smee URL. If found, print "Webhook already exists for smee URL $URL — skipping". Otherwise proceed.
7. **Create webhook** via `gh api repos/OWNER/REPO/hooks --method POST --input -` with payload:
   ```json
   {
     "config": { "url": "$SMEE_URL", "content_type": "json", "secret": "$WEBHOOK_SECRET" },
     "events": ["workflow_run"],
     "active": true
   }
   ```
8. **Update `.mcp.json`**: Read `<project-root>/.mcp.json`. If it doesn't exist, create it with `{ "mcpServers": { "ci": { "command": "npx", "args": ["-y", "ci-channel"] } } }`. If it exists but has no `mcpServers.ci`, merge the `ci` entry in. If `mcpServers.ci` already exists, print "ci server already registered in .mcp.json — skipping" and do not modify it.
9. **Print next steps**: Tell the user the install is complete and to launch (or relaunch) Claude Code with `claude --dangerously-load-development-channels server:ci`. If `.mcp.json` was newly created or modified, remind them about the "project-scoped servers need explicit approval" gotcha from INSTALL.md.

## Idempotency Rules

| Condition | Behavior |
|-----------|----------|
| `state.json` exists with valid `webhookSecret` + `smeeUrl` | Reuse; skip steps 3–5. |
| `state.json` missing or incomplete | Run steps 3–5. |
| Webhook already exists for our smee URL | Skip step 7. |
| Webhook exists for a *different* smee URL | Ignore it; proceed with step 7 (user may have multiple relays). Do not delete any existing webhook. |
| `.mcp.json` exists with `mcpServers.ci` entry | Skip step 8. Warn the user the entry is already present (show the current value). |
| `.mcp.json` exists without `mcpServers.ci` | Merge a new entry in, preserving all other servers. |
| `.mcp.json` does not exist | Create it with just the `ci` entry. |

No destructive operations. The installer never deletes, overwrites, or rotates any credentials or configuration.

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
- **`.env` file permissions**: written with default permissions. The directory `.claude/channels/ci/` should be in `.gitignore` already at the project level; the installer does not modify `.gitignore`. (If the user doesn't have it gitignored, that's a pre-existing concern not introduced by this feature.)
- **`gh` auth**: the installer relies on the user's already-authenticated `gh` token. It does not store, transmit, or log the token.
- **Webhook URL**: the smee.io URL is the primary secret-protection mechanism — the secret is also sent in the webhook config, and the plugin validates signatures on every incoming webhook.
- **No token logging**: the installer never prints the webhook secret to stdout in plain form (only to the `.env` file and to the `gh api` stdin payload). Dry-run mode is explicit: it prints `[redacted]` in place of the secret.
- **Input validation**: `--repo` must match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`. Reject any other value before passing to `gh`.

## Test Scenarios

### Functional Tests

1. **Happy path (mocked)**: `setup --repo owner/repo --yes` on a fresh project → state.json, `.env`, and `.mcp.json` created; `gh api hooks POST` invoked once with correct payload.
2. **Idempotent re-run (mocked)**: Run setup twice. Second run detects existing state, detects existing webhook, detects existing `.mcp.json` entry, and exits cleanly without mutating anything.
3. **Existing `.mcp.json` with other servers**: `.mcp.json` already has `mcpServers.other-server` → setup merges in `ci` without disturbing `other-server`.
4. **Existing `.mcp.json` with ci entry**: `.mcp.json` already has `mcpServers.ci` → setup warns and leaves `.mcp.json` unchanged.
5. **Dry-run**: `setup --repo owner/repo --dry-run --yes` → no files written, no network calls for smee or `gh api POST`, prints all planned actions.
6. **Missing `--repo`**: `setup --yes` → fail fast with a usage error.
7. **Non-GitHub forge**: `setup --repo owner/repo --forge gitlab` → fail fast with "not yet implemented".
8. **No project root**: Run from `/tmp` → fail fast with "could not locate project root".
9. **Running from a subdirectory**: Run setup from `<project>/src/foo/` → detects project root correctly.
10. **Webhook already exists for our smee URL**: Mock `gh api /hooks` to return a hook whose `config.url` matches the smee URL → setup skips webhook creation.
11. **Webhook POST failure**: Mock `gh api POST` to fail → setup exits non-zero with the `gh` stderr surfaced.
12. **Existing state.json with `--smee-url`**: User passes explicit `--smee-url` that differs from stored state → setup honors the CLI arg and updates state.json.
13. **Invalid `--repo` format**: `setup --repo 'bad"value'` → rejected before invoking `gh`.
14. **Interactive confirmation flow (integration)**: Programmatic test injecting `y` answers to each prompt; verifies the sequence of prompts.
15. **Interactive decline**: User declines a prompt (e.g., "Create webhook? n") → setup exits cleanly without running that step or subsequent steps, prints partial-install guidance.
16. **Existing tests**: All 170 pre-existing tests continue to pass with no modification.

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
