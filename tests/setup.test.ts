import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setup, remove } from '../lib/setup.js'

const WIN = process.platform === 'win32'
const URL_ = 'https://smee.io/test-channel-abc'
const SECRET = 'a'.repeat(64)
const CI_ENTRY = { command: 'npx', args: ['-y', 'ci-channel'] }
const MCP_CI_ONLY = JSON.stringify({ mcpServers: { ci: CI_ENTRY } }, null, 2) + '\n'
const CODEV_FLAG = '--dangerously-load-development-channels server:ci'

type FakeResp = { stdout?: string; stderr?: string; exit?: number }

function mkFakeCli(bin: string, name: string, responses: FakeResp[]): void {
  mkdirSync(bin, { recursive: true })
  for (const [i, r] of responses.entries()) {
    const n = i + 1
    writeFileSync(join(bin, `${name}.out.${n}`), r.stdout ?? '')
    writeFileSync(join(bin, `${name}.err.${n}`), r.stderr ?? '')
    writeFileSync(join(bin, `${name}.exit.${n}`), String(r.exit ?? 0))
  }
  writeFileSync(join(bin, name), `#!/bin/sh
B='${bin}'
N=$(cat "$B/${name}.counter" 2>/dev/null || echo 0); N=$((N+1)); echo "$N" > "$B/${name}.counter"
printf '%s\\n' "$@" > "$B/${name}.args.$N"
cat > "$B/${name}.stdin.$N"
cat "$B/${name}.out.$N" 2>/dev/null
cat "$B/${name}.err.$N" >&2 2>/dev/null
exit "$(cat "$B/${name}.exit.$N")"
`, { mode: 0o755 })
}

const cliArgs = (bin: string, name: string, n: number) =>
  readFileSync(join(bin, `${name}.args.${n}`), 'utf-8').trimEnd().replaceAll('\n', ' ')
const cliStdin = (bin: string, name: string, n: number) => readFileSync(join(bin, `${name}.stdin.${n}`), 'utf-8')
const cliCount = (bin: string, name: string): number =>
  existsSync(join(bin, `${name}.counter`)) ? parseInt(readFileSync(join(bin, `${name}.counter`), 'utf-8').trim(), 10) || 0 : 0

const CI_DIR = (root: string) => join(root, '.claude', 'channels', 'ci')
function seedState(root: string, state: Record<string, string>): string {
  mkdirSync(CI_DIR(root), { recursive: true })
  const path = join(CI_DIR(root), 'state.json')
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  return path
}
function writeEnv(root: string, content: string): void {
  mkdirSync(CI_DIR(root), { recursive: true })
  writeFileSync(join(CI_DIR(root), '.env'), content)
}
function seedCodev(root: string, config: unknown): string {
  mkdirSync(join(root, '.codev'), { recursive: true })
  const path = join(root, '.codev', 'config.json')
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}

type Result = { exitCode: number | null; stderr: string }

async function runCommand(fn: (argv: string[]) => Promise<void>, argv: string[]): Promise<Result> {
  const oExit = process.exit
  const oErrWrite = process.stderr.write.bind(process.stderr)
  let stderr = ''
  let exitCode: number | null = null
  // Capture stderr only; leave stdout alone so node:test TAP isn't swallowed.
  process.stderr.write = ((s: unknown) => { stderr += String(s); return true }) as typeof process.stderr.write
  process.exit = ((c?: number) => { exitCode = c ?? 0; throw new Error('__EXIT__') }) as never
  try { await fn(argv) }
  catch (e) { if ((e as Error).message !== '__EXIT__') throw e }
  finally { process.exit = oExit; process.stderr.write = oErrWrite }
  return { exitCode, stderr }
}
const runSetup = (argv: string[]) => runCommand(setup, argv)
const runRemove = (argv: string[]) => runCommand(remove, argv)

