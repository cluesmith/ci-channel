import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  ghCreateHook,
  ghListHooks,
  ghUpdateHook,
  type SpawnFn,
} from '../lib/setup/gh.js'
import { SetupError } from '../lib/setup/errors.js'

/**
 * Minimal fake ChildProcess: emits `data` chunks on stdout/stderr,
 * then `close` with an exit code, unless an `errorCode` is provided
 * which triggers an `error` event instead of `close`.
 */
interface FakeChildOptions {
  stdout?: string
  stderr?: string
  exitCode?: number
  errorCode?: string
}

interface RecordedSpawn {
  command: string
  args: readonly string[]
  options: SpawnOptions
  stdinBytes: string
}

function makeFakeChild(
  opts: FakeChildOptions,
  spawnStdio: readonly ('pipe' | 'ignore' | 'inherit')[],
  recorder: RecordedSpawn,
): ChildProcess {
  const child = new EventEmitter() as ChildProcess

  // Attach fake stdout/stderr streams that emit the provided data.
  const stdoutEmitter = spawnStdio[1] === 'pipe' ? new EventEmitter() : null
  const stderrEmitter = spawnStdio[2] === 'pipe' ? new EventEmitter() : null
  ;(child as unknown as { stdout: EventEmitter | null }).stdout = stdoutEmitter
  ;(child as unknown as { stderr: EventEmitter | null }).stderr = stderrEmitter

  // Fake stdin that records bytes.
  const stdinStream = spawnStdio[0] === 'pipe'
    ? {
        end: (data: string | Buffer) => {
          recorder.stdinBytes = typeof data === 'string' ? data : data.toString()
        },
      }
    : null
  ;(child as unknown as { stdin: unknown }).stdin = stdinStream

  // Schedule emissions on next tick so listeners attach first.
  setImmediate(() => {
    if (opts.errorCode) {
      const err = new Error('spawn error') as NodeJS.ErrnoException
      err.code = opts.errorCode
      child.emit('error', err)
      return
    }
    if (opts.stdout && stdoutEmitter) {
      stdoutEmitter.emit('data', Buffer.from(opts.stdout))
    }
    if (opts.stderr && stderrEmitter) {
      stderrEmitter.emit('data', Buffer.from(opts.stderr))
    }
    child.emit('close', opts.exitCode ?? 0)
  })

  return child
}

/**
 * Build a SpawnFn that returns a fake child with the given behavior
 * and records the invocation in `recorder`.
 */
function fakeSpawn(
  opts: FakeChildOptions | ((args: readonly string[]) => FakeChildOptions),
  recorder: RecordedSpawn,
): SpawnFn {
  return (command, args, options) => {
    recorder.command = command
    recorder.args = args
    recorder.options = options
    const resolved = typeof opts === 'function' ? opts(args) : opts
    const stdioRaw = options.stdio
    const stdioArr = (Array.isArray(stdioRaw)
      ? (stdioRaw as readonly ('pipe' | 'ignore' | 'inherit')[])
      : ['pipe', 'pipe', 'pipe']) as readonly ('pipe' | 'ignore' | 'inherit')[]
    return makeFakeChild(resolved, stdioArr, recorder)
  }
}

function freshRecorder(): RecordedSpawn {
  return { command: '', args: [], options: {}, stdinBytes: '' }
}

