import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { giteaForge } from '../../lib/forges/gitea.js'
import { clearDedup } from '../../lib/webhook.js'
import type { Config } from '../../lib/config.js'

const SECRET = 'gitea-test-secret'

function sign(payload: string): string {
  // Gitea uses raw hex, no "sha256=" prefix
  return createHmac('sha256', SECRET).update(payload).digest('hex')
}

function makeHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(extra)) h.set(k, v)
  return h
}

function makeWorkflowRunPayload(overrides: {
  action?: string
  workflow_run?: Record<string, any>
  repository?: Record<string, any>
} = {}): string {
  return JSON.stringify({
    action: overrides.action ?? 'completed',
    workflow_run: {
      id: 54321,
      name: 'CI',
      head_branch: 'develop',
      head_sha: 'cafebabe12345678',
      html_url: 'https://gitea.example.com/owner/my-app/actions/runs/54321',
      conclusion: 'failure',
      head_commit: {
        message: 'feat: add search endpoint',
        author: { name: 'waleedkadous' },
      },
      ...(overrides.workflow_run ?? {}),
    },
    repository: {
      full_name: 'owner/my-app',
      ...(overrides.repository ?? {}),
    },
  })
}

const dummyConfig: Config = {
  forge: 'gitea',
  webhookSecret: SECRET,
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['develop'],
  giteaUrl: null,
  giteaToken: null,
  conclusions: null,
}

describe('giteaForge.validateSignature', () => {
  test('accepts valid HMAC signature (raw hex)', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(
      giteaForge.validateSignature(payload, makeHeaders({ 'x-gitea-signature': sig }), SECRET),
      true,
    )
  })

  test('rejects invalid signature', () => {
    const payload = '{"test": true}'
    assert.strictEqual(
      giteaForge.validateSignature(payload, makeHeaders({ 'x-gitea-signature': 'deadbeef00000000000000000000000000000000000000000000000000000000' }), SECRET),
      false,
    )
  })

  test('rejects missing signature header', () => {
    assert.strictEqual(
      giteaForge.validateSignature('payload', makeHeaders(), SECRET),
      false,
    )
  })

  test('rejects signature with wrong length', () => {
    assert.strictEqual(
      giteaForge.validateSignature('payload', makeHeaders({ 'x-gitea-signature': 'short' }), SECRET),
      false,
    )
  })

  test('rejects tampered payload', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(
      giteaForge.validateSignature('{"test": false}', makeHeaders({ 'x-gitea-signature': sig }), SECRET),
      false,
    )
  })
})

describe('giteaForge.parseWebhookEvent', () => {
  beforeEach(() => {
    clearDedup()
  })

  test('parses workflow_run failure correctly', () => {
    const body = makeWorkflowRunPayload()
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': 'gitea-del-1' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')

    assert.strictEqual(result.event.deliveryId, 'gitea-del-1')
    assert.strictEqual(result.event.workflowName, 'CI')
    assert.strictEqual(result.event.conclusion, 'failure')
    assert.strictEqual(result.event.branch, 'develop')
    assert.strictEqual(result.event.commitSha, 'cafebabe12345678')
    assert.strictEqual(result.event.commitMessage, 'feat: add search endpoint')
    assert.strictEqual(result.event.commitAuthor, 'waleedkadous')
    assert.strictEqual(result.event.runId, 54321)
    assert.strictEqual(result.event.repoFullName, 'owner/my-app')
  })

  test('returns event for success conclusion', () => {
    const body = makeWorkflowRunPayload({ workflow_run: { conclusion: 'success' } })
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': 'gitea-del-2' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.conclusion, 'success')
    }
  })

  test('returns event for non-completed action', () => {
    const body = makeWorkflowRunPayload({ action: 'requested' })
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': 'gitea-del-3' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
  })

  test('returns irrelevant for non-workflow_run event', () => {
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'push', 'x-gitea-delivery': 'gitea-del-4' }),
      '{"ref": "refs/heads/main"}',
    )
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns irrelevant for missing event header', () => {
    const result = giteaForge.parseWebhookEvent(makeHeaders(), makeWorkflowRunPayload())
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns malformed for invalid JSON', () => {
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run' }),
      'not json{{',
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('passes through missing workflow_run with fallbacks', () => {
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run' }),
      '{"action": "completed"}',
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.conclusion, 'completed')
      assert.strictEqual(result.event.repoFullName, 'unknown')
    }
  })

  test('passes through missing repository.full_name with fallback', () => {
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { id: 1, conclusion: 'failure' },
      repository: {},
    })
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') assert.strictEqual(result.event.repoFullName, 'unknown')
  })

  test('handles missing head_commit gracefully', () => {
    const body = makeWorkflowRunPayload({ workflow_run: { head_commit: undefined } })
    const result = giteaForge.parseWebhookEvent(
      makeHeaders({ 'x-gitea-event': 'workflow_run', 'x-gitea-delivery': 'gitea-del-5' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.commitMessage, null)
      assert.strictEqual(result.event.commitAuthor, null)
    }
  })
})

