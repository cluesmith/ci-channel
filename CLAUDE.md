# ci-channel - Claude Code Instructions

## Project Overview

A Claude Code channel plugin that delivers real-time CI/CD notifications into running Claude Code sessions. Supports GitHub Actions, GitLab CI, and Gitea Actions. Built with the MCP (Model Context Protocol) SDK.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point (HTTP server, bootstrap, smee in-process, reconciliation)
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
npm install          # Install dependencies
npm test             # Run all tests (170 tests across 11 files)
npx tsx server.ts    # Start the server
```

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

- **MCP stdio isolation**: All subprocess calls must use `stdin: 'ignore'` to prevent consuming MCP stdin bytes. See `codev/resources/lessons-learned.md`.
- **Sanitize at the boundary**: All user-controlled input (commit messages, branch names) must be sanitized in `notify.ts` before reaching MCP.
- **Never block on enrichment**: Job-detail enrichment is fire-and-forget, never blocks the primary notification.
- **Forge strategy pattern**: All forge-specific behavior (signature validation, event parsing, reconciliation, enrichment) goes in `lib/forges/`. The handler and reconciler are forge-agnostic.
- **Bootstrap auto-provisioning**: Secret and smee channel are auto-generated on first run. Setup instructions pushed via channel notification.
