import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginState } from '../lib/state.js'
import { runInstall, type InstallDeps, type Io } from '../lib/setup/orchestrator.js'
import { SetupError, UserDeclinedError } from '../lib/setup/errors.js'
import type { GhHook } from '../lib/setup/gh.js'
import type { McpJsonReadResult, McpJson } from '../lib/setup/mcp-json.js'
import type { SetupArgs } from '../lib/setup/types.js'

/**
 * Canonical test args — --yes non-dry-run run against a known repo.
 * Individual tests clone + override as needed.
 */
function baseArgs(): SetupArgs {
  return {
    repo: 'owner/repo',
    forge: 'github',
    yes: true,
    dryRun: false,
    smeeUrl: null,
  }
}

interface RecordedCalls {
  info: string[]
  warn: string[]
  readStateCalls: number
  writeStateCalls: number
  writeStateLastArg: PluginState | null
  ghListHooksCalls: number
  ghCreateHookCalls: number
  ghCreateHookLastArg: { repo: string; payload: object } | null
  ghUpdateHookCalls: number
  ghUpdateHookLastArg: { repo: string; hookId: number; payload: object } | null
  readMcpJsonCalls: number
  writeMcpJsonCalls: number
  writeMcpJsonLastArg: { path: string; mcp: McpJson; indent: number } | null
  fetchSmeeCalls: number
  generateSecretCalls: number
  isGitignoredCalls: number
}

interface MockConfig {
  projectRoot?: string
  existingState?: PluginState
  ghHooks?: GhHook[]
  mcpRead?: McpJsonReadResult
  /**
   * Undefined → mock returns the default 'https://smee.io/fetched'.
   * Explicit null → mock returns null (simulates fetch failure).
   * String → mock returns that string.
   */
  fetchedSmeeUrl?: string | null
  legacyGlobal?: boolean
  gitignored?: boolean
}

function buildMockDepsAndIo(cfg: MockConfig = {}): {
  deps: InstallDeps
  io: Io
  calls: RecordedCalls
} {
  const calls: RecordedCalls = {
    info: [],
    warn: [],
    readStateCalls: 0,
    writeStateCalls: 0,
    writeStateLastArg: null,
    ghListHooksCalls: 0,
    ghCreateHookCalls: 0,
    ghCreateHookLastArg: null,
    ghUpdateHookCalls: 0,
    ghUpdateHookLastArg: null,
    readMcpJsonCalls: 0,
    writeMcpJsonCalls: 0,
    writeMcpJsonLastArg: null,
    fetchSmeeCalls: 0,
    generateSecretCalls: 0,
    isGitignoredCalls: 0,
  }

  const deps: InstallDeps = {
    detectProjectRoot: () => cfg.projectRoot ?? '/tmp/fake-project',
    readState: () => {
      calls.readStateCalls++
      return { ...(cfg.existingState ?? {}) }
    },
    writeState: (_root, state) => {
      calls.writeStateCalls++
      calls.writeStateLastArg = { ...state }
    },
    legacyGlobalStateExists: () => cfg.legacyGlobal ?? false,
    isGitignored: () => {
      calls.isGitignoredCalls++
      return cfg.gitignored ?? true
    },
    generateSecret: () => {
      calls.generateSecretCalls++
      return 'deadbeef'.repeat(8) // 64 hex chars
    },
    fetchSmeeChannel: async () => {
      calls.fetchSmeeCalls++
      // Distinguish "undefined" (use default) from "null" (simulate failure).
      if ('fetchedSmeeUrl' in cfg) return cfg.fetchedSmeeUrl ?? null
      return 'https://smee.io/fetched'
    },
    ghListHooks: async (_repo) => {
      calls.ghListHooksCalls++
      return cfg.ghHooks ?? []
    },
    ghCreateHook: async (repo, payload) => {
      calls.ghCreateHookCalls++
      calls.ghCreateHookLastArg = { repo, payload }
    },
    ghUpdateHook: async (repo, hookId, payload) => {
      calls.ghUpdateHookCalls++
      calls.ghUpdateHookLastArg = { repo, hookId, payload }
    },
    readMcpJson: () => {
      calls.readMcpJsonCalls++
      return cfg.mcpRead ?? { exists: false }
    },
    writeMcpJson: (path, mcp, indent) => {
      calls.writeMcpJsonCalls++
      calls.writeMcpJsonLastArg = { path, mcp, indent }
    },
  }

  const io: Io = {
    info: (msg) => calls.info.push(msg),
    warn: (msg) => calls.warn.push(msg),
    confirm: async () => true,
    prompt: async () => {
      throw new Error('prompt should not be called in --yes tests')
    },
  }

  return { deps, io, calls }
}

