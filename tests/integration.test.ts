import { describe, test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWebhookHandler } from '../lib/handler.js'
import { clearDedup } from '../lib/webhook.js'
import { githubForge } from '../lib/forges/github.js'
import type { Config } from '../lib/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET = 'integration-test-secret'
const fixtureDir = join(__dirname, 'fixtures')

function sign(payload: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')
}

// Mock MCP server that records notifications
function createMockMcp() {
  const notifications: Array<{ method: string; params: any }> = []
  return {
    notifications,
    notification(msg: { method: string; params: any }) {
      notifications.push(msg)
      return Promise.resolve()
    },
  }
}

const testConfig: Config = {
  forge: 'github',
  webhookSecret: SECRET,
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['ci', 'develop'],
  giteaUrl: null,
  giteaToken: null,
  // Use 'all' sentinel so existing tests (including "success event → notification")
  // keep pre-filter coverage. The default-filter behavior is covered by new tests
  // in Phase 2.
  conclusions: ['all'],
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

// Start a real HTTP server with the handler for integration testing
const mockMcp = createMockMcp()
const handleWebhook = createWebhookHandler(testConfig, mockMcp as any, githubForge)

const testServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    if (req.method === 'POST' && (url.pathname === '/webhook/github' || url.pathname === '/webhook')) {
      const body = await readBody(req)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
      }
      const webReq = new Request(url.href, { method: 'POST', headers, body })
      const webRes = await handleWebhook(webReq)
      res.writeHead(webRes.status)
      res.end(await webRes.text())
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  } catch {
    res.writeHead(500)
    res.end('Internal Server Error')
  }
})

await new Promise<void>(resolve => testServer.listen(0, '127.0.0.1', resolve))
const addr = testServer.address() as { port: number }
const BASE_URL = `http://127.0.0.1:${addr.port}`

async function postWebhook(payload: string, headers: Record<string, string> = {}, path = '/webhook/github'): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    body: payload,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}

describe('integration: HTTP webhook pipeline', () => {
  after(() => {
    testServer.close()
  })

  beforeEach(() => {
    clearDedup()
    mockMcp.notifications.length = 0
  })

  test('valid signed failure event → 200 + notification pushed', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')
    const signature = sign(payload)

    const res = await postWebhook(payload, {
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-1',
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(await res.text(), 'ok')

    assert.ok(mockMcp.notifications.length >= 1)
    const notif = mockMcp.notifications[0]
    assert.strictEqual(notif.method, 'notifications/claude/channel')
    assert.ok(notif.params.content.includes('failure: CI Validation · ci'))
    assert.ok(notif.params.content.includes('waleedkadous'))
    assert.strictEqual(notif.params.meta.workflow, 'CI Validation')
    assert.strictEqual(notif.params.meta.branch, 'ci')
    assert.strictEqual(notif.params.meta.run_url, 'https://github.com/example/my-app/actions/runs/12345678')
  })

  test('invalid signature → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')

    const res = await postWebhook(payload, {
      'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-2',
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('missing signature → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')

    const res = await postWebhook(payload, {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-3',
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('malformed JSON → 400', async () => {
    const payload = 'not valid json{{'
    const signature = sign(payload)

    const res = await postWebhook(payload, {
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-4',
    })

    assert.strictEqual(res.status, 400)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('success event → 200 + notification with conclusion field', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')
    const modified = payload.replace('"failure"', '"success"')
    const signature = sign(modified)

    const res = await postWebhook(modified, {
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-5',
    })

    assert.strictEqual(res.status, 200)
    assert.ok(mockMcp.notifications.length >= 1)
    const notif = mockMcp.notifications[0]
    assert.strictEqual(notif.params.meta.conclusion, 'success')
  })

  test('non-workflow_run event → 200, no notification', async () => {
    const payload = '{"ref": "refs/heads/main"}'
    const signature = sign(payload)

    const res = await postWebhook(payload, {
      'x-hub-signature-256': signature,
      'x-github-event': 'push',
      'x-github-delivery': 'int-test-6',
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('duplicate delivery → 200, single notification', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')
    const signature = sign(payload)

    const headers = {
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'dup-delivery-1',
    }

    const res1 = await postWebhook(payload, headers)
    assert.strictEqual(res1.status, 200)
    const countAfterFirst = mockMcp.notifications.length

    const res2 = await postWebhook(payload, headers)
    assert.strictEqual(res2.status, 200)
    assert.strictEqual(mockMcp.notifications.length, countAfterFirst)
  })

  test('repo not in allowlist → 200, no notification', async () => {
    const restrictedMcp = createMockMcp()
    const restrictedConfig: Config = { ...testConfig, repos: ['other/repo'] }
    const restrictedHandler = createWebhookHandler(restrictedConfig, restrictedMcp as any, githubForge)

    const restrictedServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'POST' && url.pathname === '/webhook/github') {
          const body = await readBody(req)
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value)
            else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
          }
          const webReq = new Request(url.href, { method: 'POST', headers, body })
          const webRes = await restrictedHandler(webReq)
          res.writeHead(webRes.status)
          res.end(await webRes.text())
          return
        }
        res.writeHead(404)
        res.end('Not Found')
      } catch {
        res.writeHead(500)
        res.end('Internal Server Error')
      }
    })

    await new Promise<void>(resolve => restrictedServer.listen(0, '127.0.0.1', resolve))
    const restrictedAddr = restrictedServer.address() as { port: number }

    try {
      const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')
      const signature = sign(payload)

      const res = await fetch(`http://127.0.0.1:${restrictedAddr.port}/webhook/github`, {
        method: 'POST',
        body: payload,
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'workflow_run',
          'x-github-delivery': 'int-test-allowlist',
        },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(restrictedMcp.notifications.length, 0)
    } finally {
      restrictedServer.close()
    }
  })

  test('404 for non-webhook routes', async () => {
    const res = await fetch(`${BASE_URL}/other/route`)
    assert.strictEqual(res.status, 404)
  })

  test('/webhook route works as alias', async () => {
    const payload = readFileSync(join(fixtureDir, 'workflow-run-failure.json'), 'utf-8')
    const signature = sign(payload)

    const res = await postWebhook(payload, {
      'x-hub-signature-256': signature,
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'int-test-alias',
    }, '/webhook')

    assert.strictEqual(res.status, 200)
    assert.ok(mockMcp.notifications.length >= 1)
  })
})
