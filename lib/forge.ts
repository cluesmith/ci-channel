import type { ParseResult, WebhookEvent } from './webhook.js'
import type { Config } from './config.js'

/**
 * Forge interface — encapsulates all forge-specific behavior.
 * Each forge (GitHub, GitLab, Gitea) implements this interface.
 */
export interface Forge {
  readonly name: string

  /** Validate webhook signature/token from request headers. */
  validateSignature(payload: string, headers: Headers, secret: string): boolean

  /** Parse webhook payload into a WebhookEvent (or irrelevant/malformed). */
  parseWebhookEvent(headers: Headers, body: string): ParseResult

  /** Fetch the most recent run for a branch (for startup reconciliation). */
  runReconciliation(config: Config, branch: string, timeoutMs: number): Promise<WebhookEvent | null>

  /** Fetch names of failed jobs for a given run (for async enrichment). */
  fetchFailedJobs(config: Config, repoFullName: string, runId: number): Promise<string[] | null>
}
