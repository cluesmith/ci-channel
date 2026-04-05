import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { validateSignature, parseWebhookEvent, isDuplicate, clearDedup, isRepoAllowed, isWorkflowAllowed } from '../lib/webhook.js'

const SECRET = 'test-secret-key'

function sign(payload: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(payload).digest('hex')
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

describe('validateSignature', () => {
  test('accepts valid signature', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(validateSignature(payload, sig, SECRET), true)
  })

  test('rejects invalid signature', () => {
    const payload = '{"test": true}'
    assert.strictEqual(validateSignature(payload, 'sha256=deadbeef00000000000000000000000000000000000000000000000000000000', SECRET), false)
  })

  test('rejects null signature', () => {
    assert.strictEqual(validateSignature('payload', null, SECRET), false)
  })

  test('rejects signature without sha256= prefix', () => {
    assert.strictEqual(validateSignature('payload', 'invalid-format', SECRET), false)
  })

  test('rejects tampered payload', () => {
    const payload = '{"test": true}'
    const sig = sign(payload)
    assert.strictEqual(validateSignature('{"test": false}', sig, SECRET), false)
  })

  test('rejects signature with wrong length', () => {
    assert.strictEqual(validateSignature('payload', 'sha256=short', SECRET), false)
  })
})

describe('parseWebhookEvent', () => {
  test('parses failure event correctly', () => {
    const body = makeFailurePayload()
    const result = parseWebhookEvent('workflow_run', 'delivery-1', body)

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
    const result = parseWebhookEvent('workflow_run', 'delivery-2', body)
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.conclusion, 'success')
    }
  })

  test('returns irrelevant for non-completed action', () => {
    const body = JSON.stringify({ action: 'requested', workflow_run: { conclusion: 'failure' }, repository: { full_name: 'o/r' } })
    const result = parseWebhookEvent('workflow_run', 'delivery-3', body)
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns irrelevant for non-workflow_run event with valid JSON', () => {
    const result = parseWebhookEvent('push', 'delivery-4', '{"ref": "refs/heads/main"}')
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns irrelevant for null event type with valid JSON', () => {
    const result = parseWebhookEvent(null, 'delivery-5', '{}')
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns malformed for invalid JSON on workflow_run event', () => {
    const result = parseWebhookEvent('workflow_run', 'delivery-6', 'not json{{{')
    assert.strictEqual(result.type, 'malformed')
    if (result.type === 'malformed') {
      assert.ok(result.reason.includes('Invalid JSON'))
    }
  })

  test('returns malformed for invalid JSON on non-workflow_run event', () => {
    // JSON is parsed BEFORE checking event type — malformed payloads always get 400
    const result = parseWebhookEvent('push', 'delivery-6b', 'not valid json')
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for non-object payload', () => {
    const result = parseWebhookEvent('workflow_run', 'delivery-7', '"just a string"')
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for missing workflow_run', () => {
    const result = parseWebhookEvent('workflow_run', 'delivery-8', '{"action": "completed"}')
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for missing repository.full_name', () => {
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { conclusion: 'failure', id: 1, name: 'test' },
      repository: {},
    })
    const result = parseWebhookEvent('workflow_run', 'delivery-9', body)
    assert.strictEqual(result.type, 'malformed')
  })

  test('handles missing head_commit gracefully', () => {
    const body = makeFailurePayload({ workflow_run: { head_commit: undefined } })
    const result = parseWebhookEvent('workflow_run', 'delivery-10', body)

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')
    assert.strictEqual(result.event.commitMessage, null)
    assert.strictEqual(result.event.commitAuthor, null)
  })

  test('handles missing head_commit.author gracefully', () => {
    const body = makeFailurePayload({ workflow_run: { head_commit: { message: 'test' } } })
    const result = parseWebhookEvent('workflow_run', 'delivery-11', body)

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
    // Fill to capacity
    for (let i = 0; i < 100; i++) {
      isDuplicate(`id-${i}`)
    }
    // id-1 should still be tracked before any eviction
    assert.strictEqual(isDuplicate('id-1'), true)
    // Adding a new entry should evict id-0 (the oldest)
    isDuplicate('id-100')
    // id-0 was evicted, so it's no longer a duplicate
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