describe('runInstall — happy paths', () => {
  test('fresh install: all steps run in order', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {},
      ghHooks: [],
      mcpRead: { exists: false },
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.generateSecretCalls, 1)
    assert.equal(calls.fetchSmeeCalls, 1)
    assert.equal(calls.writeStateCalls, 1)
    assert.ok(calls.writeStateLastArg)
    assert.equal(calls.writeStateLastArg.smeeUrl, 'https://smee.io/fetched')
    assert.match(calls.writeStateLastArg.webhookSecret ?? '', /^deadbeef/)
    assert.equal(calls.ghListHooksCalls, 1)
    assert.equal(calls.ghCreateHookCalls, 1)
    assert.equal(calls.ghCreateHookLastArg?.repo, 'owner/repo')
    assert.equal(calls.writeMcpJsonCalls, 1)
    assert.equal(calls.writeMcpJsonLastArg?.path.endsWith('.mcp.json'), true)
  })

  test('idempotent re-run: valid state, matching webhook, existing .mcp.json ci → nothing written', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing-secret',
        smeeUrl: 'https://smee.io/existing',
      },
      ghHooks: [
        { id: 42, config: { url: 'https://smee.io/existing' } },
      ],
      mcpRead: {
        exists: true,
        content: { mcpServers: { ci: { command: 'npx', args: ['-y', 'ci-channel'] } } },
        indent: 2,
      },
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.generateSecretCalls, 0)
    assert.equal(calls.fetchSmeeCalls, 0)
    // Steps 3-5 skipped: nothing changed, so no write.
    assert.equal(calls.writeStateCalls, 0)
    assert.equal(calls.ghListHooksCalls, 1)
    assert.equal(calls.ghCreateHookCalls, 0) // skipped — matching hook
    assert.equal(calls.writeMcpJsonCalls, 0) // skipped — entry already present
  })

  test('re-run with partial state (only smeeUrl, no existing hook): writes state and creates webhook', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/existing',
        // No webhookSecret — installer needs to generate one
      },
      ghHooks: [],
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.generateSecretCalls, 1)
    assert.equal(calls.fetchSmeeCalls, 0) // smeeUrl already set
    assert.equal(calls.writeStateCalls, 1) // state changed (new secret added)
    assert.equal(calls.ghCreateHookCalls, 1)
    assert.equal(calls.ghUpdateHookCalls, 0)
  })

  test('non-matching webhook: user has unrelated relay, create still runs', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing-secret',
        smeeUrl: 'https://smee.io/mine',
      },
      ghHooks: [
        { id: 99, config: { url: 'https://smee.io/someone-elses' } },
      ],
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.ghCreateHookCalls, 1)
    assert.equal(calls.ghCreateHookLastArg?.repo, 'owner/repo')
  })

  test('.mcp.json exists without ci → merged', async () => {
    const { deps, calls, io } = buildMockDepsAndIo({
      mcpRead: {
        exists: true,
        content: { mcpServers: { other: { command: 'foo' } } },
        indent: 2,
      },
    })
    await runInstall(baseArgs(), deps, io)
    assert.equal(calls.writeMcpJsonCalls, 1)
    const written = calls.writeMcpJsonLastArg?.mcp as { mcpServers: Record<string, unknown> }
    assert.ok('ci' in written.mcpServers)
    assert.ok('other' in written.mcpServers)
  })
})

