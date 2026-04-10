/**
 * End-to-end integration test for the non-interactive installer.
 *
 * Uses a real temporary project directory with real filesystem I/O for
 * state.json and .mcp.json, but mocks gh (ghListHooks, ghCreateHook)
 * and fetchSmeeChannel so the test is hermetic.
 *
 * Also verifies `findProjectRoot` detection from a nested subdirectory
 * (spec scenario 11).
 */
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot } from '../lib/project-root.js'
import type { PluginState } from '../lib/state.js'
import { runInstall, type InstallDeps, type Io } from '../lib/setup/orchestrator.js'
import {
  legacyGlobalStateExists,
  readStateForSetup,
  writeStateForSetup,
  stateFilePath,
} from '../lib/setup/state.js'
import {
  readMcpJson,
  writeMcpJson,
  CI_SERVER_ENTRY,
} from '../lib/setup/mcp-json.js'
import type { GhHook } from '../lib/setup/gh.js'
import type { SetupArgs } from '../lib/setup/types.js'

let tmpRoot: string

function baseArgs(overrides: Partial<SetupArgs> = {}): SetupArgs {
  return {
    repo: 'owner/repo',
    forge: 'github',
    yes: true,
    dryRun: false,
    smeeUrl: null,
    ...overrides,
  }
}

/** Silent Io — no console output during tests. */
function silentIo(): Io {
  return {
    info: () => {},
    warn: () => {},
    confirm: async () => true,
    prompt: async () => {
      throw new Error('prompt should not be called')
    },
  }
}

interface TrackingMock {
  ghCreateHookCalls: number
  ghCreateHookLastPayload: object | null
  ghUpdateHookCalls: number
  ghUpdateHookLastPayload: object | null
  ghUpdateHookLastHookId: number | null
  ghListHooksResult: GhHook[]
  fetchedSmeeUrl: string | null
}

function buildDeps(projectRoot: string, mock: TrackingMock): InstallDeps {
  return {
    detectProjectRoot: () => projectRoot,
    readState: readStateForSetup,
    writeState: writeStateForSetup,
    legacyGlobalStateExists, // real — but test doesn't care about value
    isGitignored: () => true, // pretend gitignored so no warning clutters output
    generateSecret: () => 'a'.repeat(64),
    fetchSmeeChannel: async () => mock.fetchedSmeeUrl,
    ghListHooks: async () => mock.ghListHooksResult,
    ghCreateHook: async (_repo, payload) => {
      mock.ghCreateHookCalls++
      mock.ghCreateHookLastPayload = payload
    },
    ghUpdateHook: async (_repo, hookId, payload) => {
      mock.ghUpdateHookCalls++
      mock.ghUpdateHookLastPayload = payload
      mock.ghUpdateHookLastHookId = hookId
    },
    readMcpJson,
    writeMcpJson,
  }
}

