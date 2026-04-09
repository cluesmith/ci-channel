import { describe, test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWebhookHandler } from '../lib/handler.js'
import { clearDedup } from '../lib/webhook.js'
import { gitlabForge } from '../lib/forges/gitlab.js'
import type { Config } from '../lib/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET = 'gitlab-integration-secret'
const fixtureDir = join(__dirname, 'fixtures')

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
  forge: 'gitlab',
  webhookSecret: SECRET,
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['main'],
  giteaUrl: null,
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
const handleWebhook = createWebhookHandler(testConfig, mockMcp as any, gitlabForge)

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

describe('integration: GitLab webhook pipeline', () => {
  after(() => { testServer.close() })

  beforeEach(() => {
    clearDedup()
    mockMcp.notifications.length = 0
  })

  test('valid GitLab pipeline failure → 200 + notification', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitlab-pipeline-failure.json'), 'utf-8')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Pipeline Hook',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.ok(mockMcp.notifications.length >= 1)

    const notif = mockMcp.notifications[0]
    assert.strictEqual(notif.method, 'notifications/claude/channel')
    assert.ok(notif.params.content.includes('CI failed'))
    assert.ok(notif.params.content.includes('main'))
    assert.strictEqual(notif.params.meta.branch, 'main')
    assert.strictEqual(notif.params.meta.conclusion, 'failed')
    assert.strictEqual(notif.params.meta.run_url, 'https://gitlab.example.com/example/my-app/-/pipelines/98765')
  })

  test('invalid GitLab token → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitlab-pipeline-failure.json'), 'utf-8')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': 'wrong-token',
        'x-gitlab-event': 'Pipeline Hook',
      },
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('missing GitLab token → 403', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitlab-pipeline-failure.json'), 'utf-8')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-event': 'Pipeline Hook',
      },
    })

    assert.strictEqual(res.status, 403)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('Push Hook event → 200, no notification', async () => {
    const payload = '{"ref": "refs/heads/main"}'

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: payload,
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Push Hook',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(mockMcp.notifications.length, 0)
  })

  test('running pipeline state → 200, notification', async () => {
    const payload = readFileSync(join(fixtureDir, 'gitlab-pipeline-failure.json'), 'utf-8')
    const modified = payload.replace('"failed"', '"running"')

    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      body: modified,
      headers: {
        'Content-Type': 'application/json',
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Pipeline Hook',
      },
    })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(mockMcp.notifications.length, 1)
    const notif = mockMcp.notifications[0]
    assert.strictEqual(notif.params.meta.conclusion, 'running')
  })

  test('repo allowlist works with nested namespaces', async () => {
    const restrictedMcp = createMockMcp()
    const restrictedConfig: Config = { ...testConfig, repos: ['group/subgroup/project'] }
    const handler = createWebhookHandler(restrictedConfig, restrictedMcp as any, gitlabForge)

    const restrictedServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const body = await readBody(req)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v)
        }
        const webReq = new Request(url.href, { method: 'POST', headers, body })
        const webRes = await handler(webReq)
        res.writeHead(webRes.status)
        res.end(await webRes.text())
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    })

    await new Promise<void>(resolve => restrictedServer.listen(0, '127.0.0.1', resolve))
    const rAddr = restrictedServer.address() as { port: number }

    try {
      // example/my-app is NOT in the allowlist (group/subgroup/project is)
      const payload = readFileSync(join(fixtureDir, 'gitlab-pipeline-failure.json'), 'utf-8')
      const res = await fetch(`http://127.0.0.1:${rAddr.port}/webhook`, {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Type': 'application/json',
          'x-gitlab-token': SECRET,
          'x-gitlab-event': 'Pipeline Hook',
        },
      })

      assert.strictEqual(res.status, 200)
      assert.strictEqual(restrictedMcp.notifications.length, 0) // repo not in allowlist
    } finally {
      restrictedServer.close()
    }
  })
})
