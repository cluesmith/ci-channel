import { timingSafeEqual } from 'node:crypto'
import type { Forge } from '../forge.js'
import type { ParseResult, WebhookEvent } from '../webhook.js'
import type { Config } from '../config.js'
import { runCommand } from '../reconcile.js'

const TERMINAL_STATES = new Set(['success', 'failed', 'canceled', 'skipped'])

export const gitlabForge: Forge = {
  name: 'gitlab',

  validateSignature(_payload: string, headers: Headers, secret: string): boolean {
    const token = headers.get('x-gitlab-token')
    if (!token) return false

    const tokenBuf = Buffer.from(token, 'utf-8')
    const secretBuf = Buffer.from(secret, 'utf-8')

    if (tokenBuf.length !== secretBuf.length) return false

    try {
      return timingSafeEqual(tokenBuf, secretBuf)
    } catch {
      return false
    }
  },

  parseWebhookEvent(headers: Headers, body: string): ParseResult {
    const eventType = headers.get('x-gitlab-event')

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

    // Only Pipeline Hook events are relevant
    if (eventType !== 'Pipeline Hook') {
      return { type: 'irrelevant' }
    }

    const attrs = payload.object_attributes
    if (!attrs || typeof attrs !== 'object') {
      return { type: 'malformed', reason: 'Missing object_attributes' }
    }

    // Only terminal pipeline states generate notifications
    if (!TERMINAL_STATES.has(attrs.status)) {
      return { type: 'irrelevant' }
    }

    const project = payload.project
    if (!project || typeof project !== 'object' || typeof project.path_with_namespace !== 'string') {
      return { type: 'malformed', reason: 'Missing project.path_with_namespace' }
    }

    // Synthetic delivery ID: includes status so different state transitions aren't deduped
    const projectId = project.id ?? 'unknown'
    const pipelineId = attrs.id ?? 'unknown'
    const deliveryId = `gitlab-${projectId}-${pipelineId}-${attrs.status}`

    // Construct run URL from project web_url + pipeline ID
    const runUrl = project.web_url
      ? `${project.web_url}/-/pipelines/${attrs.id}`
      : ''

    return {
      type: 'event',
      event: {
        deliveryId,
        workflowName: attrs.name ?? 'pipeline',
        conclusion: attrs.status,
        branch: attrs.ref ?? 'unknown',
        commitSha: attrs.sha ?? 'unknown',
        commitMessage: payload.commit?.message ?? null,
        commitAuthor: payload.commit?.author?.name ?? null,
        runUrl,
        runId: attrs.id ?? 0,
        repoFullName: project.path_with_namespace,
      },
    }
  },

  async runReconciliation(_config: Config, branch: string, timeoutMs: number): Promise<WebhookEvent | null> {
    const output = await runCommand(
      ['glab', 'ci', 'list', '--branch', branch, '--per-page', '1', '--output', 'json'],
      timeoutMs,
    )

    if (!output) return null

    let pipelines: any[]
    try {
      pipelines = JSON.parse(output)
    } catch {
      console.error(`[ci-channel] Startup reconciliation: invalid JSON from glab for branch "${branch}"`)
      return null
    }

    if (!Array.isArray(pipelines) || pipelines.length === 0) return null

    const pipeline = pipelines[0]
    if (pipeline.status !== 'failed') return null

    return {
      deliveryId: `reconcile-${branch}-${pipeline.id ?? 'unknown'}`,
      workflowName: pipeline.source ?? 'pipeline',
      conclusion: pipeline.status,
      branch: pipeline.ref ?? branch,
      commitSha: pipeline.sha ?? 'unknown',
      commitMessage: null,
      commitAuthor: null,
      runUrl: pipeline.web_url ?? '',
      runId: pipeline.id ?? 0,
      repoFullName: '',
    }
  },

  async fetchFailedJobs(_config: Config, repoFullName: string, runId: number): Promise<string[] | null> {
    // URL-encode the project path for the API
    const encodedPath = encodeURIComponent(repoFullName)
    const output = await runCommand(
      ['glab', 'api', `/projects/${encodedPath}/pipelines/${runId}/jobs`, '--per-page', '100'],
      3000,
    )

    if (!output) return null

    let jobs: any[]
    try {
      jobs = JSON.parse(output)
    } catch {
      return null
    }

    if (!Array.isArray(jobs)) return null

    const failedNames = jobs
      .filter((j: any) => j.status === 'failed')
      .map((j: any) => j.name)
      .filter(Boolean)

    return failedNames.length > 0 ? failedNames : null
  },
}