describe('runInstall — webhook secret freshness vs existing hook (silent-HMAC-failure regression)', () => {
  // These tests guard against the bug where a freshly generated secret
  // paired with an existing webhook at the same URL would be silently
  // skipped, leaving the webhook signing with a secret the runtime no
  // longer has and causing every event to fail HMAC validation.

  test('state deleted (no secret, no smeeUrl) + --smee-url points at existing hook → PATCHes the hook', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {}, // state.json deleted — no secret, no smeeUrl
      ghHooks: [
        { id: 42, config: { url: 'https://smee.io/existing' } },
      ],
    })

    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/existing'

    await runInstall(args, deps, io)

    // Secret was freshly generated in this run.
    assert.equal(calls.generateSecretCalls, 1)
    // State was written (new secret + smee URL from CLI override).
    assert.equal(calls.writeStateCalls, 1)
    // Critical: existing hook is NOT silently skipped.
    assert.equal(calls.ghCreateHookCalls, 0)
    // Instead, it's PATCHed with the new secret.
    assert.equal(calls.ghUpdateHookCalls, 1)
    assert.equal(calls.ghUpdateHookLastArg?.repo, 'owner/repo')
    assert.equal(calls.ghUpdateHookLastArg?.hookId, 42)
    // And the payload has the freshly generated secret.
    const payload = calls.ghUpdateHookLastArg?.payload as {
      config: { secret: string; url: string }
    }
    assert.equal(payload.config.url, 'https://smee.io/existing')
    assert.match(payload.config.secret, /^deadbeef/)
  })

  test('partial state (smeeUrl present, no secret) + matching hook → PATCHes the hook', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/partial',
        // webhookSecret missing — installer must regenerate
      },
      ghHooks: [
        { id: 7, config: { url: 'https://smee.io/partial' } },
      ],
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.generateSecretCalls, 1)
    // Critical: must update, not skip.
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 1)
    assert.equal(calls.ghUpdateHookLastArg?.hookId, 7)
  })

  test('idempotent happy path: state intact + matching hook → skip (no update)', async () => {
    // Sanity check that the normal idempotent re-run still skips.
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing-secret',
        smeeUrl: 'https://smee.io/intact',
      },
      ghHooks: [
        { id: 99, config: { url: 'https://smee.io/intact' } },
      ],
    })

    await runInstall(baseArgs(), deps, io)

    assert.equal(calls.generateSecretCalls, 0)
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 0) // skip, not update
  })

  test('fresh secret + matching hook without id → fail fast', async () => {
    // Defensive: if gh ever returns a hook without an id, we can't
    // PATCH it — fail fast with clear guidance instead of trying.
    const { deps, io } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/noid',
      },
      ghHooks: [
        { config: { url: 'https://smee.io/noid' } } as GhHook, // no id
      ],
    })

    await assert.rejects(
      () => runInstall(baseArgs(), deps, io),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('matching hook without an id'),
    )
  })

  test('architect regression: decline at PATCH prompt → state.json is NOT written (prevents silent-HMAC break on next run)', async () => {
    // Scenario from the architect's iter2 bug report:
    //   1. User deletes state.json, leaves webhook in place
    //   2. Re-runs setup; installer generates fresh secret
    //   3. Finds matching hook, prompts "Update webhook?"
    //   4. User declines
    //   5. BEFORE FIX: state.json was already written with the fresh
    //      secret, so next run would see secretWasGenerated=false and
    //      skip the PATCH as idempotent — silent HMAC break forever.
    //   6. AFTER FIX: state.json is written AFTER the webhook step, so
    //      declining throws UserDeclinedError with state.json still
    //      empty. Next run re-enters the PATCH path correctly.
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/existing',
        // No webhookSecret — installer must regenerate
      },
      ghHooks: [
        { id: 42, config: { url: 'https://smee.io/existing' } },
      ],
    })

    // Mock Io that declines the PATCH confirmation.
    let confirmCount = 0
    const decliningIo: Io = {
      info: () => {},
      warn: () => {},
      confirm: async (message: string) => {
        confirmCount++
        // First and only prompt reached in this scenario is the
        // "Update existing webhook?" — decline it.
        assert.match(message, /Update existing webhook/)
        return false
      },
      prompt: async () => {
        throw new Error('prompt should not be called')
      },
    }

    const args = baseArgs()
    args.yes = false // interactive
    await assert.rejects(
      () => runInstall(args, deps, decliningIo),
      (err: UserDeclinedError) =>
        err instanceof UserDeclinedError &&
        err.userMessage.includes('updating webhook secret') &&
        err.exitCode === 0,
    )

    // Only the PATCH prompt was asked.
    assert.equal(confirmCount, 1)
    // Webhook PATCH was NOT called (user declined).
    assert.equal(calls.ghUpdateHookCalls, 0)
    // CRITICAL: state.json was NOT written. This is the bug fix —
    // without it, the next run would see the freshly persisted secret
    // and skip the PATCH path entirely, silently breaking HMAC validation.
    assert.equal(
      calls.writeStateCalls,
      0,
      'state.json must NOT be written when PATCH is declined — otherwise next run will skip the PATCH as idempotent and silently break HMAC',
    )
  })

  test('case F (iter4): stored secret but no stored URL + --smee-url + matching hook → PATCH (not skip)', async () => {
    // Architect's iter3 bug (a):
    //   existingState = { webhookSecret: X } (no smeeUrl)
    //   user passes --smee-url Y
    //   hook exists at Y
    //
    // Before fix: stateHasPairedUrl logic was absent; the old
    // `matchingHook && !secretWasGenerated` check skipped. The hook
    // at Y was created with some other secret, so HMAC would fail.
    //
    // After fix: existingState.smeeUrl is undefined, which does not
    // equal expectedSmeeUrl (= Y), so stateHasPairedUrl is false →
    // PATCH path.
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'stored-secret-X',
        // no smeeUrl
      },
      ghHooks: [
        { id: 101, config: { url: 'https://smee.io/cli-provided' } },
      ],
    })

    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/cli-provided'

    await runInstall(args, deps, io)

    // Must have PATCHed, NOT skipped.
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 1)
    assert.equal(calls.ghUpdateHookLastArg?.hookId, 101)
    // The PATCH payload carries the stored secret (not a fresh one —
    // secretWasGenerated=false in this scenario).
    const payload = calls.ghUpdateHookLastArg?.payload as {
      config: { secret: string; url: string }
    }
    assert.equal(payload.config.secret, 'stored-secret-X')
    assert.equal(payload.config.url, 'https://smee.io/cli-provided')

    // ... and since stateWasGenerated === false, generateSecret was
    // not called.
    assert.equal(calls.generateSecretCalls, 0)
    // State IS written because writeStateLastArg will have a new
    // smeeUrl (was undefined, now set).
    assert.equal(calls.writeStateCalls, 1)
  })

  test('case G (iter4): --smee-url override to different URL with matching hook → PATCH (not skip)', async () => {
    // Architect's iter3 bug (b):
    //   existingState = { webhookSecret: X, smeeUrl: A }
    //   user passes --smee-url B (differs)
    //   hook exists at B
    //
    // Before fix: secretWasGenerated=false → skip. But the hook at
    // B was created outside this installer (or by a different run)
    // with some other secret; the stored X was paired with A, not B.
    // Silent HMAC break.
    //
    // After fix: existingState.smeeUrl (A) !== expectedSmeeUrl (B)
    // → stateHasPairedUrl=false → PATCH path.
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'stored-secret-X',
        smeeUrl: 'https://smee.io/A-original',
      },
      ghHooks: [
        { id: 202, config: { url: 'https://smee.io/B-new' } },
      ],
    })

    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/B-new'

    await runInstall(args, deps, io)

    // Must PATCH, not skip.
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 1)
    assert.equal(calls.ghUpdateHookLastArg?.hookId, 202)

    // The "--smee-url override" warning about the old webhook being
    // left in place should also fire.
    const overrideWarnings = calls.warn.filter((w) =>
      w.includes('old webhook for the previous smee URL'),
    )
    assert.equal(overrideWarnings.length, 1)
  })

  test('case H (iter4): --smee-url matches stored URL + matching hook → skip (idempotent happy path)', async () => {
    // Sanity check: when the stored pair matches the CLI override and
    // the hook exists, we still skip. No regression.
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'stored-secret',
        smeeUrl: 'https://smee.io/stable',
      },
      ghHooks: [
        { id: 1, config: { url: 'https://smee.io/stable' } },
      ],
    })

    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/stable'

    await runInstall(args, deps, io)

    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 0) // skip, not PATCH
  })

  test('multiple hooks at same URL → warn and reconcile only the first', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/dup',
      },
      ghHooks: [
        { id: 10, config: { url: 'https://smee.io/dup' } },
        { id: 20, config: { url: 'https://smee.io/dup' } },
      ],
    })

    await runInstall(baseArgs(), deps, io)

    // Warning fired.
    const dupWarnings = calls.warn.filter((w) =>
      w.includes('2 webhooks point at'),
    )
    assert.equal(dupWarnings.length, 1)

    // Only the first hook is PATCHed (fresh secret was generated since
    // existingState has no webhookSecret).
    assert.equal(calls.ghUpdateHookCalls, 1)
    assert.equal(calls.ghUpdateHookLastArg?.hookId, 10)
  })

  test('dry-run: fresh secret + matching hook → logs "would update", no call', async () => {
    const args = baseArgs()
    args.dryRun = true
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        smeeUrl: 'https://smee.io/dryrun',
      },
      ghHooks: [
        { id: 11, config: { url: 'https://smee.io/dryrun' } },
      ],
    })

    await runInstall(args, deps, io)

    // Dry-run: no secret actually generated, no mutations.
    assert.equal(calls.generateSecretCalls, 0)
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.ghUpdateHookCalls, 0)
    // But the output should mention the planned update.
    const joined = calls.info.join('\n')
    assert.match(joined, /\[dry-run\] Would update existing webhook/)
  })
})