async function inProject(fn: (ctx: { root: string; bin: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ci-setup-'))
  const bin = join(root, '_bin')
  mkdirSync(join(root, '.git'))
  const prevCwd = process.cwd(), prevPath = process.env.PATH, prevToken = process.env.GITEA_TOKEN
  process.env.PATH = `${bin}:${prevPath}`
  delete process.env.GITEA_TOKEN
  process.chdir(root)
  try { await fn({ root, bin }) }
  finally {
    process.chdir(prevCwd)
    process.env.PATH = prevPath
    if (prevToken === undefined) delete process.env.GITEA_TOKEN
    else process.env.GITEA_TOKEN = prevToken
    rmSync(root, { recursive: true, force: true })
  }
}

type GiteaReq = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

async function withGiteaServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string, reqs: GiteaReq[]) => Promise<void>,
): Promise<void> {
  const reqs: GiteaReq[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      reqs.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  try { await fn(`http://127.0.0.1:${port}`, reqs) }
  finally { await new Promise<void>((r) => server.close(() => r())) }
}

describe('ci-channel setup', () => {
  test('1. fresh install with prepopulated state: POST + .mcp.json created', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(cliArgs(bin, 'gh', 1), /--paginate --slurp repos\/foo\/bar\/hooks/)
      assert.match(cliArgs(bin, 'gh', 2), /--method POST repos\/foo\/bar\/hooks --input -/)
      const payload = JSON.parse(cliStdin(bin, 'gh', 2))
      assert.deepEqual(payload, { config: { url: URL_, content_type: 'json', secret: SECRET }, events: ['workflow_run'], active: true })
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
      mkFakeCli(bin, 'gh', [
        { stdout: JSON.stringify([[{ id: 42, config: { url: URL_ } }]]) },
        { stdout: '{}' },
      ])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(cliArgs(bin, 'gh', 2), /--method PATCH repos\/foo\/bar\/hooks\/42 --input -/)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
    })
  })

  test('3. state present, webhook missing: CREATE with existing secret', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(cliArgs(bin, 'gh', 2), /--method POST/)
      assert.equal(JSON.parse(cliStdin(bin, 'gh', 2)).config.secret, SECRET)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
    })
  })

  test('4. .mcp.json with other servers: ci added, other preserved', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const other = { command: 'foo', args: ['bar'] }
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other } }, null, 2) + '\n')
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
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
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '', stderr: 'API error', exit: 1 }])
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
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
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

  test('9. GitLab happy path: POST with canonical payload + .mcp.json created', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      mkFakeCli(bin, 'glab', [{ stdout: '[]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'group/project', '--forge', 'gitlab'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(cliArgs(bin, 'glab', 1), /api projects\/group%2Fproject\/hooks/)
      assert.match(cliArgs(bin, 'glab', 2), /api --method POST projects\/group%2Fproject\/hooks --input -/)
      const p = JSON.parse(cliStdin(bin, 'glab', 2))
      assert.equal(p.url, URL_); assert.equal(p.token, SECRET)
      assert.equal(p.pipeline_events, true); assert.equal(p.push_events, false)
      assert.equal(p.merge_requests_events, false); assert.equal(p.enable_ssl_verification, true)
      assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8')).mcpServers.ci, { command: 'npx', args: ['-y', 'ci-channel', '--forge', 'gitlab'] })
    })
  })

  test('10. GitLab idempotent re-run: PUT once', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const stateBefore = readFileSync(statePath, 'utf-8')
      mkFakeCli(bin, 'glab', [
        { stdout: JSON.stringify([{ id: 77, url: URL_ }]) },
        { stdout: '{}' },
      ])
      const res = await runSetup(['--repo', 'group/project', '--forge', 'gitlab'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(cliArgs(bin, 'glab', 2), /api --method PUT projects\/group%2Fproject\/hooks\/77 --input -/)
      assert.equal(cliCount(bin, 'glab'), 2)
      assert.equal(readFileSync(statePath, 'utf-8'), stateBefore)
      assert.equal(readFileSync(join(root, '.mcp.json'), 'utf-8'), MCP_CI_ONLY)
    })
  })

  test('11. GitLab subgroup path encoding', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      mkFakeCli(bin, 'glab', [{ stdout: '[]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'group/subgroup/project', '--forge', 'gitlab'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      const firstCall = cliArgs(bin, 'glab', 1)
      assert.match(firstCall, /projects\/group%2Fsubgroup%2Fproject\/hooks/)
      // Round-trip check: decoded path should match the original --repo value
      const m = firstCall.match(/projects\/([^\/]+)\/hooks/)
      assert.ok(m, 'could not extract encoded path from glab args')
      assert.equal(decodeURIComponent(m![1]), 'group/subgroup/project')
    })
  })

  test('12. Gitea happy path: POST with type field + Authorization header', { skip: WIN }, async () => {
    await inProject(async ({ root }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeEnv(root, 'GITEA_TOKEN=fake-token\n')
      await withGiteaServer((req, res) => {
        res.writeHead(req.method === 'GET' ? 200 : 201, { 'content-type': 'application/json' })
        res.end(req.method === 'GET' ? '[]' : '{}')
      }, async (serverUrl, reqs) => {
        const res = await runSetup(['--repo', 'owner/repo', '--forge', 'gitea', '--gitea-url', serverUrl])
        assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
        assert.equal(reqs.length, 2)
        assert.equal(reqs[0].method, 'GET'); assert.equal(reqs[0].url, '/api/v1/repos/owner/repo/hooks')
        assert.equal(reqs[0].headers.authorization, 'token fake-token')
        assert.equal(reqs[0].headers['content-type'], undefined, 'GET should have no Content-Type header')
        assert.equal(reqs[1].method, 'POST'); assert.equal(reqs[1].headers['content-type'], 'application/json')
        assert.deepEqual(JSON.parse(reqs[1].body), { type: 'gitea', config: { url: URL_, content_type: 'json', secret: SECRET }, events: ['workflow_run'], active: true })
        assert.deepEqual(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8')).mcpServers.ci, { command: 'npx', args: ['-y', 'ci-channel', '--forge', 'gitea', '--gitea-url', serverUrl] })
      })
    })
  })

  test('13. Gitea idempotent re-run: PATCH body omits type field', { skip: WIN }, async () => {
    await inProject(async ({ root }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeEnv(root, 'GITEA_TOKEN=fake-token\n')
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      await withGiteaServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(req.method === 'GET' ? JSON.stringify([{ id: 99, config: { url: URL_ } }]) : '{}')
      }, async (serverUrl, reqs) => {
        const res = await runSetup(['--repo', 'owner/repo', '--forge', 'gitea', '--gitea-url', serverUrl])
        assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
        const patchReq = reqs.find((r) => r.method === 'PATCH')
        assert.ok(patchReq, 'expected a PATCH request')
        assert.equal(patchReq!.url, '/api/v1/repos/owner/repo/hooks/99')
        const body = JSON.parse(patchReq!.body)
        assert.equal(body.type, undefined, 'Gitea PATCH body must NOT contain type field')
        assert.equal(body.config.url, URL_)
        assert.equal(body.active, true)
      })
    })
  })

  test('14. Gitea missing token → exit 1, no state write, no HTTP request', { skip: WIN }, async () => {
    await inProject(async ({ root }) => {
      await withGiteaServer((_req, res) => { res.writeHead(500); res.end() }, async (serverUrl, reqs) => {
        const argv = ['--repo', 'owner/repo', '--forge', 'gitea', '--gitea-url', serverUrl]
        let res = await runSetup(argv)
        assert.equal(res.exitCode, 1)
        assert.match(res.stderr, /GITEA_TOKEN not set/)
        assert.equal(reqs.length, 0, 'no HTTP request should have been made')
        assert.ok(!existsSync(join(root, '.claude', 'channels', 'ci', 'state.json')), 'state.json should NOT be written when token missing')
        // Empty-string case: explicit GITEA_TOKEN='' must fail identically
        process.env.GITEA_TOKEN = ''
        res = await runSetup(argv)
        assert.equal(res.exitCode, 1)
        assert.match(res.stderr, /GITEA_TOKEN not set/)
        assert.equal(reqs.length, 0)
      })
    })
  })

  test('15. Gitea 401 response → state-first ordering preserved', { skip: WIN }, async () => {
    await inProject(async ({ root }) => {
      const statePath = seedState(root, { smeeUrl: URL_ })
      writeEnv(root, 'GITEA_TOKEN=fake-token\n')
      await withGiteaServer((_req, res) => { res.writeHead(401); res.end('unauthorized') }, async (serverUrl) => {
        const res = await runSetup(['--repo', 'owner/repo', '--forge', 'gitea', '--gitea-url', serverUrl])
        assert.equal(res.exitCode, 1)
        assert.match(res.stderr, /GITEA_TOKEN is invalid or expired/)
        const state = JSON.parse(readFileSync(statePath, 'utf-8'))
        assert.equal(state.smeeUrl, URL_)
        assert.ok(typeof state.webhookSecret === 'string' && state.webhookSecret.length > 0, 'state-first: fresh secret must be on disk before Gitea API call')
      })
    })
  })

  test('16. Codev config gets the flag appended to shell.architect', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const codevPath = seedCodev(root, {
        shell: { architect: 'claude --dangerously-skip-permissions', builder: 'claude --dangerously-skip-permissions', shell: 'bash' },
      })
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      const updated = JSON.parse(readFileSync(codevPath, 'utf-8'))
      assert.equal(updated.shell.architect, `claude --dangerously-skip-permissions ${CODEV_FLAG}`)
      assert.equal(updated.shell.builder, 'claude --dangerously-skip-permissions', 'builder must be untouched')
      assert.equal(updated.shell.shell, 'bash', 'other shell fields untouched')
      assert.match(res.stderr, /Updated \.codev\/config\.json/)
    })
  })

  test('17. Codev config already has the flag → no change, log skip', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const codevPath = seedCodev(root, {
        shell: { architect: `claude --dangerously-skip-permissions ${CODEV_FLAG}`, builder: 'claude' },
      })
      const before = readFileSync(codevPath, 'utf-8')
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.equal(readFileSync(codevPath, 'utf-8'), before)
      assert.match(res.stderr, /already loads ci channel/)
    })
  })

  test('18. No .codev/ directory → silent skip, setup succeeds', { skip: WIN }, async () => {
    await inProject(async ({ root, bin }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      mkFakeCli(bin, 'gh', [{ stdout: '[[]]' }, { stdout: '{}' }])
      const res = await runSetup(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(!existsSync(join(root, '.codev')), '.codev/ should not exist')
      assert.doesNotMatch(res.stderr, /\.codev/, 'no Codev log lines when file absent')
    })
  })

  // ========== ci-channel remove (Spec 8, simplified in v0.5.1) ==========
  // remove is local-only: deletes state.json, strips .mcp.json ci entry,
  // reverts Codev flag. It does NOT call any forge API — the webhook on the
  // forge is left as an orphan for the user to clean up manually.

  test('R1. remove happy path: deletes state.json, strips .mcp.json ci, prints orphan notice', async () => {
    await inProject(async ({ root }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(!existsSync(statePath), 'state.json should be deleted')
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      assert.ok(!('ci' in (mcp.mcpServers ?? {})), 'ci entry should be removed')
      // Orphan notice printed with the smee URL
      assert.match(res.stderr, /webhook on your forge was NOT deleted/)
      assert.match(res.stderr, new RegExp(URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })
  })

  test('R2. remove with no state.json: still runs other cleanup (no orphan notice)', async () => {
    await inProject(async ({ root }) => {
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.match(res.stderr, /no state\.json at .* — skipping/)
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      assert.ok(!('ci' in (mcp.mcpServers ?? {})), 'ci entry still removed')
      assert.doesNotMatch(res.stderr, /webhook on your forge/)
    })
  })

  test('R3. remove with unrecognized .mcp.json ci entry: leave entry alone, still delete state', async () => {
    await inProject(async ({ root }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const unrecognized = { mcpServers: { ci: { command: 'node', args: ['/custom/path/to/ci-channel/dist/server.js'] } } }
      writeFileSync(join(root, '.mcp.json'), JSON.stringify(unrecognized, null, 2) + '\n')
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(!existsSync(statePath), 'state.json should be deleted')
      const mcpAfter = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      assert.deepEqual(mcpAfter, unrecognized)
      assert.match(res.stderr, /'ci' entry not recognized — leaving alone/)
    })
  })

  test('R4. remove with no .mcp.json: state deleted, no error', async () => {
    await inProject(async ({ root }) => {
      const statePath = seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(!existsSync(statePath), 'state.json deleted')
      assert.match(res.stderr, /no \.mcp\.json found — skipping/)
    })
  })

  test('R5. remove with Codev integration: architect flag stripped with leading space', async () => {
    await inProject(async ({ root }) => {
      seedState(root, { webhookSecret: SECRET, smeeUrl: URL_ })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const codevPath = seedCodev(root, { shell: { architect: `claude --dangerously-skip-permissions ${CODEV_FLAG}`, builder: 'claude' } })
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      const updated = JSON.parse(readFileSync(codevPath, 'utf-8'))
      assert.equal(updated.shell.architect, 'claude --dangerously-skip-permissions', 'loader flag + leading space stripped')
      assert.equal(updated.shell.builder, 'claude', 'builder untouched')
      assert.match(res.stderr, /Reverted \.codev\/config\.json/)
    })
  })

  test('R6. remove with malformed state.json: still deletes state, no orphan notice', async () => {
    await inProject(async ({ root }) => {
      const stateDir = join(root, '.claude', 'channels', 'ci')
      mkdirSync(stateDir, { recursive: true })
      const statePath = join(stateDir, 'state.json')
      writeFileSync(statePath, '{not valid json', { mode: 0o600 })
      writeFileSync(join(root, '.mcp.json'), MCP_CI_ONLY)
      const res = await runRemove([])
      assert.equal(res.exitCode, null, `unexpected exit: ${res.stderr}`)
      assert.ok(!existsSync(statePath), 'malformed state.json still deleted')
      const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'))
      assert.ok(!('ci' in (mcp.mcpServers ?? {})))
      assert.doesNotMatch(res.stderr, /webhook on your forge/)
    })
  })

  test('R7. remove with flags → error (no flags accepted)', async () => {
    await inProject(async () => {
      const res = await runRemove(['--repo', 'foo/bar'])
      assert.equal(res.exitCode, 1)
      assert.match(res.stderr, /Usage: ci-channel remove \(no flags\)/)
    })
  })

  test('R8. remove with no project root: fails fast', async () => {
    // This test can't use inProject (which creates .git/). Use a bare temp dir.
    const os = await import('node:os')
    const fs = await import('node:fs')
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'ci-channel-no-root-'))
    const origCwd = process.cwd()
    try {
      process.chdir(tmp)
      const res = await runRemove([])
      assert.equal(res.exitCode, 1)
      assert.match(res.stderr, /No project root found/)
    } finally {
      process.chdir(origCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
