/**
 * Smoke tests for the top-level `setup` subcommand dispatch in server.ts.
 *
 * These tests spawn the server binary as a subprocess so they catch any
 * regression in:
 *   - ESM top-level await + dynamic import ordering
 *   - argv[2] dispatch matching
 *   - process.exit propagation of the runSetup exit code
 *   - usage text reaching stdout
 *   - error messages reaching stderr
 *
 * There are two flavors:
 *   - Source path: spawn `node --import tsx/esm server.ts setup ...`
 *     Fast; catches nearly everything. Runs unconditionally.
 *   - Built path: build and spawn `node dist/server.js setup ...`
 *     Validates the compiled artifact that `npx ci-channel` actually runs.
 *     Skipped if CI_CHANNEL_SKIP_BUILD_SMOKE=1 is set (for fast local iteration).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Spawn a command synchronously; stdio is captured, stdin is /dev/null. */
function run(command: string, args: string[], cwd: string = PLUGIN_DIR): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    env: { ...process.env },
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Source path spawn helper. */
function runSource(setupArgs: string[]): RunResult {
  return run('node', ['--import', 'tsx/esm', 'server.ts', 'setup', ...setupArgs])
}

describe('setup subcommand dispatch (source path)', () => {
  test(
    'setup --help exits 0 and prints usage on stdout',
    { timeout: 30000 },
    () => {
      const result = runSource(['--help'])
      assert.equal(result.code, 0, `stderr: ${result.stderr}`)
      assert.match(result.stdout, /Usage: ci-channel setup/)
      assert.match(result.stdout, /--repo/)
    },
  )

  test(
    'setup --yes (no --repo) exits non-zero with --yes requires --repo',
    { timeout: 30000 },
    () => {
      const result = runSource(['--yes'])
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /--yes requires --repo/)
    },
  )

  test(
    'setup --forge gitlab --yes --repo o/r exits non-zero with v1 scoping message',
    { timeout: 30000 },
    () => {
      const result = runSource(['--forge', 'gitlab', '--yes', '--repo', 'owner/repo'])
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /MCP server itself supports all three forges/)
    },
  )

  test(
    'setup --repo owner/repo --yes exits 0 in phase 1 scaffolding',
    { timeout: 30000 },
    () => {
      // Phase 1 scaffolding prints "not yet implemented" and exits 0.
      // Later phases will add real install behavior; this test locks the
      // scaffolding contract so the dispatch path is exercised end-to-end.
      const result = runSource(['--repo', 'owner/repo', '--yes'])
      assert.equal(result.code, 0, `stderr: ${result.stderr}`)
      assert.match(result.stderr, /parsed args/)
    },
  )
})

describe('setup subcommand dispatch (built path)', () => {
  // Validates the compiled dist/server.js entry point that `npx ci-channel`
  // actually invokes. Ensures dynamic import resolution works after
  // tsc compilation.
  test(
    'built dist/server.js setup --help exits 0',
    { timeout: 120000 },
    (t) => {
      if (process.env.CI_CHANNEL_SKIP_BUILD_SMOKE === '1') {
        t.skip('CI_CHANNEL_SKIP_BUILD_SMOKE=1 set')
        return
      }

      // Build if dist/ is stale or missing.
      const distEntry = join(PLUGIN_DIR, 'dist', 'server.js')
      const serverSrc = join(PLUGIN_DIR, 'server.ts')
      const needsBuild =
        !existsSync(distEntry) ||
        statSync(serverSrc).mtimeMs > statSync(distEntry).mtimeMs

      if (needsBuild) {
        const buildResult = run('npm', ['run', 'build'])
        if (buildResult.code !== 0) {
          throw new Error(`npm run build failed:\n${buildResult.stderr}`)
        }
      }

      const result = run('node', [distEntry, 'setup', '--help'])
      assert.equal(result.code, 0, `stderr: ${result.stderr}`)
      assert.match(result.stdout, /Usage: ci-channel setup/)
    },
  )
})