describe('runInstall — error paths', () => {
  test('no project root: detectProjectRoot throws → propagated', async () => {
    const { deps, io } = buildMockDepsAndIo()
    deps.detectProjectRoot = () => {
      throw new SetupError('Could not locate project root (no .mcp.json or .git/ found)')
    }
    await assert.rejects(
      () => runInstall(baseArgs(), deps, io),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('Could not locate project root'),
    )
  })

  test('.mcp.json malformed: readMcpJson throws → propagated before writeMcpJson', async () => {
    const { deps, io, calls } = buildMockDepsAndIo()
    deps.readMcpJson = () => {
      throw new SetupError('.mcp.json is not valid JSON: Unexpected token')
    }
    await assert.rejects(
      () => runInstall(baseArgs(), deps, io),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('not valid JSON'),
    )
    assert.equal(calls.writeMcpJsonCalls, 0)
  })

  test('smee fetch returns null → SetupError', async () => {
    const { deps, io } = buildMockDepsAndIo({
      fetchedSmeeUrl: null,
    })
    await assert.rejects(
      () => runInstall(baseArgs(), deps, io),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('Failed to provision smee'),
    )
  })

  test('defense-in-depth: missing repo throws "internal error"', async () => {
    const { deps, io } = buildMockDepsAndIo()
    const args = baseArgs()
    args.repo = null
    await assert.rejects(
      () => runInstall(args, deps, io),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('--repo is required'),
    )
  })
})

