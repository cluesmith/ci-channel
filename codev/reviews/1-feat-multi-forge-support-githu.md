# Review: Multi-Forge Support (GitHub, GitLab, Gitea)

## Summary

Implemented multi-forge support for the CI channel plugin, extending it from GitHub-only to support GitHub Actions, GitLab CI, and Gitea Actions. The implementation uses the Forge Strategy Pattern with a shared `Forge` interface and per-forge implementations. Also added CLI arg parsing for structural config, auto-provisioning (webhook secret + smee channel), port 0 default for multi-session coexistence, and comprehensive documentation.

## Spec Compliance

- [x] `--forge github` (default): identical behavior, all original tests pass
- [x] `--forge gitlab`: GitLab CI pipeline webhooks validated, parsed, and pushed as notifications
- [x] `--forge gitea`: Gitea Actions webhooks validated, parsed, and pushed as notifications
- [x] Each forge has startup reconciliation (gh CLI, glab CLI, Gitea API)
- [x] Each forge has failed-job enrichment
- [x] Invalid `--forge` value fails fast at startup
- [x] Structural config via CLI args (`--forge`, `--repos`, `--workflow-filter`, etc.)
- [x] Default port 0 for multi-session coexistence
- [x] smee-client in-process via Node.js API
- [x] Auto-provisions smee channel when `--smee-url` not provided
- [x] Auto-generates `WEBHOOK_SECRET` on first run
- [x] Pushes setup instructions via channel notification
- [x] Backward compat: `GITHUB_REPOS`, `FORGE`, `PORT` env vars still work
- [x] Both `/webhook` and `/webhook/github` routes accepted
- [x] Test coverage for all three forges (170 tests across 11 files)
- [x] Documentation updated (README, arch.md, CLAUDE.md)

## Deviations from Plan

- **GitLab `workflowName` field**: Plan initially used `pipeline.source` for reconciliation, but this didn't match live webhook behavior which uses `attrs.name`. Fixed during review to use `pipeline.name ?? pipeline.source ?? 'pipeline'`.
- **Gitea reconciliation**: Plan said "check first configured repo". Changed to iterate all configured repos after Codex review feedback.
- **Bootstrap `ensureSecret`**: Initially implemented with direct filesystem calls. Refactored to injectable `BootstrapDeps` interface after Codex review noted testability gap.
- **Test count**: Ended at 170 tests across 11 files (plan estimated 83 original + new; actual growth was larger due to comprehensive forge and bootstrap tests).

## Lessons Learned

### What Went Well
- The Forge Strategy Pattern was the right choice — each forge is isolated, testable, and the handler pipeline stayed clean
- Auto-provisioning (secret + smee) dramatically simplifies first-run setup
- Port 0 default eliminates the EADDRINUSE pain point for multi-session users
- 3-way consultation caught real issues at every phase (bootstrap testability, multi-repo reconciliation, workflow-filter mismatch)

### Challenges Encountered
- **stdio lifecycle test**: The bootstrap setup notification was the first `notifications/claude/channel` message, not the webhook notification. Fixed by filtering for notifications with a `workflow` meta key.
- **Async smee startup**: The dynamic `import("smee-client").then(...)` in `startSmeeClient` is inherently async but the `BootstrapDeps` interface declares it as `void`. Accepted as intentional — relay starting a few ms late is harmless.

### What Would Be Done Differently
- Would have included `BootstrapDeps` injectable pattern from the start rather than adding it during review
- Would have established the CLI arg parsing pattern earlier — it touches config, tests, and docs

### Methodology Improvements
- Documentation phases benefit from having a concrete checklist of what each guide must include (`.env` examples, doc links) — the spec was right to require this explicitly

## Technical Debt
- `(config as any).webhookSecret = result.webhookSecret` mutation in server.ts — works but is a type-safety escape hatch. A mutable config holder would be cleaner.
- smee.io auto-provisioned channels are ephemeral — a new URL on each restart. Users who want stable URLs should use `--smee-url`.

## Architecture Updates

Architecture document (`codev/resources/arch.md`) was comprehensively updated in Phase 4 to reflect:
- Forge abstraction layer (`lib/forge.ts` interface, `lib/forges/` directory)
- Updated directory structure with all new files
- Updated data flow diagrams showing forge-agnostic pipeline
- Bootstrap module documentation
- Updated startup flow (port 0, bootstrap, smee in-process)
- Three forge implementations table with signature/event/CLI details
- Updated security model for per-forge signature validation

## Lessons Learned Updates

New lessons to add to `codev/resources/lessons-learned.md`:

