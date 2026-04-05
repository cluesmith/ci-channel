# Contributing to CI Channel

All contributions are welcome — bug reports, documentation improvements, small fixes, and major features alike.

## Getting Started

```bash
git clone https://github.com/cluesmith/ci-channel.git
cd ci-channel
npm install
npm test    # Verify everything works
```

## Running Tests

Tests use Node.js's built-in test runner (`node:test`):

```bash
npm test
```

83 tests across 6 files covering signature validation, event parsing, sanitization, config loading, HTTP pipeline integration, and MCP stdio stability.

## Contribution Size Guide

### Small changes (up to a few hundred lines)

Bug fixes, documentation updates, small features, test improvements — just open a PR:

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Run `npm test` and ensure all tests pass
5. Open a pull request with a clear description

### Larger changes (more than a few hundred lines)

For substantial features, refactors, or architectural changes, PRs that follow the [Codev](https://github.com/cluesmith/codev) **SPIR** or **ASPIR** protocol will be significantly easier to review and integrate. These protocols produce structured artifacts that make the reasoning behind changes transparent:

- **Specification** (`codev/specs/{n}-feature-name.md`) — What you're building and why. Problem statement, success criteria, solution approaches considered, security implications.
- **Plan** (`codev/plans/{n}-feature-name.md`) — How you're building it. Phased implementation with deliverables and acceptance criteria per phase.
- **Review** (`codev/reviews/{n}-feature-name.md`) — What you learned. Spec compliance check, deviations from plan, lessons learned, test results.
- **Tests** — Each phase should include tests alongside the implementation.

This isn't a hard requirement — we won't reject a good PR because it lacks a spec. But having these artifacts makes it much easier to:
- Understand the rationale behind design decisions
- Review changes with full context
- Identify potential issues early (before code is written)
- Maintain the codebase long-term

**SPIR** (Specify, Plan, Implement, Review) includes human approval gates on the spec and plan. **ASPIR** (Autonomous SPIR) auto-approves the spec and plan, keeping the same structure but moving faster. Choose whichever fits your workflow.

To see how this looks in practice, check the existing project documents:
- [`codev/specs/1-ci-channel-plugin.md`](codev/specs/1-ci-channel-plugin.md)
- [`codev/plans/1-ci-channel-plugin.md`](codev/plans/1-ci-channel-plugin.md)
- [`codev/reviews/1-ci-channel-plugin.md`](codev/reviews/1-ci-channel-plugin.md)

### Using Codev with Claude Code

If you're using [Claude Code](https://claude.ai/code), the project is already configured with Codev:

```bash
# Claude Code will read CLAUDE.md and understand the project structure.
# To start a new feature with the SPIR protocol:
# 1. Create a GitHub Issue describing the feature
# 2. The architect spawns a builder: afx spawn <issue-number> --protocol spir
# 3. The builder writes spec → plan → implements → reviews
# 4. PR includes all artifacts
```

For other AI assistants (Cursor, GitHub Copilot, etc.), see `AGENTS.md`.

## Code Style

- TypeScript with strict types
- No build step — the project runs directly via `tsx`
- Fail fast with clear error messages — no fallbacks or silent recovery
- Sanitize all user-controlled input before including in notifications
- All subprocess calls must use `stdin: 'ignore'` to prevent MCP stdio corruption

## Commit Messages

For standard PRs:
```
feat: Add workflow name filtering
fix: Handle missing head_commit in webhook payload
test: Add integration tests for repo allowlist
```

For Codev-protocol PRs:
```
[Spec 2] Initial specification for multi-repo support
[Spec 2][Phase: config] feat: Add multi-repo webhook routing
[Spec 2][Phase: tests] test: Integration tests for multi-repo
```

## Project Structure

```
server.ts                  # MCP server entry point
lib/                       # Core implementation
  config.ts                # Configuration loading
  handler.ts               # Webhook handler pipeline
  webhook.ts               # Signature validation, parsing, dedup
  notify.ts                # Notification formatting, sanitization
  reconcile.ts             # Startup reconciliation, job enrichment
tests/                     # Test suite (node:test)
codev/                     # Development methodology
  specs/                   # Feature specifications (WHAT)
  plans/                   # Implementation plans (HOW)
  reviews/                 # Post-implementation reviews
  resources/
    arch.md                # System architecture
    lessons-learned.md     # Accumulated insights
```

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (Node.js version, OS, Claude Code version)

## Security

If you discover a security vulnerability, please report it responsibly by opening a private security advisory on the GitHub repository rather than a public issue.