describe('runInstall — malformed state.json (spec scenario 24)', () => {
  test('readState returns {} (loadState parse-error behavior) → treated as fresh', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {}, // loadState returns {} on malformed JSON
    })
    await runInstall(baseArgs(), deps, io)
    // Should proceed to generate secret + fetch smee + write state.
    assert.equal(calls.generateSecretCalls, 1)
    assert.equal(calls.fetchSmeeCalls, 1)
    assert.equal(calls.writeStateCalls, 1)
  })
})

describe('runInstall — --dry-run mode', () => {
  test('dry-run: no writes, no secret gen, no fetch, no POST, but list still runs', async () => {
    const args = baseArgs()
    args.dryRun = true
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {},
      ghHooks: [],
      mcpRead: { exists: false },
    })
    await runInstall(args, deps, io)

    // No mutations
    assert.equal(calls.generateSecretCalls, 0)
    assert.equal(calls.fetchSmeeCalls, 0)
    assert.equal(calls.writeStateCalls, 0)
    assert.equal(calls.ghCreateHookCalls, 0)
    assert.equal(calls.writeMcpJsonCalls, 0)
    // Read-only calls DO run
    assert.equal(calls.ghListHooksCalls, 1)
    assert.equal(calls.readStateCalls, 1)
    assert.equal(calls.readMcpJsonCalls, 1)

    // Output mentions [dry-run] and [redacted]
    const joined = calls.info.join('\n')
    assert.match(joined, /\[dry-run\]/)
    assert.match(joined, /\[redacted\]/)
  })

  test('dry-run with existing state: reuses stored values, no fetch', async () => {
    const args = baseArgs()
    args.dryRun = true
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing',
        smeeUrl: 'https://smee.io/existing',
      },
      ghHooks: [],
    })
    await runInstall(args, deps, io)
    assert.equal(calls.fetchSmeeCalls, 0)
    assert.equal(calls.writeStateCalls, 0)
    assert.equal(calls.ghListHooksCalls, 1)
  })
})

