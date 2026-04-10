# ci-channel - AI Agent Instructions

> **Note**: This file follows the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. A Claude Code-specific version is maintained in `CLAUDE.md`.

## Project Overview

A Claude Code channel plugin that delivers real-time GitHub Actions, GitLab CI, and Gitea Actions CI/CD notifications into running Claude Code sessions. Built with the MCP (Model Context Protocol) SDK.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Installing into a target project (agents)

For agents driving a ci-channel install into a fresh GitHub project, use the one-shot installer:

```bash
npx ci-channel setup --yes --repo OWNER/REPO
```

This replaces the legacy five-step manual flow with a single command that creates the webhook, writes project-local state, and updates `.mcp.json` idempotently. `--yes` skips all confirmation prompts so the command is safe to run non-interactively. The installer requires `gh` CLI authenticated with the `admin:repo_hook` scope.

For GitLab, Gitea, or installs where `gh` is unavailable, fall back to the manual five-step flow in [INSTALL.md](./INSTALL.md).

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point + `setup` subcommand dispatch
- `lib/config.ts` — Configuration loading
- `lib/handler.ts` — Webhook handler pipeline
- `lib/webhook.ts` — Signature validation, event parsing, deduplication
- `lib/notify.ts` — Notification formatting and sanitization
- `lib/reconcile.ts` — Startup reconciliation and job enrichment
- `lib/setup/` — Interactive installer (`ci-channel setup` subcommand): arg parsing, project detection, `.mcp.json` merger, `gh` wrapper, orchestrator, `@inquirer/prompts` wrapper

## Key Locations

- **Specs**: `codev/specs/` — Feature specifications (WHAT to build)
- **Plans**: `codev/plans/` — Implementation plans (HOW to build)
- **Reviews**: `codev/reviews/` — Post-implementation reviews
- **Architecture**: `codev/resources/arch.md` — System architecture
- **Lessons Learned**: `codev/resources/lessons-learned.md` — Extracted insights

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests
npx tsx server.ts    # Start the server (requires WEBHOOK_SECRET)
```

## Codev Workflow

For new features, create three documents per feature:
1. Specification: `codev/specs/{n}-feature-name.md`
2. Plan: `codev/plans/{n}-feature-name.md`
3. Review: `codev/reviews/{n}-feature-name.md`

## Git Workflow

**NEVER use `git add -A` or `git add .`** — Always add files explicitly.

## Critical Patterns

- **MCP stdio isolation**: Subprocesses spawned by the running MCP server must not inherit `process.stdin` — the default pattern is `stdin: 'ignore'`. The `ci-channel setup` installer (`lib/setup/gh.ts`) uses `stdio: ['pipe', 'pipe', 'pipe']` when it needs to pipe a JSON payload to `gh api --input -`, which also satisfies the invariant (the child gets a dedicated pipe, not the parent's stdin). The rule is "don't inherit `process.stdin`", not literally "`stdin: 'ignore'`".
- **Sanitize at the boundary**: All user-controlled input sanitized before reaching MCP
- **Never block on enrichment**: Job-detail enrichment is fire-and-forget
- **Fail fast**: Missing required config throws immediately, no fallbacks
