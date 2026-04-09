import { describe, test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWebhookHandler } from '../lib/handler.js'
import { clearDedup } from '../lib/webhook.js'
import { giteaForge } from '../lib/forges/gitea.js'
import type { Config } from '../lib/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET = 'gitea-integration-secret'
const fixtureDir = join(__dirname, 'fixtures')

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex')
}

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
  forge: 'gitea',
  webhookSecret: SECRET,
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['develop'],
  giteaUrl: 'https://gitea.example.com',
  giteaToken: null,
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const mockMcp = createMockMcp()
const handleWebhook = createWebhookHandler(testConfig, mockMcp as any, giteaForge)

const testServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/webhook/github')) {
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

describe('integration: Gitea webhook pipeline', () => {
  after(() => { testServer.close() })

  beforeEach(() => {
    clearDedup()
    mockMcp.notifications.length = 0
  })

  test('valid Gitea workflow_run failure → 200 + notification', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitea-workflow-run-failure.json'), 'utf-8')
    const signature = sign(payload)

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-signature': signature,
        'x-gitea-event': 'workflow_run',
        'x-gitea-delivery': 'gitea-int-1',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.ok(mockMcp.notifications.length >= 1)

    const notif = mockMcp.notifications[0]
    assert.strictEqual(notif.method, 'notifications/claude/channel')
    assert.ok(notif.params.content.includes('CI failure: CI on branch develop'))
    assert.ok(notif.params.content.includes('waleedkadous'))
    assert.strictEqual(notif.params.meta.branch, 'develop')
    assert.strictEqual(notif.params.meta.conclusion, 'failure')
  })

  test('invalid Gitea signature → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitea-workflow-run-failure.json'), 'utf-8')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-signature': '0000000000000000000000000000000000000000000000000000000000000000',
        'x-gitea-event': 'workflow_run',
        'x-gitea-delivery': 'gitea-int-2',
      },
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('missing Gitea signature → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitea-workflow-run-failure.json'), 'utf-8')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-event': 'workflow_run',
        'x-gitea-delivery': 'gitea-int-3',
      },
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('non-workflow_run event → 200, no notification', async () => {
    const payload = '{"ref": "refs/heads/main"}'
    const signature = sign(payload)

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-signature': signature,
        'x-gitea-event': 'push',
        'x-gitea-delivery': 'gitea-int-4',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('non-completed action → 200, no notification', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitea-workflow-run-failure.json'), 'utf-8')
    const modified = payload.replace('"completed"', '"requested"')
    const signature = sign(modified)

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: modified,
      headers: {
        'Content-Type': 'application/json',
        'x-gitea-signature': signature,
        'x-gitea-event': 'workflow_run',
        'x-gitea-delivery': 'gitea-int-5',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })
})
