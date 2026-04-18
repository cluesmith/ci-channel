import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Config } from './config.js'
import type { Forge } from './forge.js'
import { isConclusionAllowed, isDuplicate, isRepoAllowed, isWorkflowAllowed } from './webhook.js'
import { formatNotification, pushNotification, sanitize } from './notify.js'

export function createWebhookHandler(config: Config, mcp: Server, forge: Forge) {
  return async function handleWebhook(req: Request): Promise<Response> {
    const body = await req.text()

    // Step 1: Validate signature using forge-specific logic
    if (!config.webhookSecret || !forge.validateSignature(body, req.headers, config.webhookSecret)) {
      return new Response('Invalid signature', { status: 403 })
    }

    // Step 2: Parse the event using forge-specific logic
    const result = forge.parseWebhookEvent(req.headers, body)

    if (result.type === 'malformed') {
      return new Response(result.reason, { status: 400 })
    }

    if (result.type === 'irrelevant') {
      return new Response('ok')
    }

    const { event } = result

    // Step 3: Check for duplicate delivery
    if (isDuplicate(event.deliveryId)) {
      return new Response('ok')
    }

    // Step 4: Check repo allowlist
    if (!isRepoAllowed(event.repoFullName, config.repos)) {
      return new Response('ok')
    }

    // Step 5: Check workflow filter
    if (!isWorkflowAllowed(event.workflowName, config.workflowFilter)) {
      return new Response('ok')
    }

    // Step 6: Check conclusion filter
    if (!isConclusionAllowed(event.conclusion, config.conclusions)) {
      return new Response('ok')
    }

    // Step 7: Format and push notification immediately (never blocked by enrichment)
    const notification = formatNotification(event)
    await pushNotification(mcp, notification)

    // Step 8: Async enrichment — fire-and-forget, never blocks the response
    if (event.repoFullName && event.runId) {
      forge.fetchFailedJobs(config, event.repoFullName, event.runId).then(jobs => {
        if (jobs && jobs.length > 0) {
          const sanitizedWorkflow = sanitize(event.workflowName, 200)
          const sanitizedJobs = jobs.map(j => sanitize(j, 200)).join(', ')
          return pushNotification(mcp, {
            content: `Failed jobs for ${sanitizedWorkflow}: ${sanitizedJobs}`,
            meta: { run_id: String(event.runId), enrichment: 'true' },
          })
        }
      }).catch(() => {}) // swallow enrichment errors silently
    }

    return new Response('ok')
  }
}