describe('ghListHooks', () => {
  test('single-page --slurp output parses as JSON array', async () => {
    const recorder = freshRecorder()
    // --slurp wraps pages: [[{hook1}, {hook2}]]
    const stdout = JSON.stringify([
      [
        { id: 1, config: { url: 'https://smee.io/abc' } },
        { id: 2, config: { url: 'https://smee.io/def' } },
      ],
    ])
    const hooks = await ghListHooks('owner/repo', {
      spawn: fakeSpawn({ stdout, exitCode: 0 }, recorder),
    })

    assert.equal(recorder.command, 'gh')
    assert.deepEqual(
      [...recorder.args],
      ['api', '--paginate', '--slurp', 'repos/owner/repo/hooks'],
    )
    assert.equal(hooks.length, 2)
    assert.equal(hooks[0].config?.url, 'https://smee.io/abc')
    assert.equal(hooks[1].config?.url, 'https://smee.io/def')
  })

  test('multi-page --slurp output flattens pages', async () => {
    const recorder = freshRecorder()
    // --slurp with 3 pages: [[p1a, p1b], [p2a], [p3a, p3b, p3c]]
    const stdout = JSON.stringify([
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }],
      [{ id: 4 }, { id: 5 }, { id: 6 }],
    ])
    const hooks = await ghListHooks('owner/repo', {
      spawn: fakeSpawn({ stdout, exitCode: 0 }, recorder),
    })
    assert.equal(hooks.length, 6)
    assert.deepEqual(hooks.map((h) => h.id), [1, 2, 3, 4, 5, 6])
  })

  test('empty output returns empty array', async () => {
    const recorder = freshRecorder()
    const hooks = await ghListHooks('owner/repo', {
      spawn: fakeSpawn({ stdout: '', exitCode: 0 }, recorder),
    })
    assert.deepEqual(hooks, [])
  })

  test('--slurp unsupported → falls back to --paginate', async () => {
    const recorder = freshRecorder()
    let callCount = 0
    const spawner: SpawnFn = (command, args, options) => {
      callCount++
      recorder.command = command
      recorder.args = args
      recorder.options = options
      const stdioRaw = options.stdio
      const stdioArr = (Array.isArray(stdioRaw)
        ? (stdioRaw as readonly ('pipe' | 'ignore' | 'inherit')[])
        : ['pipe', 'pipe', 'pipe']) as readonly ('pipe' | 'ignore' | 'inherit')[]
      if (callCount === 1) {
        // First call: --slurp fails with "unknown flag".
        return makeFakeChild(
          {
            exitCode: 1,
            stderr: 'unknown flag: --slurp',
          },
          stdioArr,
          recorder,
        )
      }
      // Second call (fallback): return page-by-page output.
      return makeFakeChild(
        {
          stdout:
            JSON.stringify([{ id: 1 }, { id: 2 }]) +
            '\n' +
            JSON.stringify([{ id: 3 }]),
          exitCode: 0,
        },
        stdioArr,
        recorder,
      )
    }

    const hooks = await ghListHooks('owner/repo', { spawn: spawner })
    assert.equal(callCount, 2)
    assert.deepEqual([...recorder.args], [
      'api',
      '--paginate',
      'repos/owner/repo/hooks',
    ])
    assert.equal(hooks.length, 3)
    assert.deepEqual(hooks.map((h) => h.id), [1, 2, 3])
  })

  test('ENOENT → SetupError with install hint', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghListHooks('owner/repo', {
          spawn: fakeSpawn({ errorCode: 'ENOENT' }, recorder),
        }),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('gh CLI not found') &&
        err.userMessage.includes('cli.github.com'),
    )
  })

  test('non-zero exit (not --slurp issue) → SetupError with stderr', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghListHooks('owner/repo', {
          spawn: fakeSpawn(
            { exitCode: 4, stderr: 'HTTP 404: Not Found' },
            recorder,
          ),
        }),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('gh api failed') &&
        err.userMessage.includes('HTTP 404'),
    )
  })

  test('uses stdio: ["ignore", "pipe", "pipe"] for list (no stdin)', async () => {
    const recorder = freshRecorder()
    await ghListHooks('owner/repo', {
      spawn: fakeSpawn({ stdout: '[]', exitCode: 0 }, recorder),
    })
    const stdio = recorder.options.stdio
    assert.ok(Array.isArray(stdio))
    assert.deepEqual([...(stdio as unknown[])], ['ignore', 'pipe', 'pipe'])
  })
})

