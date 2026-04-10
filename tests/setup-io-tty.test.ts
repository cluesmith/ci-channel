/**
 * Tests for the TTY + interactive repo prompt path.
 *
 * parseSetupArgs enforces the matrix (non-TTY + no --yes → fail fast,
 * etc.) — those tests live in setup-args.test.ts. This file reinforces
 * that coverage AND tests the runSetup-layer promptForRepo loop that
 * handles `repo === null` in TTY mode.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSetupArgs } from '../lib/setup/args.js'
import { SetupError } from '../lib/setup/errors.js'
import { promptForRepo } from '../lib/setup/index.js'
import type { Io } from '../lib/setup/orchestrator.js'

describe('TTY matrix — parseSetupArgs (reinforcement)', () => {
  test('non-TTY + !yes → SetupError (stdin is not a TTY)', () => {
    assert.throws(
      () => parseSetupArgs([], { isTty: () => false }),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('stdin is not a TTY'),
    )
  })

  test('TTY + !yes + !repo → parses, repo is null (runner will prompt)', () => {
    const result = parseSetupArgs([], { isTty: () => true })
    assert.equal(result.kind, 'run')
    if (result.kind === 'run') {
      assert.equal(result.args.repo, null)
      assert.equal(result.args.yes, false)
    }
  })

  test('TTY + yes + !repo → SetupError (--yes requires --repo)', () => {
    assert.throws(
      () => parseSetupArgs(['--yes'], { isTty: () => true }),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('--yes requires --repo'),
    )
  })
})

function scriptedIo(prompts: string[]): Io & { promptHistory: string[]; warns: string[] } {
  const queue = [...prompts]
  const warns: string[] = []
  const promptHistory: string[] = []
  return {
    promptHistory,
    warns,
    info: () => {},
    warn: (msg) => warns.push(msg),
    confirm: async () => true,
    prompt: async (message) => {
      promptHistory.push(message)
      if (queue.length === 0) {
        throw new Error(`Unexpected prompt call (no scripted answer): ${message}`)
      }
      return queue.shift()!
    },
  }
}

describe('promptForRepo — interactive repo prompt loop', () => {
  test('accepts valid input on first attempt', async () => {
    const io = scriptedIo(['owner/repo'])
    const result = await promptForRepo(io)
    assert.equal(result, 'owner/repo')
    assert.equal(io.promptHistory.length, 1)
  })

  test('re-prompts on invalid input, accepts valid on retry', async () => {
    const io = scriptedIo(['bad value', 'owner/repo'])
    const result = await promptForRepo(io)
    assert.equal(result, 'owner/repo')
    assert.equal(io.promptHistory.length, 2)
    assert.equal(io.warns.length, 1)
    assert.match(io.warns[0], /Invalid repo format/)
  })

  test('three invalid attempts → SetupError "too many attempts"', async () => {
    const io = scriptedIo(['bad', 'worse', 'worst'])
    await assert.rejects(
      () => promptForRepo(io),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('Too many invalid repo attempts'),
    )
    assert.equal(io.promptHistory.length, 3)
    assert.equal(io.warns.length, 3)
  })

  test('accepts repos with dots, underscores, dashes', async () => {
    const io = scriptedIo(['my-org.co/my_repo-v2.0'])
    const result = await promptForRepo(io)
    assert.equal(result, 'my-org.co/my_repo-v2.0')
  })

  test('rejects empty string as invalid', async () => {
    const io = scriptedIo(['', '', ''])
    await assert.rejects(
      () => promptForRepo(io),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('Too many invalid repo attempts'),
    )
  })

  test('rejects owner-without-repo as invalid', async () => {
    const io = scriptedIo(['owner', 'owner/', 'just-owner'])
    await assert.rejects(
      () => promptForRepo(io),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('Too many invalid repo attempts'),
    )
  })
})
