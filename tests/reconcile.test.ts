import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { githubForge } from '../lib/forges/github.js'
import type { Config } from '../lib/config.js'

const dummyConfig: Config = {
  forge: 'github',
  webhookSecret: 'test',
  port: 0,
  smeeUrl: null,
  repos: null,
  workflowFilter: null,
  reconcileBranches: ['ci', 'develop'],
  giteaUrl: null,
  giteaToken: null,
}

// Note: runStartupReconciliation is harder to unit test because it spawns
// child processes internally. We test fetchFailedJobs which uses the same
// runCommand helper. Full integration tests are in the stdio lifecycle test.

describe('fetchFailedJobs', () => {
  test('returns null when gh is not available', async () => {
    const result = await githubForge.fetchFailedJobs(dummyConfig, 'nonexistent/repo-that-does-not-exist-abc123', 0)
    assert.strictEqual(result, null)
  })

  test('returns null on timeout (tested via invalid command)', async () => {
    const result = await githubForge.fetchFailedJobs(dummyConfig, '', 0)
    assert.strictEqual(result, null)
  })
})

// Test the notification formatting used by reconciliation
import { formatNotification } from '../lib/notify.js'
import type { WebhookEvent } from '../lib/webhook.js'

describe('reconciliation notification formatting', () => {
  test('formats reconciled event without commit info', () => {
    const event: WebhookEvent = {
      deliveryId: 'reconcile-ci-12345',
      workflowName: 'CI Validation',
      conclusion: 'failure',
      branch: 'ci',
      commitSha: 'abc123',
      commitMessage: null,
      commitAuthor: null,
      runUrl: 'https://github.com/owner/repo/actions/runs/12345',
      runId: 12345,
      repoFullName: '',
    }

    const notification = formatNotification(event)
    assert.ok(notification.content.includes('CI failure: CI Validation on branch ci'))
    assert.ok(notification.content.includes('abc123'))
    assert.ok(!notification.content.includes('by'))
  })

  test('reconciled event has correct meta attributes', () => {
    const event: WebhookEvent = {
      deliveryId: 'reconcile-develop-67890',
      workflowName: 'Deploy Staging (Fly.io)',
      conclusion: 'failure',
      branch: 'develop',
      commitSha: 'def456',
      commitMessage: null,
      commitAuthor: null,
      runUrl: 'https://github.com/owner/repo/actions/runs/67890',
      runId: 67890,
      repoFullName: '',
    }

    const notification = formatNotification(event)
    assert.strictEqual(notification.meta.workflow, 'Deploy Staging (Fly.io)')
    assert.strictEqual(notification.meta.branch, 'develop')
    assert.strictEqual(notification.meta.run_id, '67890')
  })
})