### Strategy Pattern for multi-variant webhook handling
When the same pipeline must handle webhooks from different sources with different signatures, payload structures, and CLI tools, the Strategy Pattern (shared interface + per-source implementation) keeps the pipeline clean. The handler never knows which forge it's talking to. *(Spec 1)*

### Injectable deps for testable auto-provisioning
Side-effect-heavy startup code (filesystem writes, network calls, MCP notifications) should use injectable dependencies from the start. The `BootstrapDeps` pattern enables testing with mocked fs/network/MCP without touching real state. *(Spec 1, Phase 1)*

### CLI arg parsing is structural config, env vars are secrets
Separating structural config (forge, repos, filters) into CLI args in `.mcp.json` and secrets into `.env` gives users a single-file view of their full config alongside the MCP server registration. *(Spec 1)*

### Port 0 eliminates EADDRINUSE for MCP plugins
MCP channel plugins that run HTTP servers should default to port 0 (OS-assigned) since multiple Claude Code sessions may run concurrently. This removes the need for EADDRINUSE error handling for the default case. *(Spec 1)*

### GitLab synthetic dedup keys must include state
GitLab doesn't provide a delivery ID header. A synthetic key using only `project_id + pipeline_id` would suppress legitimate state transitions (running → failed). Include the status in the key: `gitlab-{project_id}-{pipeline_id}-{status}`. *(Spec 1, Phase 2)*

## Consultation Feedback

### Specify Phase (Round 1)

#### Codex
- **Concern**: GitLab completion semantics ambiguous (fail-only vs all terminal states)
  - **Addressed**: Clarified terminal states (success, failed, canceled, skipped)
- **Concern**: Gitea reconciliation/enrichment underspecified
  - **Addressed**: Specified API-based approach with `--gitea-url`/`GITEA_TOKEN`
- **Concern**: Route backward-compatibility missing
  - **Addressed**: `/webhook/github` kept, `/webhook` added as alias
- **Concern**: GitLab dedup key insufficiently defined
  - **Addressed**: Synthetic key includes status

#### Claude
- **Concern**: GitLab status filtering needs clear decision
  - **Addressed**: Defined terminal states explicitly
- **Concern**: REPOS vs GITHUB_REPOS precedence unclear
  - **Addressed**: Documented precedence: `--repos` > `REPOS` > `GITHUB_REPOS`

#### Gemini
- Skipped (API key not configured)

### Plan Phase (Round 1)

#### Codex
- **Concern**: "No assertion changes" regression criterion impossible
  - **Addressed**: Reworded to explicitly list expected test updates
- **Concern**: Missing bootstrap testability design
  - **Addressed**: Added `lib/bootstrap.ts` with injectable `BootstrapDeps`
- **Concern**: Rollback strategy wrong about external state
  - **Addressed**: Documented `.env` file and smee channel as non-reverted state

#### Claude
- **Concern**: Config flow for secret generation unclear
  - **Addressed**: Documented `loadConfig()` returns nullable `webhookSecret`, bootstrap handles generation
- **Concern**: CLI args incomplete in Phase 1 details
  - **Addressed**: Enumerated all flags
- **Concern**: smee-client crash isolation missing
  - **Addressed**: Added try/catch strategy

### Implementation Phases

#### Phase 1 (forge_abstraction)
- **Codex**: Bootstrap not injectable → **Addressed** (refactored to `BootstrapDeps`)
- **Codex**: Server listen errors unhandled → **Addressed** (added error handler)
- **Claude**: Missing `tests/bootstrap.test.ts` → **Addressed** (added 11 tests)

#### Phase 2 (gitlab_forge)
- **Codex**: workflow-filter mismatch in reconciliation → **Addressed** (use `pipeline.name`)
- **Codex**: Missing glab warning → **Addressed** (added per-forge CLI warning)
- **Codex**: Missing reconciliation tests → **Addressed** (added 3 tests)
- **Claude**: No concerns (APPROVE)

#### Phase 3 (gitea_forge)
- **Codex**: Only checks first repo → **Addressed** (iterate all repos)
- **Codex**: Missing API test coverage → **Addressed** (4 mocked-fetch tests)
- **Claude**: No concerns (APPROVE)

#### Phase 4 (documentation)
- **Codex**: Per-forge guides missing `.env` examples → **Addressed**
- **Codex**: Test count wrong → **Addressed** (11 files, not 12)
- **Claude**: No concerns (APPROVE)

## Flaky Tests

No flaky tests encountered during this project.

## Follow-up Items
- E2E validation: configure plugin on cluesmith/ci-channel repo itself
- Consider persistent smee URL management (save auto-provisioned URL for reuse)
- Gitea Actions API may evolve — monitor for payload format changes