describe('ghCreateHook', () => {
  test('POSTs payload via piped stdin on success', async () => {
    const recorder = freshRecorder()
    const payload = {
      config: { url: 'https://smee.io/x', content_type: 'json', secret: 's' },
      events: ['workflow_run'],
      active: true,
    }
    await ghCreateHook('owner/repo', payload, {
      spawn: fakeSpawn({ exitCode: 0 }, recorder),
    })

    assert.equal(recorder.command, 'gh')
    assert.deepEqual(
      [...recorder.args],
      ['api', 'repos/owner/repo/hooks', '--method', 'POST', '--input', '-'],
    )
    assert.deepEqual(JSON.parse(recorder.stdinBytes), payload)
  })

  test('uses stdio: ["pipe", "pipe", "pipe"] — NOT inherit, NOT ignore', async () => {
    const recorder = freshRecorder()
    await ghCreateHook(
      'owner/repo',
      { config: { url: 'https://smee.io/x' } },
      { spawn: fakeSpawn({ exitCode: 0 }, recorder) },
    )
    const stdio = recorder.options.stdio
    assert.ok(Array.isArray(stdio), 'stdio must be an array')
    const stdioArr = [...(stdio as unknown[])]
    assert.deepEqual(stdioArr, ['pipe', 'pipe', 'pipe'])
    assert.notEqual(stdioArr[0], 'inherit', 'stdin must not inherit process.stdin')
    assert.notEqual(stdioArr[0], 'ignore', 'stdin must be a pipe for --input -')
  })

  test('non-zero exit → SetupError with stderr', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghCreateHook(
          'owner/repo',
          { config: {} },
          {
            spawn: fakeSpawn(
              {
                exitCode: 2,
                stderr: 'HTTP 422: Validation failed',
              },
              recorder,
            ),
          },
        ),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('gh api failed') &&
        err.userMessage.includes('Validation failed'),
    )
  })

  test('ENOENT → SetupError with install hint', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghCreateHook(
          'owner/repo',
          { config: {} },
          { spawn: fakeSpawn({ errorCode: 'ENOENT' }, recorder) },
        ),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('gh CLI not found'),
    )
  })
})

describe('ghUpdateHook', () => {
  test('PATCHes payload via piped stdin on success', async () => {
    const recorder = freshRecorder()
    const payload = {
      config: {
        url: 'https://smee.io/existing',
        content_type: 'json',
        secret: 'rotated',
      },
      events: ['workflow_run'],
      active: true,
    }
    await ghUpdateHook('owner/repo', 42, payload, {
      spawn: fakeSpawn({ exitCode: 0 }, recorder),
    })

    assert.equal(recorder.command, 'gh')
    assert.deepEqual(
      [...recorder.args],
      ['api', 'repos/owner/repo/hooks/42', '--method', 'PATCH', '--input', '-'],
    )
    assert.deepEqual(JSON.parse(recorder.stdinBytes), payload)
  })

  test('uses stdio: ["pipe", "pipe", "pipe"]', async () => {
    const recorder = freshRecorder()
    await ghUpdateHook(
      'owner/repo',
      1,
      { config: {} },
      { spawn: fakeSpawn({ exitCode: 0 }, recorder) },
    )
    const stdio = recorder.options.stdio
    assert.ok(Array.isArray(stdio))
    assert.deepEqual([...(stdio as unknown[])], ['pipe', 'pipe', 'pipe'])
  })

  test('non-zero exit → SetupError with stderr', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghUpdateHook(
          'owner/repo',
          42,
          { config: {} },
          {
            spawn: fakeSpawn(
              { exitCode: 1, stderr: 'HTTP 404: hook not found' },
              recorder,
            ),
          },
        ),
      (err: SetupError) =>
        err instanceof SetupError &&
        err.userMessage.includes('gh api failed') &&
        err.userMessage.includes('hook not found'),
    )
  })

  test('ENOENT → SetupError with install hint', async () => {
    const recorder = freshRecorder()
    await assert.rejects(
      () =>
        ghUpdateHook(
          'owner/repo',
          1,
          { config: {} },
          { spawn: fakeSpawn({ errorCode: 'ENOENT' }, recorder) },
        ),
      (err: SetupError) =>
        err instanceof SetupError && err.userMessage.includes('gh CLI not found'),
    )
  })
})