describe('setup integration (real fs)', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ci-channel-setup-'))
    // Create a .git/ marker so findProjectRoot can resolve from subdirs.
    mkdirSync(join(tmpRoot, '.git'), { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true })
    } catch {}
  })

  test('fresh install writes state.json (mode 0o600) + .mcp.json + creates webhook', async () => {
    const mock: TrackingMock = {
      ghCreateHookCalls: 0,
      ghCreateHookLastPayload: null,
      ghUpdateHookCalls: 0,
      ghUpdateHookLastPayload: null,
      ghUpdateHookLastHookId: null,
      ghListHooksResult: [],
      fetchedSmeeUrl: 'https://smee.io/deterministic-channel',
    }
    const deps = buildDeps(tmpRoot, mock)

    await runInstall(baseArgs(), deps, silentIo())

    // state.json present
    const statePath = stateFilePath(tmpRoot)
    assert.ok(existsSync(statePath), 'state.json should exist')
    const stateContent: PluginState = JSON.parse(
      readFileSync(statePath, 'utf-8'),
    )
    assert.equal(stateContent.smeeUrl, 'https://smee.io/deterministic-channel')
    assert.equal(stateContent.webhookSecret?.length, 64)

    // state.json mode 0o600 (POSIX only)
    if (process.platform !== 'win32') {
      const mode = statSync(statePath).mode & 0o777
      assert.equal(mode, 0o600, `expected mode 0o600, got 0o${mode.toString(8)}`)
    }

    // .mcp.json present with ci entry
    const mcpPath = join(tmpRoot, '.mcp.json')
    assert.ok(existsSync(mcpPath))
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    assert.deepEqual(mcp.mcpServers.ci, { ...CI_SERVER_ENTRY })

    // Webhook created once with expected payload
    assert.equal(mock.ghCreateHookCalls, 1)
    const payload = mock.ghCreateHookLastPayload as {
      config: { url: string; secret: string }
      events: string[]
      active: boolean
    }
    assert.equal(payload.config.url, 'https://smee.io/deterministic-channel')
    assert.equal(payload.config.secret, 'a'.repeat(64))
    assert.deepEqual(payload.events, ['workflow_run'])
    assert.equal(payload.active, true)
  })

  test('idempotent second run: no extra webhook, state write skipped entirely', async () => {
    const mock: TrackingMock = {
      ghCreateHookCalls: 0,
      ghCreateHookLastPayload: null,
      ghUpdateHookCalls: 0,
      ghUpdateHookLastPayload: null,
      ghUpdateHookLastHookId: null,
      ghListHooksResult: [],
      fetchedSmeeUrl: 'https://smee.io/deterministic-channel',
    }
    const deps = buildDeps(tmpRoot, mock)

    // First run
    await runInstall(baseArgs(), deps, silentIo())
    const stateSnapshot1 = readFileSync(stateFilePath(tmpRoot), 'utf-8')
    const mcpSnapshot1 = readFileSync(join(tmpRoot, '.mcp.json'), 'utf-8')
    const statePath = stateFilePath(tmpRoot)
    const stateMtime1 = statSync(statePath).mtimeMs

    // Second run — simulate webhook already present
    mock.ghListHooksResult = [
      { id: 42, config: { url: 'https://smee.io/deterministic-channel' } },
    ]
    await runInstall(baseArgs(), deps, silentIo())

    // Exactly ONE ghCreateHook call total (from the first run).
    assert.equal(mock.ghCreateHookCalls, 1)

    // State file byte-identical.
    const stateSnapshot2 = readFileSync(statePath, 'utf-8')
    assert.equal(stateSnapshot2, stateSnapshot1)

    // And the idempotent re-run should NOT have touched state.json — its
    // mtime should be unchanged because writeStateForSetup was skipped.
    const stateMtime2 = statSync(statePath).mtimeMs
    assert.equal(
      stateMtime2,
      stateMtime1,
      'idempotent re-run should not rewrite state.json',
    )

    // .mcp.json unchanged (entry already present, write skipped).
    const mcpSnapshot2 = readFileSync(join(tmpRoot, '.mcp.json'), 'utf-8')
    assert.equal(mcpSnapshot2, mcpSnapshot1)
  })

  test('writeStateForSetup enforces 0o600 on existing files with looser mode', async () => {
    if (process.platform === 'win32') return // POSIX-only

    const mock: TrackingMock = {
      ghCreateHookCalls: 0,
      ghCreateHookLastPayload: null,
      ghUpdateHookCalls: 0,
      ghUpdateHookLastPayload: null,
      ghUpdateHookLastHookId: null,
      ghListHooksResult: [],
      fetchedSmeeUrl: 'https://smee.io/x',
    }
    const deps = buildDeps(tmpRoot, mock)

    // Pre-create state.json with loose 0o644 permissions.
    const { chmodSync } = await import('node:fs')
    const statePath = stateFilePath(tmpRoot)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tmpRoot, '.claude/channels/ci'), { recursive: true })
    writeFileSync(statePath, '{}', { mode: 0o644 })
    chmodSync(statePath, 0o644) // Force loose mode even if umask would restrict.

    // Run install with --smee-url that differs from stored state (forces
    // a rewrite path on the existing file).
    await runInstall(
      baseArgs({ smeeUrl: 'https://smee.io/fresh-new-url' }),
      deps,
      silentIo(),
    )

    // After the write, the file should be 0o600 regardless of its
    // pre-existing mode bits.
    const mode = statSync(statePath).mode & 0o777
    assert.equal(
      mode,
      0o600,
      `expected 0o600 after rewrite, got 0o${mode.toString(8)}`,
    )
  })

  test('.mcp.json with other server is merged, other preserved', async () => {
    writeFileSync(
      join(tmpRoot, '.mcp.json'),
      JSON.stringify(
        { mcpServers: { other: { command: 'foo', args: ['bar'] } } },
        null,
        2,
      ) + '\n',
    )

    const mock: TrackingMock = {
      ghCreateHookCalls: 0,
      ghCreateHookLastPayload: null,
      ghUpdateHookCalls: 0,
      ghUpdateHookLastPayload: null,
      ghUpdateHookLastHookId: null,
      ghListHooksResult: [],
      fetchedSmeeUrl: 'https://smee.io/fresh',
    }
    const deps = buildDeps(tmpRoot, mock)

    await runInstall(baseArgs(), deps, silentIo())

    const mcp = JSON.parse(
      readFileSync(join(tmpRoot, '.mcp.json'), 'utf-8'),
    )
    assert.deepEqual(mcp.mcpServers.other, { command: 'foo', args: ['bar'] })
    assert.deepEqual(mcp.mcpServers.ci, { ...CI_SERVER_ENTRY })
  })

  test('dry-run: no state.json, no .mcp.json, no webhook POST', async () => {
    const mock: TrackingMock = {
      ghCreateHookCalls: 0,
      ghCreateHookLastPayload: null,
      ghUpdateHookCalls: 0,
      ghUpdateHookLastPayload: null,
      ghUpdateHookLastHookId: null,
      ghListHooksResult: [],
      fetchedSmeeUrl: null,
    }
    const deps = buildDeps(tmpRoot, mock)

    await runInstall(baseArgs({ dryRun: true }), deps, silentIo())

    assert.equal(existsSync(stateFilePath(tmpRoot)), false)
    assert.equal(existsSync(join(tmpRoot, '.mcp.json')), false)
    assert.equal(mock.ghCreateHookCalls, 0)
  })
})

describe('findProjectRoot — subdirectory detection (spec scenario 11)', () => {
  let projectRoot: string
  let nestedDir: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'ci-channel-subdir-'))
    mkdirSync(join(projectRoot, '.git'), { recursive: true })
    nestedDir = join(projectRoot, 'src', 'foo')
    mkdirSync(nestedDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true })
    } catch {}
  })

  test('findProjectRoot walks up from <tmp>/src/foo/ to <tmp>', () => {
    const detected = findProjectRoot(nestedDir)
    assert.equal(detected, projectRoot)
  })
})
