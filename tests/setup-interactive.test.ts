/**
 * Tests for the Phase 3 interactive path: confirmation prompts before
 * each mutating step, decline handling, and interactive repo prompting.
 *
 * Uses a scripted mock `Io` that feeds canned answers — no real TTY
 * or @inquirer/prompts interaction needed. (The real Io wrapper is
 * exercised via type-checking and manual smoke tests; injecting the
 * mock through the orchestrator's dependency-injection seam keeps
 * these tests fast and hermetic.)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginState } from '../lib/state.js'
import { runInstall, type InstallDeps, type Io } from '../lib/setup/orchestrator.js'
import { SetupError, UserDeclinedError } from '../lib/setup/errors.js'
import type { GhHook } from '../lib/setup/gh.js'
import type { McpJsonReadResult, McpJson } from '../lib/setup/mcp-json.js'
import type { SetupArgs } from '../lib/setup/types.js'

function interactiveArgs(overrides: Partial<SetupArgs> = {}): SetupArgs {
  return {
    repo: 'owner/repo',
    forge: 'github',
    yes: false, // interactive mode
    dryRun: false,
    smeeUrl: null,
    ...overrides,
  }
}

interface ScriptedIo extends Io {
  confirms: boolean[]
  prompts: string[]
  confirmHistory: string[]
  promptHistory: string[]
  infos: string[]
  warns: string[]
}

/**
 * Build an Io that feeds scripted answers to confirm/prompt calls.
 * `confirms` is a queue of boolean answers (one per io.confirm call).
 * `prompts` is a queue of string answers (one per io.prompt call).
 */
function scriptedIo({
  confirms = [],
  prompts = [],
}: {
  confirms?: boolean[]
  prompts?: string[]
} = {}): ScriptedIo {
  const io: ScriptedIo = {
    confirms: [...confirms],
    prompts: [...prompts],
    confirmHistory: [],
    promptHistory: [],
    infos: [],
    warns: [],
    info: (msg) => io.infos.push(msg),
    warn: (msg) => io.warns.push(msg),
    confirm: async (message) => {
      io.confirmHistory.push(message)
      if (io.confirms.length === 0) {
        throw new Error(`Unexpected confirm call (no scripted answer): ${message}`)
      }
      return io.confirms.shift()!
    },
    prompt: async (message) => {
      io.promptHistory.push(message)
      if (io.prompts.length === 0) {
        throw new Error(`Unexpected prompt call (no scripted answer): ${message}`)
      }
      return io.prompts.shift()!
    },
  }
  return io
}

interface MockCounts {
  writeStateCalls: number
  ghCreateHookCalls: number
  ghUpdateHookCalls: number
  writeMcpJsonCalls: number
  fetchSmeeCalls: number
}

function buildDeps(
  counts: MockCounts,
  overrides: {
    existingState?: PluginState
    ghHooks?: GhHook[]
    mcpRead?: McpJsonReadResult
  } = {},
): InstallDeps {
  return {
    detectProjectRoot: () => '/tmp/fake',
    readState: () => ({ ...(overrides.existingState ?? {}) }),
    writeState: () => {
      counts.writeStateCalls++
    },
    legacyGlobalStateExists: () => false,
    isGitignored: () => true,
    generateSecret: () => 'a'.repeat(64),
    fetchSmeeChannel: async () => {
      counts.fetchSmeeCalls++
      return 'https://smee.io/fresh'
    },
    ghListHooks: async () => overrides.ghHooks ?? [],
    ghCreateHook: async () => {
      counts.ghCreateHookCalls++
    },
    ghUpdateHook: async () => {
      counts.ghUpdateHookCalls++
    },
    readMcpJson: () => overrides.mcpRead ?? { exists: false },
    writeMcpJson: () => {
      counts.writeMcpJsonCalls++
    },
  }
}

describe('interactive orchestrator — all-yes path', () => {
  test('fresh install with all confirmations accepted: all steps run', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {}, ghHooks: [], mcpRead: { exists: false } })
    // Prompt order (iter6 — final): smee provision, write state,
    // create webhook, update .mcp.json.
    //
    // State is now written BEFORE the webhook step. Iter3/iter4 had
    // webhook-first because the skip path would otherwise be fooled
    // by pre-written state. Iter5 removed the skip path, which
    // dissolves that constraint — and state-first closes an orphan-
    // webhook failure mode in the CREATE path (ghCreateHook success
    // followed by writeState failure → orphan on next run).
    const io = scriptedIo({ confirms: [true, true, true, true] })
    await runInstall(interactiveArgs(), deps, io)

    assert.equal(counts.fetchSmeeCalls, 1)
    assert.equal(counts.writeStateCalls, 1)
    assert.equal(counts.ghCreateHookCalls, 1)
    assert.equal(counts.writeMcpJsonCalls, 1)

    // Prompt ordering lock (iter6): smee → state → webhook → mcp.
    assert.equal(io.confirmHistory.length, 4)
    assert.match(io.confirmHistory[0], /smee/)
    assert.match(io.confirmHistory[1], /credentials|state/)
    assert.match(io.confirmHistory[2], /webhook/)
    assert.match(io.confirmHistory[3], /\.mcp\.json/)
  })
})

