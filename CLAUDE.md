# ci-channel - Claude Code Instructions

## Project Overview

A Claude Code channel plugin that delivers real-time CI/CD notifications into running Claude Code sessions. Supports GitHub Actions, GitLab CI, and Gitea Actions. Built with the MCP (Model Context Protocol) SDK.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point + `setup` subcommand dispatch (HTTP server, bootstrap, smee in-process, reconciliation)
- `lib/forge.ts` — Forge interface definition (strategy pattern for multi-forge support)
- `lib/forges/github.ts` — GitHub Actions forge (HMAC-SHA256, workflow_run, gh CLI)
- `lib/forges/gitlab.ts` — GitLab CI forge (token validation, Pipeline Hook, glab CLI)
- `lib/forges/gitea.ts` — Gitea Actions forge (HMAC-SHA256, workflow_run, fetch API)
- `lib/config.ts` — Configuration loading (CLI args + env vars + .env file)
- `lib/bootstrap.ts` — First-run auto-provisioning (secret generation, smee channel, setup notification)
- `lib/handler.ts` — Webhook handler pipeline (validate → dedup → filter → notify)
- `lib/webhook.ts` — WebhookEvent interface, deduplication, filtering (forge-agnostic)
- `lib/notify.ts` — Notification formatting and input sanitization
- `lib/reconcile.ts` — Startup reconciliation orchestration
- `lib/setup/` — Interactive installer (`ci-channel setup` subcommand): arg parsing (`args.ts`), project detection (`project.ts`), state.json read/write with chmod 0o600 (`state.ts`), `.mcp.json` merger with 7-shape fail-fast matrix (`mcp-json.ts`), `gh` CLI wrapper (`gh.ts`), `.gitignore` ancestor check (`gitignore.ts`), `@inquirer/prompts` wrapper (`io.ts`), and orchestrator with confirmation prompts before every mutating step (`orchestrator.ts`)

## Configuration

Structural config via CLI args in `.mcp.json`, secrets in `~/.claude/channels/ci/.env`.

**CLI args**: `--forge`, `--repos`, `--workflow-filter`, `--reconcile-branches`, `--port`, `--gitea-url`, `--smee-url`

**Secrets**: `WEBHOOK_SECRET` (auto-generated), `GITEA_TOKEN`

**Precedence**: CLI args > env vars > `.env` file

## Key Locations

- **Specs**: `codev/specs/` — Feature specifications (WHAT to build)
- **Plans**: `codev/plans/` — Implementation plans (HOW to build)
- **Reviews**: `codev/reviews/` — Post-implementation reviews
- **Architecture**: `codev/resources/arch.md` — System architecture
- **Lessons Learned**: `codev/resources/lessons-learned.md` — Extracted insights

## Development

```bash
npm install                                             # Install dependencies
npm test                                                # Run all tests (291 tests across 15 files)
npx tsx server.ts                                       # Start the server
npx tsx server.ts setup --repo owner/repo --dry-run     # Dry-run the installer
```

The `setup` subcommand source lives under `lib/setup/`. Dispatch happens at the top of `server.ts` after imports but before `loadConfig()`, via a dynamic `import('./lib/setup/index.js')` so installer-only dependencies (`@inquirer/prompts`) don't load on the server path.

## Codev Workflow

For new features, create three documents per feature:
1. Specification: `codev/specs/{n}-feature-name.md`
2. Plan: `codev/plans/{n}-feature-name.md`
3. Review: `codev/reviews/{n}-feature-name.md`

### CLI Commands

Codev provides three CLI tools:
- **codev**: Project management (init, adopt, update, doctor)
- **afx**: Agent Farm orchestration (spawn, status, cleanup)
- **consult**: AI consultation for reviews

## Git Workflow

**NEVER use `git add -A` or `git add .`** — Always add files explicitly.

Commit message format:
```
[Spec 1] Description of change
[Spec 1][Phase: implement] feat: Add feature
```

## Critical Patterns

- **MCP stdio isolation**: Subprocesses spawned by the running MCP server must not inherit `process.stdin` (or they'd steal bytes from the JSON-RPC stream). Default pattern: `stdin: 'ignore'`. Exception: the `ci-channel setup` installer's `gh api --input -` call uses `stdio: ['pipe', 'pipe', 'pipe']` to pipe a JSON payload — this also satisfies the invariant since the child gets a dedicated pipe rather than the parent's stdin. The rule is "don't inherit `process.stdin`", not literally "`stdin: 'ignore'` everywhere". See `codev/resources/lessons-learned.md`.
- **Sanitize at the boundary**: All user-controlled input (commit messages, branch names) must be sanitized in `notify.ts` before reaching MCP.
- **Never block on enrichment**: Job-detail enrichment is fire-and-forget, never blocks the primary notification.
- **Forge strategy pattern**: All forge-specific behavior (signature validation, event parsing, reconciliation, enrichment) goes in `lib/forges/`. The handler and reconciler are forge-agnostic.
- **Bootstrap auto-provisioning**: Secret and smee channel are auto-generated on first run. Setup instructions pushed via channel notification.
