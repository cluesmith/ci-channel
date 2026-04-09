import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { githubForge } from '../lib/forges/github.js'
import { isDuplicate, clearDedup, isRepoAllowed, isWorkflowAllowed } from '../lib/webhook.js'

const SECRET = 'test-secret-key'

function sign(payload: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')
}

function makeHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(extra)) h.set(k, v)
  return h
}

function makeFailurePayload(overrides: { workflow_run?: Record<string, any>; repository?: Record<string, any> } = {}): string {
  return JSON.stringify({
    action: 'completed',
    workflow_run: {
      id: 12345,
      name: 'CI Validation',
      head_branch: 'ci',
      head_sha: 'abc123def456',
      html_url: 'https://github.com/owner/repo/actions/runs/12345',
      conclusion: 'failure',
      head_commit: {
        message: 'fix: widget alignment',
        author: { name: 'waleedkadous' },
      },
      ...(overrides.workflow_run ?? {}),
    },
    repository: {
      full_name: 'owner/repo',
      ...(overrides.repository ?? {}),
    },
  })
}

describe('githubForge.validateSignature', () => {
  test('accepts valid signature', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(githubForge.validateSignature(payload, makeHeaders({ 'x-hub-signature-256': sig }), SECRET), true)
  })

  test('rejects invalid signature', () => {
    const payload = '{"test": true}'
    assert.strictEqual(githubForge.validateSignature(payload, makeHeaders({ 'x-hub-signature-256': 'sha256=deadbeef00000000000000000000000000000000000000000000000000000000' }), SECRET), false)
  })

  test('rejects null signature', () => {
    assert.strictEqual(githubForge.validateSignature('payload', makeHeaders(), SECRET), false)
  })

  test('rejects signature without sha256= prefix', () => {
    assert.strictEqual(githubForge.validateSignature('payload', makeHeaders({ 'x-hub-signature-256': 'invalid-format' }), SECRET), false)
  })

  test('rejects tampered payload', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(githubForge.validateSignature('{"test": false}', makeHeaders({ 'x-hub-signature-256': sig }), SECRET), false)
  })

  test('rejects signature with wrong length', () => {
    assert.strictEqual(githubForge.validateSignature('payload', makeHeaders({ 'x-hub-signature-256': 'sha256=short' }), SECRET), false)
  })
})

describe('githubForge.parseWebhookEvent', () => {
  test('parses failure event correctly', () => {
    const body = makeFailurePayload()
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-1' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')

    assert.strictEqual(result.event.deliveryId, 'delivery-1')
    assert.strictEqual(result.event.workflowName, 'CI Validation')
    assert.strictEqual(result.event.branch, 'ci')
    assert.strictEqual(result.event.commitSha, 'abc123def456')
    assert.strictEqual(result.event.commitMessage, 'fix: widget alignment')
    assert.strictEqual(result.event.commitAuthor, 'waleedkadous')
    assert.strictEqual(result.event.runUrl, 'https://github.com/owner/repo/actions/runs/12345')
    assert.strictEqual(result.event.runId, 12345)
    assert.strictEqual(result.event.repoFullName, 'owner/repo')
  })

  test('returns event for success conclusion (all completions processed)', () => {
    const body = makeFailurePayload({ workflow_run: { conclusion: 'success' } })
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-2' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.conclusion, 'success')
    }
  })

  test('returns event for non-completed action', () => {
    const body = JSON.stringify({ action: 'requested', workflow_run: { conclusion: 'failure' }, repository: { full_name: 'o/r' } })
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-3' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
  })

  test('returns irrelevant for non-workflow_run event with valid JSON', () => {
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'push', 'x-github-delivery': 'delivery-4' }),
      '{"ref": "refs/heads/main"}',
    )
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns irrelevant for missing event type with valid JSON', () => {
    const result = githubForge.parseWebhookEvent(makeHeaders({ 'x-github-delivery': 'delivery-5' }), '{}')
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns malformed for invalid JSON on workflow_run event', () => {
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-6' }),
      'not json{{{',
    )
    assert.strictEqual(result.type, 'malformed')
    if (result.type === 'malformed') {
      assert.ok(result.reason.includes('Invalid JSON'))
    }
  })

  test('returns malformed for invalid JSON on non-workflow_run event', () => {
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'push', 'x-github-delivery': 'delivery-6b' }),
      'not valid json',
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for non-object payload', () => {
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-7' }),
      '"just a string"',
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('passes through missing workflow_run with fallbacks', () => {
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-8' }),
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
      workflow_run: { conclusion: 'failure', id: 1, name: 'test' },
      repository: {},
    })
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-9' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') assert.strictEqual(result.event.repoFullName, 'unknown')
  })

  test('handles missing head_commit gracefully', () => {
    const body = makeFailurePayload({ workflow_run: { head_commit: undefined } })
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-10' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')
    assert.strictEqual(result.event.commitMessage, null)
    assert.strictEqual(result.event.commitAuthor, null)
  })

  test('handles missing head_commit.author gracefully', () => {
    const body = makeFailurePayload({ workflow_run: { head_commit: { message: 'test' } } })
    const result = githubForge.parseWebhookEvent(
      makeHeaders({ 'x-github-event': 'workflow_run', 'x-github-delivery': 'delivery-11' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')
    assert.strictEqual(result.event.commitMessage, 'test')
    assert.strictEqual(result.event.commitAuthor, null)
  })
})

describe('isDuplicate', () => {
  beforeEach(() => {
    clearDedup()
  })

  test('returns false for first delivery', () => {
    assert.strictEqual(isDuplicate('d1'), false)
  })

  test('returns true for duplicate delivery', () => {
    isDuplicate('d1')
    assert.strictEqual(isDuplicate('d1'), true)
  })

  test('different IDs are not duplicates', () => {
    isDuplicate('d1')
    assert.strictEqual(isDuplicate('d2'), false)
  })

  test('evicts oldest when at capacity', () => {
    for (let i = 0; i < 100; i++) {
      isDuplicate(`id-${i}`)
    }
    assert.strictEqual(isDuplicate('id-1'), true)
    isDuplicate('id-100')
    assert.strictEqual(isDuplicate('id-0'), false)
  })
})

describe('isRepoAllowed', () => {
  test('allows all when allowlist is null', () => {
    assert.strictEqual(isRepoAllowed('any/repo', null), true)
  })

  test('allows repo in allowlist', () => {
    assert.strictEqual(isRepoAllowed('owner/repo', ['owner/repo', 'other/repo']), true)
  })

  test('rejects repo not in allowlist', () => {
    assert.strictEqual(isRepoAllowed('attacker/repo', ['owner/repo']), false)
  })

  test('rejects with empty allowlist', () => {
    assert.strictEqual(isRepoAllowed('owner/repo', []), false)
  })
})

describe('isWorkflowAllowed', () => {
  test('allows all when filter is null', () => {
    assert.strictEqual(isWorkflowAllowed('any workflow', null), true)
  })

  test('allows workflow in filter', () => {
    assert.strictEqual(isWorkflowAllowed('CI Validation', ['CI Validation', 'Deploy Staging']), true)
  })

  test('rejects workflow not in filter', () => {
    assert.strictEqual(isWorkflowAllowed('Other Workflow', ['CI Validation']), false)
  })

  test('rejects with empty filter', () => {
    assert.strictEqual(isWorkflowAllowed('CI Validation', []), false)
  })
})