describe('interactive orchestrator — decline paths', () => {
  test('decline at smee provision: no fetch, no state write, no webhook, no .mcp.json', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {} })
    const io = scriptedIo({ confirms: [false] })

    await assert.rejects(
      () => runInstall(interactiveArgs(), deps, io),
      (err: UserDeclinedError) =>
        err instanceof UserDeclinedError &&
        err.userMessage.includes('smee') &&
        err.exitCode === 0,
    )
    assert.equal(counts.fetchSmeeCalls, 0)
    assert.equal(counts.writeStateCalls, 0)
    assert.equal(counts.ghCreateHookCalls, 0)
    assert.equal(counts.writeMcpJsonCalls, 0)
  })

  test('decline at state write (before webhook): no state written, no webhook created', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {}, ghHooks: [] })
    // Iter6 order: smee → state → webhook → mcp.
    // Accept smee; decline state write. Because state comes first,
    // the webhook step never runs.
    const io = scriptedIo({ confirms: [true, false] })

    await assert.rejects(
      () => runInstall(interactiveArgs(), deps, io),
      (err: UserDeclinedError) =>
        err instanceof UserDeclinedError &&
        err.userMessage.includes('state.json') &&
        err.exitCode === 0,
    )
    assert.equal(counts.fetchSmeeCalls, 1) // ran before state prompt
    assert.equal(counts.writeStateCalls, 0)
    assert.equal(counts.ghCreateHookCalls, 0)
    assert.equal(counts.writeMcpJsonCalls, 0)
  })

  test('decline at webhook creation (after state written): state IS written; next run reuses it, no orphan', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {}, ghHooks: [] })
    // Iter6 order: smee → state → webhook → mcp.
    // Accept smee + state; decline webhook creation. State IS written,
    // but webhook is not. This is the "correct" recovery state: the
    // next run reads the stored state, reuses the smee URL + secret,
    // finds no matching hook, and creates the hook with the ALREADY-
    // STORED credentials — no orphan, no drift, no silent break.
    const io = scriptedIo({ confirms: [true, true, false] })

    await assert.rejects(
      () => runInstall(interactiveArgs(), deps, io),
      (err: UserDeclinedError) =>
        err instanceof UserDeclinedError &&
        err.userMessage.includes('webhook') &&
        err.exitCode === 0,
    )
    assert.equal(counts.fetchSmeeCalls, 1)
    assert.equal(counts.writeStateCalls, 1) // iter6: state is now persisted first
    assert.equal(counts.ghCreateHookCalls, 0)
    assert.equal(counts.writeMcpJsonCalls, 0)
  })

  test('decline at .mcp.json update: everything else done, .mcp.json untouched', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, {
      existingState: {},
      ghHooks: [],
      mcpRead: { exists: false },
    })
    // New order (iter3): smee → webhook → state → mcp. Accept the
    // first three, decline .mcp.json.
    const io = scriptedIo({ confirms: [true, true, true, false] })

    await assert.rejects(
      () => runInstall(interactiveArgs(), deps, io),
      (err: UserDeclinedError) =>
        err instanceof UserDeclinedError &&
        err.userMessage.includes('.mcp.json') &&
        err.exitCode === 0,
    )
    assert.equal(counts.fetchSmeeCalls, 1)
    assert.equal(counts.ghCreateHookCalls, 1)
    assert.equal(counts.writeStateCalls, 1) // state IS written — webhook succeeded first
    assert.equal(counts.writeMcpJsonCalls, 0)
  })
})

describe('interactive orchestrator — no prompts in --yes mode', () => {
  test('auto-yes Io shape: confirm always returns true without scripting', async () => {
    // This proves the orchestrator tests in setup-orchestrator.test.ts
    // (which use a silent auto-yes Io with confirm → true) still pass
    // with the new confirmation calls added to the orchestrator. It's
    // a sanity check that the io.confirm injection point is correct.
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {}, ghHooks: [], mcpRead: { exists: false } })
    const autoYesIo: Io = {
      info: () => {},
      warn: () => {},
      confirm: async () => true,
      prompt: async () => {
        throw new Error('should not be called')
      },
    }
    await runInstall(interactiveArgs({ yes: true }), deps, autoYesIo)
    assert.equal(counts.writeStateCalls, 1)
    assert.equal(counts.ghCreateHookCalls, 1)
    assert.equal(counts.writeMcpJsonCalls, 1)
  })
})

describe('interactive orchestrator — dry-run bypasses confirmations', () => {
  test('dry-run: confirmations not asked for skipped mutating steps', async () => {
    const counts: MockCounts = {
      writeStateCalls: 0,
      ghCreateHookCalls: 0,
      ghUpdateHookCalls: 0,
      writeMcpJsonCalls: 0,
      fetchSmeeCalls: 0,
    }
    const deps = buildDeps(counts, { existingState: {}, ghHooks: [], mcpRead: { exists: false } })
    // No scripted confirms — dry-run should skip them all.
    const io = scriptedIo({})
    await runInstall(interactiveArgs({ dryRun: true }), deps, io)

    // Dry-run: no mutations.
    assert.equal(counts.fetchSmeeCalls, 0)
    assert.equal(counts.writeStateCalls, 0)
    assert.equal(counts.ghCreateHookCalls, 0)
    assert.equal(counts.writeMcpJsonCalls, 0)

    // And no confirms were asked (dry-run takes an earlier branch).
    assert.equal(io.confirmHistory.length, 0)
  })
})
