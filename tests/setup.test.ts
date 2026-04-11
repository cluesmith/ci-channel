import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setup } from '../lib/setup.js'

const WIN = process.platform === 'win32'
const URL_ = 'https://smee.io/test-channel-abc'
const SECRET = 'a'.repeat(64)
const CI_ENTRY = { command: 'npx', args: ['-y', 'ci-channel'] }
const MCP_CI_ONLY = JSON.stringify({ mcpServers: { ci: CI_ENTRY } }, null, 2) + '\n'

type FakeResp = { stdout?: string; stderr?: string; exit?: number }

function mkFakeGh(bin: string, responses: FakeResp[]): void {
  mkdirSync(bin, { recursive: true })
  for (const [i, r] of responses.entries()) {
    const n = i + 1
    writeFileSync(join(bin, `gh.out.${n}`), r.stdout ?? '')
    writeFileSync(join(bin, `gh.err.${n}`), r.stderr ?? '')
    writeFileSync(join(bin, `gh.exit.${n}`), String(r.exit ?? 0))
  }
  const script = `#!/bin/sh
B='${bin}'
N=$(cat "$B/gh.counter" 2>/dev/null || echo 0); N=$((N+1)); echo "$N" > "$B/gh.counter"
printf '%s\\n' "$@" > "$B/gh.args.$N"
cat > "$B/gh.stdin.$N"
cat "$B/gh.out.$N" 2>/dev/null
cat "$B/gh.err.$N" >&2 2>/dev/null
exit "$(cat "$B/gh.exit.$N")"
`
  writeFileSync(join(bin, 'gh'), script, { mode: 0o755 })
}

const ghArgs = (bin: string, n: number) =>
  readFileSync(join(bin, `gh.args.${n}`), 'utf-8').trimEnd().replaceAll('\n', ' ')
const ghStdin = (bin: string, n: number) => readFileSync(join(bin, `gh.stdin.${n}`), 'utf-8')

function seedState(root: string, state: Record<string, string>): string {
  const dir = join(root, '.claude', 'channels', 'ci')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  return path
}

type Result = { exitCode: number | null; stderr: string }

async function runSetup(argv: string[]): Promise<Result> {
  const oExit = process.exit
  const oErrWrite = process.stderr.write.bind(process.stderr)
  let stderr = ''
  let exitCode: number | null = null
  // Capture stderr only; leave stdout alone so node:test TAP isn't swallowed.
  process.stderr.write = ((s: unknown) => { stderr += String(s); return true }) as typeof process.stderr.write
  process.exit = ((c?: number) => { exitCode = c ?? 0; throw new Error('__EXIT__') }) as never
  try { await setup(argv) }
  catch (e) { if ((e as Error).message !== '__EXIT__') throw e }
  finally { process.exit = oExit; process.stderr.write = oErrWrite }
  return { exitCode, stderr }
}

async function inProject(fn: (ctx: { root: string; bin: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ci-setup-'))
  const bin = join(root, '_bin')
  mkdirSync(join(root, '.git'))
  const prevCwd = process.cwd()
  const prevPath = process.env.PATH
  process.env.PATH = `${bin}:${prevPath}`
  process.chdir(root)
  try {
    await fn({ root, bin })
  } finally {
    process.chdir(prevCwd)
    process.env.PATH = prevPath
    rmSync(root, { recursive: true, force: true })
  }
}

describe('ci-channel setup', () => {
  test('1. fresh install with prepopulated state: POST + .mcp.json created', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeGh(bin, [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(ghArgs(bin, 1), /--paginate --slurp repos\/foo\/bar\/hooks/)
      assert.match(ghArgs(bin, 2), /--method POST repos\/foo\/bar\/hooks --input -/)
      const payload = JSON.parse(ghStdin(bin, 2))
      assert.equal(payload.config.url, URL_)
      assert.equal(payload.config.secret, SECRET)
      assert.equal(payload.config.content_type, 'json')
      assert.deepEqual(payload.events, ['workflow_run'])
      assert.equal(payload.active, true)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
      assert.equal(statSync(statePath).mode & 0o777, 0o600)
    })
  })

  test('2. idempotent re-run: PATCH once, state + .mcp.json byte-equal', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeGh(bin, [
        { stdout: JSON.stringify([[{ id: 42, config: { url: URL_ } }]]) },
        { stdout: '{}' },
      ])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(ghArgs(bin, 2), /--method PATCH repos\/foo\/bar\/hooks\/42 --input -/)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
    })
  })

  test('3. state present, webhook missing: CREATE with existing secret', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeGh(bin, [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(ghArgs(bin, 2), /--method POST/)
      assert.equal(JSON.parse(ghStdin(bin, 2)).config.secret, SECRET)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
    })
  })

  test('4. .mcp.json with other servers: ci added, other preserved', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const other = { command: 'foo', args: ['bar'] }
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other } }, null, 2) + '\n')
      mkFakeGh(bin, [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      assert.deepEqual(mcp.mcpServers.other, other)
      assert.deepEqual(mcp.mcpServers.ci, CI_ENTRY)
    })
  })

  test('5. CREATE failure → state written with fresh secret before POST', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { smeeUrl: URL_ })
      mkFakeGh(bin, [{ stdout: '[[]]' }, { stdout: '', stderr: 'API error', exit: 1 }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, 1)
      assert.match(res.stderr, /setup failed/)
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))
      assert.equal(state.smeeUrl, URL_)
      assert.ok(typeof state.webhookSecret === 'string' && state.webhookSecret.length > 0, 'state-first: fresh secret must be on disk before POST')
    })
  })

  test('6. project root discovered from subdirectory', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const sub = join(root, 'src', 'foo')
      mkdirSync(sub, { recursive: true })
      mkFakeGh(bin, [{ stdout: '[[]]' }, { stdout: '{}' }])
      process.chdir(sub)
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(existsSync(join(root, '.mcp.json')), '.mcp.json written at root')
      assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8')).mcpServers.ci, CI_ENTRY)
    })
  })

  test('7. no project root → exit 1 with clear error', async () => {
    const leaf = mkdtempSync(join(tmpdir(), 'ci-noroot-'))
    const prevCwd = process.cwd()
    try {
      process.chdir(leaf)
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, 1)
      assert.match(res.stderr, /project root/)
    } finally {
      process.chdir(prevCwd)
      rmSync(leaf, { recursive: true, force: true })
    }
  })

  test('8. missing --repo OR unknown flag → exit 1 with usage message', async () => {
    let res = await runSetup([])
    assert.equal(res.exitCode, 1)
    assert.match(res.stderr, /--repo/)
    res = await runSetup(['--repo', 'foo/bar', '--nonsense'])
    assert.equal(res.exitCode, 1)
    assert.match(res.stderr, /unexpected arg: --nonsense/)
  })
})
