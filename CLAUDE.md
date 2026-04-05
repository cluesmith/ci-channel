# ci-channel - Claude Code Instructions

## Project Overview

A Claude Code channel plugin that delivers real-time GitHub Actions CI/CD notifications into running Claude Code sessions. Built with the MCP (Model Context Protocol) SDK.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point (HTTP server, smee-client, reconciliation)
- `lib/config.ts` — Configuration loading (.env + environment variables)
- `lib/handler.ts` — Webhook handler pipeline (validate → dedup → filter → notify)
- `lib/webhook.ts` — GitHub webhook parsing, HMAC signature validation, deduplication
- `lib/notify.ts` — Notification formatting and input sanitization
- `lib/reconcile.ts` — Startup reconciliation and async job enrichment

## Key Locations

- **Specs**: `codev/specs/` — Feature specifications (WHAT to build)
- **Plans**: `codev/plans/` — Implementation plans (HOW to build)
- **Reviews**: `codev/reviews/` — Post-implementation reviews
- **Architecture**: `codev/resources/arch.md` — System architecture
- **Lessons Learned**: `codev/resources/lessons-learned.md` — Extracted insights

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests (83 tests across 6 files)
npx tsx server.ts    # Start the server (requires WEBHOOK_SECRET)
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
- **Fail fast**: Missing required config throws immediately, no fallbacks.
