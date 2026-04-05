import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Forge } from '../forge.js'
import type { ParseResult, WebhookEvent } from '../webhook.js'
import type { Config } from '../config.js'
import { runCommand } from '../exec.js'

export const githubForge: Forge = {
  name: 'github',

  validateSignature(payload: string, headers: Headers, secret: string): boolean {
    const signature = headers.get('x-hub-signature-256')
    if (!signature) return false

    const prefix = 'sha256='
    if (!signature.startsWith(prefix)) return false

    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    const received = signature.slice(prefix.length)

    if (expected.length !== received.length) return false

    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(received, 'hex'),
      )
    } catch {
      return false
    }
  },

  parseWebhookEvent(headers: Headers, body: string): ParseResult {
    const eventType = headers.get('x-github-event')
    const deliveryId = headers.get('x-github-delivery')

    // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped JSON
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch (e) {
      return { type: 'malformed', reason: `Invalid JSON: ${(e as Error).message}` }
    }

    if (!payload || typeof payload !== 'object') {
      return { type: 'malformed', reason: 'Payload is not an object' }
    }

    if (eventType !== 'workflow_run') {
      return { type: 'irrelevant' }
    }

    if (payload.action !== 'completed') {
      return { type: 'irrelevant' }
    }

    const run = payload.workflow_run
    if (!run || typeof run !== 'object') {
      return { type: 'malformed', reason: 'Missing workflow_run field' }
    }

    const repo = payload.repository
    if (!repo || typeof repo !== 'object' || typeof repo.full_name !== 'string') {
      return { type: 'malformed', reason: 'Missing repository.full_name' }
    }

    return {
      type: 'event',
      event: {
        deliveryId: deliveryId ?? 'unknown',
        workflowName: run.name ?? 'unknown',
        conclusion: run.conclusion ?? 'unknown',
        branch: run.head_branch ?? 'unknown',
        commitSha: run.head_sha ?? 'unknown',
        commitMessage: run.head_commit?.message ?? null,
        commitAuthor: run.head_commit?.author?.name ?? null,
        runUrl: run.html_url ?? '',
        runId: run.id ?? 0,
        repoFullName: repo.full_name,
      },
    }
  },

  async runReconciliation(_config: Config, branch: string, timeoutMs: number): Promise<WebhookEvent | null> {
    const output = await runCommand(
      ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'conclusion,name,headBranch,headSha,url,databaseId'],
      timeoutMs,
    )

    if (!output) {
      console.error(`[ci-channel] Startup reconciliation: could not check branch "${branch}" (gh unavailable or timed out)`)
      return null
    }

    let runs: any[]
    try {
      runs = JSON.parse(output)
    } catch {
      console.error(`[ci-channel] Startup reconciliation: invalid JSON from gh for branch "${branch}"`)
      return null
    }

    if (!Array.isArray(runs) || runs.length === 0) return null

    const run = runs[0]
    if (run.conclusion !== 'failure') return null

    return {
      deliveryId: `reconcile-${branch}-${run.databaseId ?? 'unknown'}`,
      workflowName: run.name ?? 'unknown',
      conclusion: run.conclusion,
      branch: run.headBranch ?? branch,
      commitSha: run.headSha ?? 'unknown',
      commitMessage: null,
      commitAuthor: null,
      runUrl: run.url ?? '',
      runId: run.databaseId ?? 0,
      repoFullName: '',
    }
  },

  async fetchFailedJobs(_config: Config, repoFullName: string, runId: number): Promise<string[] | null> {
    const output = await runCommand(
      ['gh', 'api', `/repos/${repoFullName}/actions/runs/${runId}/jobs`, '--jq', '.jobs[] | select(.conclusion == "failure") | .name'],
      3000,
    )

    if (!output) return null

    const jobs = output.split('\n').map(s => s.trim()).filter(Boolean)
    return jobs.length > 0 ? jobs : null
  },
}
