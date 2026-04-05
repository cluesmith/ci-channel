import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Forge } from '../forge.js'
import type { ParseResult, WebhookEvent } from '../webhook.js'
import type { Config } from '../config.js'

export const giteaForge: Forge = {
  name: 'gitea',

  validateSignature(payload: string, headers: Headers, secret: string): boolean {
    const signature = headers.get('x-gitea-signature')
    if (!signature) return false

    // Gitea uses HMAC-SHA256 like GitHub, but raw hex (no "sha256=" prefix)
    const expected = createHmac('sha256', secret).update(payload).digest('hex')

    if (expected.length !== signature.length) return false

    try {
      return timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex'),
      )
    } catch {
      return false
    }
  },

  parseWebhookEvent(headers: Headers, body: string): ParseResult {
    const eventType = headers.get('x-gitea-event')
    const deliveryId = headers.get('x-gitea-delivery')

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

    // Gitea uses the same event structure as GitHub
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

  async runReconciliation(config: Config, branch: string, timeoutMs: number): Promise<WebhookEvent | null> {
    if (!config.giteaUrl) {
      console.error('[ci-channel] Startup reconciliation: --gitea-url not configured, skipping')
      return null
    }

    // Use repos config to determine which repo to check
    if (!config.repos || config.repos.length === 0) {
      return null
    }

    const repo = config.repos[0] // Check the first configured repo
    const url = `${config.giteaUrl}/api/v1/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&limit=1`
    const headers: Record<string, string> = {}
    if (config.giteaToken) {
      headers['Authorization'] = `token ${config.giteaToken}`
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const resp = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)

      if (!resp.ok) {
        console.error(`[ci-channel] Startup reconciliation: Gitea API returned ${resp.status} for branch "${branch}"`)
        return null
      }

      const data = await resp.json() as any
      const runs = Array.isArray(data) ? data : data?.workflow_runs
      if (!Array.isArray(runs) || runs.length === 0) return null

      const run = runs[0]
      if (run.conclusion !== 'failure') return null

      return {
        deliveryId: `reconcile-${branch}-${run.id ?? 'unknown'}`,
        workflowName: run.name ?? 'unknown',
        conclusion: run.conclusion,
        branch: run.head_branch ?? branch,
        commitSha: run.head_sha ?? 'unknown',
        commitMessage: null,
        commitAuthor: null,
        runUrl: run.html_url ?? '',
        runId: run.id ?? 0,
        repoFullName: repo,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.error(`[ci-channel] Startup reconciliation: Gitea API timed out for branch "${branch}"`)
      } else {
        console.error(`[ci-channel] Startup reconciliation: Gitea API error for branch "${branch}": ${err}`)
      }
      return null
    }
  },

  async fetchFailedJobs(config: Config, repoFullName: string, runId: number): Promise<string[] | null> {
    if (!config.giteaUrl) return null

    const url = `${config.giteaUrl}/api/v1/repos/${repoFullName}/actions/runs/${runId}/jobs`
    const headers: Record<string, string> = {}
    if (config.giteaToken) {
      headers['Authorization'] = `token ${config.giteaToken}`
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)

      const resp = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)

      if (!resp.ok) return null

      const data = await resp.json() as any
      const jobs = Array.isArray(data) ? data : data?.jobs
      if (!Array.isArray(jobs)) return null

      const failedNames = jobs
        .filter((j: any) => j.conclusion === 'failure')
        .map((j: any) => j.name)
        .filter(Boolean)

      return failedNames.length > 0 ? failedNames : null
    } catch {
      return null
    }
  },
}
