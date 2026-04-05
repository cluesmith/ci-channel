# ci-channel - AI Agent Instructions

> **Note**: This file follows the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. A Claude Code-specific version is maintained in `CLAUDE.md`.

## Project Overview

A Claude Code channel plugin that delivers real-time GitHub Actions CI/CD notifications into running Claude Code sessions. Built with the MCP (Model Context Protocol) SDK.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point
- `lib/config.ts` — Configuration loading
- `lib/handler.ts` — Webhook handler pipeline
- `lib/webhook.ts` — Signature validation, event parsing, deduplication
- `lib/notify.ts` — Notification formatting and sanitization
- `lib/reconcile.ts` — Startup reconciliation and job enrichment

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

- **MCP stdio isolation**: All subprocess calls must use `stdin: 'ignore'` to prevent consuming MCP stdin bytes
- **Sanitize at the boundary**: All user-controlled input sanitized before reaching MCP
- **Never block on enrichment**: Job-detail enrichment is fire-and-forget
- **Fail fast**: Missing required config throws immediately, no fallbacks
