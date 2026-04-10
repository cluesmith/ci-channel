import { join } from 'node:path'
import type { PluginState } from '../state.js'
import { SetupError, UserDeclinedError } from './errors.js'
import type { GhHook } from './gh.js'
import type { McpJson, McpJsonReadResult } from './mcp-json.js'
import { mergeCiServer } from './mcp-json.js'
import { stateFilePath } from './state.js'
import type { SetupArgs } from './types.js'

/**
 * Dependencies injected into the orchestrator. All side effects
 * (filesystem, network, subprocess) go through these so tests can
 * substitute mocks without touching real state.
 */
export interface InstallDeps {
  detectProjectRoot(): string
  readState(projectRoot: string): PluginState
  /** Must throw on failure — no silent error swallowing. */
  writeState(projectRoot: string, state: PluginState): void
  legacyGlobalStateExists(): boolean
  /** True if relPath (e.g. `.claude/channels/ci/`) is covered by any ancestor .gitignore. */
  isGitignored(projectRoot: string, relPath: string): boolean
  generateSecret(): string
  fetchSmeeChannel(): Promise<string | null>
  ghListHooks(repo: string): Promise<GhHook[]>
  ghCreateHook(repo: string, payload: object): Promise<void>
  ghUpdateHook(repo: string, hookId: number, payload: object): Promise<void>
  readMcpJson(path: string): McpJsonReadResult
  writeMcpJson(path: string, mcp: McpJson, indent: number): void
}

/**
 * Minimal I/O interface for informational output and prompts.
 *
 * Phase 2 ships with an auto-yes `Io` whose `confirm` always returns
 * `true`. Phase 3 will swap in an `@inquirer/prompts`-backed
 * implementation for non-`--yes` runs.
 */
export interface Io {
  info(msg: string): void
  warn(msg: string): void
  confirm(prompt: string): Promise<boolean>
  prompt(prompt: string): Promise<string>
}

/** Placeholder used for secret material in dry-run output. */
const REDACTED = '[redacted]'
/** Placeholder smee URL used in dry-run when none is stored. */
const DRY_RUN_SMEE_PLACEHOLDER = 'https://smee.io/<dry-run-placeholder>'
/** Gitignore-relative path the installer warns about if not ignored. */
const STATE_REL_PATH = '.claude/channels/ci/'

/**
 * Run the non-interactive (or prompted) installer end-to-end.
 *
 * Steps, in order:
 *   1. Detect project root
 *   2. Read existing state.json (may be empty)
 *   3. Note legacy global state if present (informational only)
 *   4. Resolve webhook secret (reuse existing or generate)
 *   5. Resolve smee URL (reuse existing, use --smee-url override, or provision)
 *   6. Write state.json with mode 0o600 (skipped in dry-run)
 *   7. Warn if .claude/channels/ci/ is not gitignored
 *   8. List existing webhooks (read-only; always called, even in dry-run)
 *   9. Create the GitHub webhook unless an existing one matches (skipped in dry-run)
 *  10. Read and merge .mcp.json
 *  11. Write .mcp.json (skipped in dry-run)
 *  12. Print next-steps guidance (conditional reminder for new/merged .mcp.json)
 *
 * Throws SetupError on any failure. The caller (runSetup) catches
 * SetupError and converts it to a process exit code + stderr message.
 */
