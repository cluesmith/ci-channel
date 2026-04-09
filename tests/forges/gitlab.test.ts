import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { gitlabForge } from '../../lib/forges/gitlab.js'
import { clearDedup } from '../../lib/webhook.js'
import type { Config } from '../../lib/config.js'

const dummyConfig: Config = {
  forge: 'gitlab',
  webhookSecret: 'test',
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['main'],
  giteaUrl: null,
  giteaToken: null,
}

const SECRET = 'gitlab-test-token'

function makeHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(extra)) h.set(k, v)
  return h
}

function makePipelinePayload(overrides: {
  object_attributes?: Record<string, any>
  project?: Record<string, any>
  commit?: Record<string, any> | null
} = {}): string {
  return JSON.stringify({
    object_kind: 'pipeline',
    object_attributes: {
      id: 98765,
      name: 'CI/CD Pipeline',
      ref: 'main',
      sha: 'deadbeef12345678',
      status: 'failed',
      detailed_status: 'failed',
      ...(overrides.object_attributes ?? {}),
    },
    project: {
      id: 42,
      path_with_namespace: 'example/my-app',
      web_url: 'https://gitlab.example.com/example/my-app',
      ...(overrides.project ?? {}),
    },
    commit: overrides.commit !== undefined ? overrides.commit : {
      message: 'fix: update migration',
      author: { name: 'waleedkadous' },
    },
  })
}

describe('gitlabForge.validateSignature', () => {
  test('accepts valid token', () => {
    assert.strictEqual(
      gitlabForge.validateSignature('ignored', makeHeaders({ 'x-gitlab-token': SECRET }), SECRET),
      true,
    )
  })

  test('rejects invalid token', () => {
    assert.strictEqual(
      gitlabForge.validateSignature('ignored', makeHeaders({ 'x-gitlab-token': 'wrong-token' }), SECRET),
      false,
    )
  })

  test('rejects missing token header', () => {
    assert.strictEqual(
      gitlabForge.validateSignature('ignored', makeHeaders(), SECRET),
      false,
    )
  })

  test('rejects token with length mismatch', () => {
    assert.strictEqual(
      gitlabForge.validateSignature('ignored', makeHeaders({ 'x-gitlab-token': 'short' }), SECRET),
      false,
    )
  })

  test('payload is not used for validation (token-based)', () => {
    // GitLab uses token comparison, not HMAC — payload content doesn't matter
    assert.strictEqual(
      gitlabForge.validateSignature('any payload here', makeHeaders({ 'x-gitlab-token': SECRET }), SECRET),
      true,
    )
  })
})

describe('gitlabForge.parseWebhookEvent', () => {
  beforeEach(() => {
    clearDedup()
  })

  test('parses failed pipeline event correctly', () => {
    const body = makePipelinePayload()
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')

    assert.strictEqual(result.event.workflowName, 'CI/CD Pipeline')
    assert.strictEqual(result.event.conclusion, 'failed')
    assert.strictEqual(result.event.branch, 'main')
    assert.strictEqual(result.event.commitSha, 'deadbeef12345678')
    assert.strictEqual(result.event.commitMessage, 'fix: update migration')
    assert.strictEqual(result.event.commitAuthor, 'waleedkadous')
    assert.strictEqual(result.event.runId, 98765)
    assert.strictEqual(result.event.repoFullName, 'example/my-app')
    assert.strictEqual(result.event.runUrl, 'https://gitlab.example.com/example/my-app/-/pipelines/98765')
  })

  test('synthetic delivery ID includes status', () => {
    const body = makePipelinePayload()
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )

    assert.strictEqual(result.type, 'event')
    if (result.type !== 'event') throw new Error('Expected event')
    assert.strictEqual(result.event.deliveryId, 'gitlab-42-98765-failed')
  })

  test('different status transitions produce different delivery IDs', () => {
    const failedBody = makePipelinePayload({ object_attributes: { status: 'failed' } })
    const successBody = makePipelinePayload({ object_attributes: { status: 'success' } })

    const failedResult = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      failedBody,
    )
    const successResult = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      successBody,
    )

    assert.strictEqual(failedResult.type, 'event')
    assert.strictEqual(successResult.type, 'event')
    if (failedResult.type === 'event' && successResult.type === 'event') {
      assert.notStrictEqual(failedResult.event.deliveryId, successResult.event.deliveryId)
    }
  })

  test('accepts success terminal state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'success' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.conclusion, 'success')
    }
  })

  test('accepts canceled terminal state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'canceled' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
  })

  test('accepts skipped terminal state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'skipped' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
  })

  test('passes through running state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'running' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') assert.strictEqual(result.event.conclusion, 'running')
  })

  test('passes through pending state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'pending' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') assert.strictEqual(result.event.conclusion, 'pending')
  })

  test('passes through created state', () => {
    const body = makePipelinePayload({ object_attributes: { status: 'created' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') assert.strictEqual(result.event.conclusion, 'created')
  })

  test('rejects non-pipeline events', () => {
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Push Hook' }),
      '{"ref": "refs/heads/main"}',
    )
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('rejects missing event header', () => {
    const result = gitlabForge.parseWebhookEvent(makeHeaders(), makePipelinePayload())
    assert.strictEqual(result.type, 'irrelevant')
  })

  test('returns malformed for invalid JSON', () => {
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      'not json{{',
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for missing object_attributes', () => {
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      '{"object_kind": "pipeline"}',
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('returns malformed for missing project.path_with_namespace', () => {
    const body = JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 1, status: 'failed' },
      project: {},
    })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'malformed')
  })

  test('handles missing commit gracefully', () => {
    const body = makePipelinePayload({ commit: null })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.commitMessage, null)
      assert.strictEqual(result.event.commitAuthor, null)
    }
  })

  test('uses pipeline fallback for missing name', () => {
    const body = makePipelinePayload({ object_attributes: { name: undefined, status: 'failed' } })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.workflowName, 'pipeline')
    }
  })

  test('handles nested namespace repos', () => {
    const body = makePipelinePayload({
      project: { id: 99, path_with_namespace: 'group/subgroup/project', web_url: 'https://gitlab.example.com/group/subgroup/project' },
    })
    const result = gitlabForge.parseWebhookEvent(
      makeHeaders({ 'x-gitlab-event': 'Pipeline Hook' }),
      body,
    )
    assert.strictEqual(result.type, 'event')
    if (result.type === 'event') {
      assert.strictEqual(result.event.repoFullName, 'group/subgroup/project')
    }
  })
})

describe('gitlabForge.runReconciliation', () => {
  test('returns null when glab is not available', async () => {
    const result = await gitlabForge.runReconciliation(dummyConfig, 'main', 3000)
    assert.strictEqual(result, null)
  })
})

describe('gitlabForge.fetchFailedJobs', () => {
  test('returns null when glab is not available', async () => {
    const result = await gitlabForge.fetchFailedJobs(dummyConfig, 'nonexistent/project', 0)
    assert.strictEqual(result, null)
  })

  test('returns null for empty repo name', async () => {
    const result = await gitlabForge.fetchFailedJobs(dummyConfig, '', 0)
    assert.strictEqual(result, null)
  })
})