describe('runInstall — --smee-url override', () => {
  test('matches stored state: no-op for state, no override warning', async () => {
    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/existing'
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing',
        smeeUrl: 'https://smee.io/existing',
      },
    })
    await runInstall(args, deps, io)
    const overrideWarnings = calls.warn.filter((w) => w.includes('Overriding smeeUrl'))
    assert.equal(overrideWarnings.length, 0)
  })

  test('differs from stored state: update, reuse secret, warn about old webhook', async () => {
    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/new'
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing-secret',
        smeeUrl: 'https://smee.io/old',
      },
      ghHooks: [],
    })
    await runInstall(args, deps, io)

    // State updated to new URL
    assert.equal(calls.writeStateLastArg?.smeeUrl, 'https://smee.io/new')
    // Existing secret reused (not regenerated)
    assert.equal(calls.generateSecretCalls, 0)
    assert.equal(calls.writeStateLastArg?.webhookSecret, 'existing-secret')
    // Override warning + old-webhook warning both present
    const overrideWarnings = calls.warn.filter((w) => w.includes('Overriding smeeUrl'))
    assert.equal(overrideWarnings.length, 1)
    const oldWebhookWarnings = calls.warn.filter((w) =>
      w.includes('old webhook'),
    )
    assert.equal(oldWebhookWarnings.length, 1)
    // New webhook created
    assert.equal(calls.ghCreateHookCalls, 1)
  })

  test('passed, state has no URL → CLI value used, no override warning', async () => {
    const args = baseArgs()
    args.smeeUrl = 'https://smee.io/from-cli'
    const { deps, io, calls } = buildMockDepsAndIo({
      existingState: {
        webhookSecret: 'existing',
      },
    })
    await runInstall(args, deps, io)
    assert.equal(calls.writeStateLastArg?.smeeUrl, 'https://smee.io/from-cli')
    assert.equal(calls.fetchSmeeCalls, 0)
    const overrideWarnings = calls.warn.filter((w) => w.includes('Overriding smeeUrl'))
    assert.equal(overrideWarnings.length, 0)
  })
})

describe('runInstall — legacy global state', () => {
  test('legacy global state exists → informational note emitted', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({ legacyGlobal: true })
    await runInstall(baseArgs(), deps, io)
    const legacyNotes = calls.info.filter((m) => m.includes('legacy global state'))
    assert.equal(legacyNotes.length, 1)
  })

  test('no legacy global state → no note', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({ legacyGlobal: false })
    await runInstall(baseArgs(), deps, io)
    const legacyNotes = calls.info.filter((m) => m.includes('legacy global state'))
    assert.equal(legacyNotes.length, 0)
  })
})

describe('runInstall — .gitignore warning', () => {
  test('not gitignored → io.warn called with "not in .gitignore"', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({ gitignored: false })
    await runInstall(baseArgs(), deps, io)
    const giWarnings = calls.warn.filter((w) => w.includes('not in .gitignore'))
    assert.equal(giWarnings.length, 1)
  })

  test('gitignored → no warning emitted', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({ gitignored: true })
    await runInstall(baseArgs(), deps, io)
    const giWarnings = calls.warn.filter((w) => w.includes('not in .gitignore'))
    assert.equal(giWarnings.length, 0)
  })
})

describe('runInstall — conditional next-steps reminder', () => {
  test('new .mcp.json (created) → reminder shown', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      mcpRead: { exists: false },
    })
    await runInstall(baseArgs(), deps, io)
    const reminder = calls.info.filter((m) =>
      m.includes('project-scoped MCP servers need explicit approval'),
    )
    assert.equal(reminder.length, 1)
  })

  test('merged .mcp.json → reminder shown', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      mcpRead: {
        exists: true,
        content: { mcpServers: { other: { command: 'x' } } },
        indent: 2,
      },
    })
    await runInstall(baseArgs(), deps, io)
    const reminder = calls.info.filter((m) =>
      m.includes('project-scoped MCP servers need explicit approval'),
    )
    assert.equal(reminder.length, 1)
  })

  test('skipped_exists .mcp.json → reminder omitted', async () => {
    const { deps, io, calls } = buildMockDepsAndIo({
      mcpRead: {
        exists: true,
        content: {
          mcpServers: { ci: { command: 'npx', args: ['-y', 'ci-channel'] } },
        },
        indent: 2,
      },
    })
    await runInstall(baseArgs(), deps, io)
    const reminder = calls.info.filter((m) =>
      m.includes('project-scoped MCP servers need explicit approval'),
    )
    assert.equal(reminder.length, 0)
  })
})