export async function runInstall(
  args: SetupArgs,
  deps: InstallDeps,
  io: Io,
): Promise<void> {
  // Defense-in-depth: parseSetupArgs guarantees repo is set unless the
  // TTY-prompt path (Phase 3) fills it in. If we reach runInstall
  // without a repo, that's a bug.
  if (!args.repo) {
    throw new SetupError('Internal error: --repo is required at this point')
  }

  const projectRoot = deps.detectProjectRoot()
  io.info(`[ci-channel setup] Project root: ${projectRoot}`)

  if (deps.legacyGlobalStateExists()) {
    io.info(
      '[ci-channel setup] Note: legacy global state at ~/.claude/channels/ci/state.json is not used by setup — install is project-scoped.',
    )
  }

  const existingState = deps.readState(projectRoot)
  const state: PluginState = { ...existingState }

  // --- Resolve webhook secret (reuse or generate) ---
  //
  // `secretWasGenerated` is load-bearing downstream: if we generate a fresh
  // secret in this run AND we later find an existing webhook at our smee
  // URL, we must PATCH that hook to use the new secret rather than
  // skipping — otherwise the old webhook keeps signing with a secret
  // nobody has anymore, and every event fails HMAC validation silently.
  // See the webhook-match branch below for the full guard.
  const secretWasGenerated = !existingState.webhookSecret
  if (!state.webhookSecret) {
    if (args.dryRun) {
      io.info(
        `[ci-channel setup] [dry-run] Would generate webhook secret (value: ${REDACTED})`,
      )
      // Placeholder so later steps can produce coherent output.
      state.webhookSecret = REDACTED
    } else {
      state.webhookSecret = deps.generateSecret()
      io.info('[ci-channel setup] Generated webhook secret (256 bits)')
    }
  } else {
    io.info('[ci-channel setup] Reusing existing webhook secret from state.json')
  }

  // --- Resolve smee URL (existing, --smee-url override, or provision) ---
  const smeeUrlChanged = await resolveSmeeUrl(args, state, deps, io)

  // --- .gitignore warning ---
  // Informational only; doesn't depend on any state being written.
  if (!deps.isGitignored(projectRoot, STATE_REL_PATH)) {
    io.warn(
      '[ci-channel setup] Warning: .claude/channels/ci/ is not in .gitignore — state.json contains a secret.',
    )
  }

  // --- List existing webhooks ---
  // The spec forbids mutating network ops in dry-run; listing is
  // read-only, so it's OK to call even in dry-run for a useful preview.
  if (!state.smeeUrl) {
    throw new SetupError('Internal error: smeeUrl should be set by this point')
  }
  const expectedSmeeUrl = state.smeeUrl
  const existingHooks = await deps.ghListHooks(args.repo)
  const matchingHook = existingHooks.find(
    (h) => h.config?.url === expectedSmeeUrl,
  )

  // --- Create or update webhook (BEFORE writing state.json) ---
  //
  // Ordering rule: the webhook must be reconciled with our intended
  // secret BEFORE state.json is written. The naive ordering (state
  // first, then webhook) has a silent race: if state persists a fresh
  // secret and then the webhook step fails or the user declines the
  // PATCH prompt, next run sees state.json already has a secret
  // (`secretWasGenerated === false`), skips the PATCH as idempotent,
  // and the GitHub webhook stays signed with the stale secret forever.
  //
  // By doing webhook work first, a decline/failure simply leaves the
  // (possibly still-empty) state.json alone, and the next run detects
  // the fresh-secret-needed case again correctly.
  //
  // There are three cases:
  //   (1) No matching hook → create one.
  //   (2) Matching hook + reused secret → skip (idempotent re-run).
  //   (3) Matching hook + **freshly generated** secret → PATCH the hook
  //       to use the new secret. Without this, the hook keeps signing
  //       with the old secret (which nobody has — we just regenerated
  //       it), and every event fails HMAC validation silently. This
  //       happens when state.json was deleted or partially corrupted
  //       but the webhook was left in place.
  const webhookPayload = {
    config: {
      url: expectedSmeeUrl,
      content_type: 'json',
      secret: state.webhookSecret,
    },
    events: ['workflow_run'],
    active: true,
  }

  if (matchingHook && !secretWasGenerated) {
    // Case (2): idempotent happy path.
    io.info(
      `[ci-channel setup] Webhook already exists for ${expectedSmeeUrl} — skipping create`,
    )
  } else if (matchingHook && secretWasGenerated) {
    // Case (3): stale secret on existing hook. PATCH it.
    if (matchingHook.id === undefined) {
      throw new SetupError(
        `gh returned a matching hook without an id; cannot update. Delete the existing webhook at ${expectedSmeeUrl} manually and re-run setup.`,
      )
    }
    if (args.dryRun) {
      io.info(
        `[ci-channel setup] [dry-run] Would update existing webhook (id ${matchingHook.id}) with freshly generated secret (state.json was missing a secret)`,
      )
    } else {
      if (
        !(await io.confirm(
          `Update existing webhook (id ${matchingHook.id}) with the newly generated secret?`,
        ))
      ) {
        throw new UserDeclinedError('Stopped before updating webhook secret.')
      }
      await deps.ghUpdateHook(args.repo, matchingHook.id, webhookPayload)
      io.info(
        `[ci-channel setup] Updated existing webhook (id ${matchingHook.id}) — rotated to freshly generated secret`,
      )
    }
  } else if (args.dryRun) {
    // Case (1) in dry-run.
    io.info(
      `[ci-channel setup] [dry-run] Would create GitHub webhook on ${args.repo} targeting ${expectedSmeeUrl}`,
    )
  } else {
    // Case (1): create new webhook.
    if (!(await io.confirm(`Create GitHub webhook on ${args.repo}?`))) {
      throw new UserDeclinedError('Stopped before webhook creation.')
    }
    await deps.ghCreateHook(args.repo, webhookPayload)
    io.info(
      `[ci-channel setup] Created GitHub webhook on ${args.repo} → ${expectedSmeeUrl}`,
    )
  }

  // When --smee-url overrode a stored value, remind the user the old
  // webhook (if any) still exists and must be cleaned up manually.
  if (smeeUrlChanged) {
    io.warn(
      '[ci-channel setup] The old webhook for the previous smee URL is still in place. Delete it manually if no longer needed.',
    )
  }

  // --- Write state.json (AFTER webhook is reconciled) ---
  // Only reached when the webhook step succeeded (or was idempotently
  // skipped). A failure or user decline above throws before reaching
  // here, leaving state.json untouched so the next run can try again.
  const statePath = stateFilePath(projectRoot)
  const stateChanged = stateDiffers(existingState, state)
  if (args.dryRun) {
    if (stateChanged) {
      io.info(`[ci-channel setup] [dry-run] Would write ${statePath}`)
    } else {
      io.info(
        `[ci-channel setup] [dry-run] state.json unchanged — would skip write`,
      )
    }
  } else if (stateChanged) {
    if (!(await io.confirm(`Write credentials to ${statePath}?`))) {
      throw new UserDeclinedError('Stopped before writing state.json.')
    }
    deps.writeState(projectRoot, state)
    io.info(`[ci-channel setup] Wrote ${statePath} (mode 0o600)`)
  } else {
    io.info(
      `[ci-channel setup] state.json already has current values — skipping write`,
    )
  }

  // --- Update .mcp.json ---
  const mcpPath = join(projectRoot, '.mcp.json')
  const mcpRaw = deps.readMcpJson(mcpPath)
  const { updated: mcpUpdated, action: mcpAction } = mergeCiServer(mcpRaw)
  const indent = mcpRaw.exists ? mcpRaw.indent : 2

  if (mcpAction === 'skipped_exists') {
    io.info(`[ci-channel setup] ${mcpPath} already has 'ci' server entry — skipping`)
  } else if (args.dryRun) {
    io.info(
      `[ci-channel setup] [dry-run] Would ${mcpAction === 'created' ? 'create' : 'update'} ${mcpPath}`,
    )
  } else {
    if (
      !(await io.confirm(
        `${mcpAction === 'created' ? 'Create' : 'Update'} ${mcpPath} to register the ci MCP server?`,
      ))
    ) {
      throw new UserDeclinedError('Stopped before updating .mcp.json.')
    }
    deps.writeMcpJson(mcpPath, mcpUpdated, indent)
    io.info(
      `[ci-channel setup] ${mcpAction === 'created' ? 'Created' : 'Updated'} ${mcpPath}`,
    )
  }

  // --- Next steps ---
  printNextSteps(io, mcpAction, args.dryRun)
}

