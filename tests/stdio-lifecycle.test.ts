/**
 * Regression test for GitHub issue #457: stdio connection drops.
 *
 * Verifies that the MCP server running under Node.js (tsx) maintains a
 * stable stdio connection and delivers channel notifications end-to-end.
 *
 * This test spawns the actual server as a child process, communicates
 * via JSON-RPC over stdin/stdout, sends a webhook via HTTP, and verifies
 * the notification arrives on stdout without the connection dropping.
 */
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(__dirname, '..')
const FIXTURE_DIR = join(__dirname, 'fixtures')
const SECRET = 'stdio-test-secret'

function sendJsonRpc(proc: ChildProcess, msg: object): void {
  proc.stdin!.write(JSON.stringify(msg) + '\n')
}

function collectStdout(proc: ChildProcess): string[] {
  const lines: string[] = []
  proc.stdout!.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) lines.push(line.trim())
    }
  })
  return lines
}

/** Wait for stderr to emit a line matching a pattern, with timeout. */
function waitForStderr(proc: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for stderr pattern: ${pattern}`)), timeoutMs)
    proc.stderr!.on('data', function handler(chunk: Buffer) {
      const text = chunk.toString()
      const match = text.match(pattern)
      if (match) {
        clearTimeout(timer)
        proc.stderr!.off('data', handler)
        resolve(match[0])
      }
    })
  })
}

function sign(payload: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')
}

describe('stdio lifecycle (regression for #457)', () => {
  let serverProc: ChildProcess | null = null

  afterEach(() => {
    if (serverProc) {
      try { serverProc.kill() } catch {}
      serverProc = null
    }
  })

  test('server stays connected and delivers notifications via stdio', { timeout: 30000 }, async () => {
    // Start the server under Node.js (tsx)
    serverProc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        WEBHOOK_SECRET: SECRET,
        PORT: '0', // let OS pick an available port
        RECONCILE_BRANCHES: '__none__', // non-existent branch to skip reconciliation
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Wait for HTTP server to start and capture the port
    const portLine = await waitForStderr(serverProc, /Listening on port (\d+)/, 15000)
    const portMatch = portLine.match(/port (\d+)/)
    if (!portMatch) throw new Error('Could not parse port from server output')
    const port = Number(portMatch[1])

    // Collect stdout (JSON-RPC messages from MCP server)
    const stdoutLines = collectStdout(serverProc)

    // Step 1: Send MCP initialize request
    sendJsonRpc(serverProc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.1.0' },
      },
    })

    // Wait for initialize response
    await new Promise(resolve => setTimeout(resolve, 1000))
    const initResponse = stdoutLines.find(line => {
      try { const msg = JSON.parse(line); return msg.id === 1 && msg.result } catch { return false }
    })
    assert.ok(initResponse !== undefined, 'Expected initialize response')

    // Step 2: Send initialized notification
    sendJsonRpc(serverProc, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    await new Promise(resolve => setTimeout(resolve, 500))

    // Step 3: Send a webhook via HTTP
    const payload = readFileSync(join(FIXTURE_DIR, 'workflow-run-failure.json'), 'utf-8')
    const res = await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': sign(payload),
        'x-github-event': 'workflow_run',
        'x-github-delivery': 'stdio-regression-1',
      },
    })
    assert.strictEqual(res.status, 200)

    // Step 4: Wait for notification to arrive on stdout
    await new Promise(resolve => setTimeout(resolve, 2000))

    const notification = stdoutLines.find(line => {
      try {
        const msg = JSON.parse(line)
        return msg.method === 'notifications/claude/channel'
      } catch { return false }
    })

    assert.ok(notification !== undefined, 'Expected channel notification on stdout')
    const notifMsg = JSON.parse(notification!)
    assert.ok(notifMsg.params.content.includes('CI failure'))
    assert.strictEqual(notifMsg.params.meta.workflow, 'CI Validation')

    // Step 5: Verify the connection is still alive by sending a ping
    sendJsonRpc(serverProc, { jsonrpc: '2.0', id: 2, method: 'ping' })
    await new Promise(resolve => setTimeout(resolve, 1000))

    const pingResponse = stdoutLines.find(line => {
      try { const msg = JSON.parse(line); return msg.id === 2 } catch { return false }
    })
    assert.ok(pingResponse !== undefined, 'Expected ping response')

    // Step 6: Verify process is still running (not crashed/restarted)
    assert.strictEqual(serverProc.exitCode, null)
  })
})