describe('giteaForge.runReconciliation', () => {
  test('returns null when --gitea-url not configured', async () => {
    const result = await giteaForge.runReconciliation(dummyConfig, 'develop', 3000)
    assert.strictEqual(result, null)
  })

  test('returns null when no repos configured', async () => {
    const config = { ...dummyConfig, giteaUrl: 'https://gitea.example.com' }
    const result = await giteaForge.runReconciliation(config, 'develop', 3000)
    assert.strictEqual(result, null)
  })

  test('returns failed run from API', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/v1/repos/owner/my-app/actions/runs')) {
        // Verify auth header
        const authHeader = init?.headers?.Authorization
        assert.strictEqual(authHeader, 'token my-gitea-token')
        return new Response(JSON.stringify([{
          id: 99,
          name: 'CI',
          conclusion: 'failure',
          head_branch: 'develop',
          head_sha: 'abc123',
          html_url: 'https://gitea.example.com/owner/my-app/actions/runs/99',
        }]), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }

    try {
      const config = { ...dummyConfig, giteaUrl: 'https://gitea.example.com', giteaToken: 'my-gitea-token', repos: ['owner/my-app'] }
      const result = await giteaForge.runReconciliation(config, 'develop', 3000)

      assert.ok(result)
      assert.strictEqual(result!.workflowName, 'CI')
      assert.strictEqual(result!.conclusion, 'failure')
      assert.strictEqual(result!.runId, 99)
      assert.strictEqual(result!.repoFullName, 'owner/my-app')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('checks multiple repos and returns first failure', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('repo1')) {
        return new Response(JSON.stringify([{ id: 1, conclusion: 'success' }]), { status: 200 })
      }
      if (url.includes('repo2')) {
        return new Response(JSON.stringify([{
          id: 2, name: 'CI', conclusion: 'failure', head_branch: 'main', head_sha: 'def456',
          html_url: 'https://gitea.example.com/owner/repo2/actions/runs/2',
        }]), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }

    try {
      const config = { ...dummyConfig, giteaUrl: 'https://gitea.example.com', repos: ['owner/repo1', 'owner/repo2'] }
      const result = await giteaForge.runReconciliation(config, 'main', 3000)

      assert.ok(result)
      assert.strictEqual(result!.repoFullName, 'owner/repo2')
      assert.strictEqual(result!.runId, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('giteaForge.fetchFailedJobs', () => {
  test('returns null when --gitea-url not configured', async () => {
    const result = await giteaForge.fetchFailedJobs(dummyConfig, 'owner/repo', 1)
    assert.strictEqual(result, null)
  })

  test('returns failed job names from API', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/actions/runs/99/jobs')) {
        assert.strictEqual(init?.headers?.Authorization, 'token my-token')
        return new Response(JSON.stringify([
          { name: 'build', conclusion: 'success' },
          { name: 'test', conclusion: 'failure' },
          { name: 'lint', conclusion: 'failure' },
        ]), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }

    try {
      const config = { ...dummyConfig, giteaUrl: 'https://gitea.example.com', giteaToken: 'my-token' }
      const result = await giteaForge.fetchFailedJobs(config, 'owner/repo', 99)

      assert.deepStrictEqual(result, ['test', 'lint'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('returns null on API error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('Server Error', { status: 500 })

    try {
      const config = { ...dummyConfig, giteaUrl: 'https://gitea.example.com' }
      const result = await giteaForge.fetchFailedJobs(config, 'owner/repo', 99)
      assert.strictEqual(result, null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