/**
 * Returns true if `next` differs from `prev` in any of the fields the
 * installer manages (`webhookSecret`, `smeeUrl`). Callers use this to
 * skip writeState on an idempotent re-run where stored values already
 * match what would be written.
 */
function stateDiffers(prev: PluginState, next: PluginState): boolean {
  if (prev.webhookSecret !== next.webhookSecret) return true
  if (prev.smeeUrl !== next.smeeUrl) return true
  return false
}

/**
 * Resolve `state.smeeUrl` according to the precedence rules:
 *   - `--smee-url` provided, no stored URL → use CLI value
 *   - `--smee-url` provided, stored URL matches → no change
 *   - `--smee-url` provided, stored URL differs → override (reuse secret)
 *   - No `--smee-url`, no stored URL → fetch a new smee channel
 *   - No `--smee-url`, stored URL present → reuse it
 *
 * Returns `true` if this call changed an existing stored smeeUrl
 * (so the orchestrator can emit the "old webhook left in place" warning).
 */
async function resolveSmeeUrl(
  args: SetupArgs,
  state: PluginState,
  deps: InstallDeps,
  io: Io,
): Promise<boolean> {
  if (args.smeeUrl) {
    if (state.smeeUrl && state.smeeUrl === args.smeeUrl) {
      io.info(`[ci-channel setup] --smee-url matches stored state — no change`)
      return false
    }
    if (state.smeeUrl && state.smeeUrl !== args.smeeUrl) {
      io.warn(
        `[ci-channel setup] Overriding smeeUrl in state.json (old: ${state.smeeUrl}, new: ${args.smeeUrl}). Existing webhookSecret is reused.`,
      )
      state.smeeUrl = args.smeeUrl
      return true
    }
    state.smeeUrl = args.smeeUrl
    io.info(`[ci-channel setup] Using --smee-url: ${args.smeeUrl}`)
    return false
  }

  if (state.smeeUrl) {
    io.info(`[ci-channel setup] Reusing existing smeeUrl from state.json`)
    return false
  }

  // No CLI override and no stored value → provision (or placeholder in dry-run).
  if (args.dryRun) {
    io.info(
      `[ci-channel setup] [dry-run] Would provision a new smee.io channel (not provisioning in dry-run mode)`,
    )
    state.smeeUrl = DRY_RUN_SMEE_PLACEHOLDER
    return false
  }

  if (!(await io.confirm('Provision a new smee.io channel?'))) {
    throw new UserDeclinedError('Stopped before provisioning smee channel.')
  }
  const fetched = await deps.fetchSmeeChannel()
  if (!fetched) {
    throw new SetupError(
      'Failed to provision smee.io channel. Check your network and try again, or pass --smee-url with an existing channel.',
    )
  }
  state.smeeUrl = fetched
  io.info(`[ci-channel setup] Provisioned smee channel: ${fetched}`)
  return false
}

/**
 * Print the end-of-install guidance. The "project-scoped server
 * approval" reminder is conditional: only shown when `.mcp.json` was
 * created or merged (user may need to approve the new entry in the
 * Claude Code /mcp menu). Skipped when the entry was already present.
 */
function printNextSteps(
  io: Io,
  mcpAction: 'created' | 'merged' | 'skipped_exists',
  dryRun: boolean,
): void {
  const header = dryRun
    ? '[ci-channel setup] Dry run complete. No changes were made.'
    : '[ci-channel setup] Install complete.'
  io.info('')
  io.info(header)
  io.info('')
  io.info('Next steps:')
  io.info('  claude --dangerously-load-development-channels server:ci')

  if (mcpAction === 'created' || mcpAction === 'merged') {
    io.info('')
    io.info(
      "Note: project-scoped MCP servers need explicit approval. Approve 'ci' in",
    )
    io.info(
      "the /mcp menu inside Claude Code, or add 'ci' to enabledMcpjsonServers in",
    )
    io.info('~/.claude.json.')
  }
}
