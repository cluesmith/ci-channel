import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Config } from './config.js'
import { validateSignature, parseWebhookEvent, isDuplicate, isRepoAllowed, isWorkflowAllowed } from './webhook.js'
import { formatNotification, pushNotification, sanitize } from './notify.js'
import { fetchFailedJobs } from './reconcile.js'

export function createWebhookHandler(config: Config, mcp: Server) {
  return async function handleWebhook(req: Request): Promise<Response> {
    const signature = req.headers.get('x-hub-signature-256')
    const eventType = req.headers.get('x-github-event')
    const deliveryId = req.headers.get('x-github-delivery')

    const body = await req.text()

    // Step 1: Validate signature
    if (!validateSignature(body, signature, config.webhookSecret)) {
      return new Response('Invalid signature', { status: 403 })
    }

    // Step 2: Check for duplicate delivery
    if (deliveryId && isDuplicate(deliveryId)) {
      return new Response('ok')
    }

    // Step 3: Parse the event
    const result = parseWebhookEvent(eventType, deliveryId, body)

    if (result.type === 'malformed') {
      return new Response(result.reason, { status: 400 })
    }

    if (result.type === 'irrelevant') {
      return new Response('ok')
    }

    const { event } = result

    // Step 4: Check repo allowlist
    if (!isRepoAllowed(event.repoFullName, config.githubRepos)) {
      return new Response('ok')
    }

    // Step 5: Check workflow filter
    if (!isWorkflowAllowed(event.workflowName, config.workflowFilter)) {
      return new Response('ok')
    }

    // Step 6: Format and push notification immediately (never blocked by enrichment)
    const notification = formatNotification(event)
    await pushNotification(mcp, notification)

    // Step 7: Async enrichment — fire-and-forget, never blocks the response
    if (event.repoFullName && event.runId) {
      fetchFailedJobs(event.repoFullName, event.runId).then(jobs => {
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
