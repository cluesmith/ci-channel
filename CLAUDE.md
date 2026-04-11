# ci-channel - Claude Code Instructions

> **Note**: This is the Claude Code-specific version. A near-identical version is maintained at `AGENTS.md` following the [AGENTS.md standard](https://agents.md/) for cross-tool compatibility with Cursor, GitHub Copilot, and other AI coding assistants. Keep the two files in sync.

## Project Overview

A Claude Code channel plugin that delivers real-time CI/CD notifications into running Claude Code sessions. Supports **GitHub Actions**, **GitLab CI**, and **Gitea Actions**. Built with the MCP (Model Context Protocol) SDK and published on npm as `ci-channel`.

This project uses **[Codev](https://github.com/cluesmith/codev)** for AI-assisted development.

## Architecture

See `codev/resources/arch.md` for the full architecture document.

**Key components:**
- `server.ts` — MCP server entry point + `setup` subcommand dispatch
- `lib/forge.ts` — Forge interface (strategy pattern for multi-forge support)
- `lib/forges/github.ts` — GitHub Actions forge (HMAC-SHA256, `workflow_run`, `gh` CLI)
- `lib/forges/gitlab.ts` — GitLab CI forge (token validation, Pipeline Hook, `glab` CLI)
- `lib/forges/gitea.ts` — Gitea Actions forge (HMAC-SHA256, `workflow_run`, fetch API)
- `lib/config.ts` — Configuration loading (CLI args + env vars + `.env` file)
- `lib/bootstrap.ts` — First-run auto-provisioning (secret generation, smee channel, setup notification)
- `lib/handler.ts` — Webhook handler pipeline (validate → dedup → filter → notify)
- `lib/webhook.ts` — Signature validation, event parsing, deduplication
- `lib/notify.ts` — Notification formatting and sanitization
- `lib/reconcile.ts` — Startup reconciliation and job enrichment
- `lib/project-root.ts` — Walk-up project root detection (`.mcp.json` / `.git`)
- `lib/state.ts` — Plugin state persistence (`state.json` read/write)
- `lib/setup.ts` — `ci-channel setup` installer — supports all three forges and Codev auto-integration (Spec 5 + Spec 7, ≤300 lines, single file, no DI)

## Configuration

**State is project-scoped** as of v0.2.0. Each project gets its own `<project-root>/.claude/channels/ci/state.json` and `<project-root>/.claude/channels/ci/.env`. Project root is detected via `findProjectRoot()` (walks up for `.mcp.json` or `.git/`).

- **Structural config**: CLI args in `.mcp.json` — `--forge`, `--repos`, `--workflow-filter`, `--reconcile-branches`, `--port`, `--gitea-url`, `--smee-url`
- **Secrets**: `<project-root>/.claude/channels/ci/.env` — `WEBHOOK_SECRET`, `GITEA_TOKEN`
- **Auto-provisioned state**: `<project-root>/.claude/channels/ci/state.json` — generated secret + smee URL
- **Precedence**: CLI args > env vars > `.env` file > `state.json`

## Key Locations

- **Specs**: `codev/specs/` — Feature specifications (WHAT to build)
- **Plans**: `codev/plans/` — Implementation plans (HOW to build)
- **Reviews**: `codev/reviews/` — Post-implementation reviews
- **Architecture**: `codev/resources/arch.md` — System architecture
- **Lessons Learned**: `codev/resources/lessons-learned.md` — Extracted insights

## Installation

### Recommended (all three forges)

```bash
# GitHub (default)
cd /path/to/your-project
npx -y ci-channel setup --repo OWNER/REPO

# GitLab
npx -y ci-channel setup --forge gitlab --repo GROUP/PROJECT

# Gitea (needs GITEA_TOKEN in <project>/.claude/channels/ci/.env or the environment)
npx -y ci-channel setup --forge gitea --gitea-url https://gitea.example.com --repo OWNER/REPO

claude --dangerously-load-development-channels server:ci
```

For Codev projects, the installer additionally updates `.codev/config.json` to append the channel loader flag to `shell.architect`.

### Uninstall

Run `ci-channel remove --repo OWNER/REPO` (same `--forge gitlab|gitea` and `--gitea-url URL` flags as setup) to reverse the install — deletes the forge webhook, removes `state.json`, strips the canonical `ci` entry from `.mcp.json`, and reverts the Codev integration if present.

### Manual / advanced

See `INSTALL.md`.

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests
npm run build        # Compile TypeScript to dist/ (for publishing)
npx tsx server.ts    # Start the server directly from source
```

The `setup` subcommand source lives in `lib/setup.ts`. Dispatch happens at the top of `server.ts` after imports but before `loadConfig()`, via a dynamic `import('./lib/setup.js')` so installer-only execution doesn't load server config.

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
[Spec N] Description of change
[Spec N][Phase: implement] feat: Add feature
```

## Critical Patterns

- **MCP stdio isolation**: Subprocesses spawned by the running MCP server must not inherit `process.stdin` (or they'd steal bytes from the JSON-RPC stream). Default pattern: `stdin: 'ignore'`. Exception: `ci-channel setup`'s `gh api --input -` call uses `stdio: ['pipe', 'pipe', 'pipe']` — a dedicated pipe, still not inheriting `process.stdin`. The rule is "don't inherit `process.stdin`", not literally "`stdin: 'ignore'` everywhere".
- **Sanitize at the boundary**: All user-controlled input (commit messages, branch names) sanitized in `notify.ts` before reaching MCP
- **Never block on enrichment**: Job-detail enrichment is fire-and-forget, never blocks the primary notification
- **Forge strategy pattern**: All forge-specific behavior (signature validation, event parsing, reconciliation, enrichment) goes in `lib/forges/`. The handler and reconciler are forge-agnostic.
- **Fail fast**: Missing required config throws immediately, no silent fallbacks
- **Installer rules (lib/setup.ts)**: single file, no dependency injection, no helper modules, no `@inquirer/prompts` or interactive prompts, always-PATCH/PUT existing webhooks (no "skip if already correct" fast path), state-first ordering (write `state.json` before webhook API calls). For Gitea, token validation happens BEFORE state provisioning — the only exception to state-first is this fail-fast-on-missing-input check. GitLab uses PUT (not PATCH) for hook updates. Gitea's update payload excludes the `type` field (create-only).
