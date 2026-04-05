import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './config.js'
import { DEFAULT_ENV_PATH } from './config.js'

export interface BootstrapResult {
  webhookSecret: string
  smeeUrl: string | null
  wasProvisioned: boolean
}

export interface BootstrapDeps {
  ensureSecret(existing: string | null): { secret: string; generated: boolean }
  fetchSmeeChannel(): Promise<string | null>
  persistSmeeUrl(url: string): void
  startSmeeClient(source: string, target: string): void
  pushNotification(content: string, meta: Record<string, string>): Promise<void>
}

export function ensureSecretReal(existing: string | null): { secret: string; generated: boolean } {
  if (existing) {
    return { secret: existing, generated: false }
  }

  const secret = randomBytes(32).toString('hex')

  try {
    const envPath = DEFAULT_ENV_PATH
    const dir = dirname(envPath)
    mkdirSync(dir, { recursive: true })

    // Check if file exists and already has WEBHOOK_SECRET
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8')
      if (content.includes('WEBHOOK_SECRET=')) {
        const match = content.match(/^WEBHOOK_SECRET=(.+)$/m)
        if (match) return { secret: match[1].trim(), generated: false }
      }
    }

    appendFileSync(envPath, `WEBHOOK_SECRET=${secret}\n`)
    console.error(`[ci-channel] Generated webhook secret and saved to ${envPath}`)
  } catch (err) {
    console.error(`[ci-channel] Warning: could not write secret to ${DEFAULT_ENV_PATH}: ${err}`)
  }

  return { secret, generated: true }
}

export async function bootstrap(
  config: Config,
  localTarget: string,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  // Step 1: Ensure webhook secret
  const { secret, generated: secretGenerated } = deps.ensureSecret(config.webhookSecret)

  // Step 2: Resolve smee URL
  let smeeUrl = config.smeeUrl
  let smeeProvisioned = false
  if (!smeeUrl) {
    smeeUrl = await deps.fetchSmeeChannel()
    if (smeeUrl) {
      smeeProvisioned = true
      // Persist to .env so the same URL survives restarts
      deps.persistSmeeUrl(smeeUrl)
    } else {
      console.error('[ci-channel] Warning: could not provision smee channel — webhook relay not available')
    }
  }

  // Step 3: Start smee client (note: actual relay startup may be async in production;
  // bootstrap reports intent, not completion — relay starting a few ms late is harmless)
  if (smeeUrl) {
    try {
      deps.startSmeeClient(smeeUrl, localTarget)
      console.error(`[ci-channel] Webhook relay active: ${smeeUrl}`)
    } catch (err) {
      console.error(`[ci-channel] Warning: smee-client failed to start: ${err}`)
    }
  }

  // Step 4: Push setup notification if anything was auto-provisioned
  const wasProvisioned = secretGenerated || smeeProvisioned
  if (wasProvisioned) {
    const lines = ['CI channel ready. Configure your forge webhook:']
    if (smeeUrl) lines.push(`  URL: ${smeeUrl}`)
    lines.push(`  Secret: ${secret}`)
    lines.push('  Events: Workflow runs (GitHub/Gitea) or Pipeline events (GitLab)')

    const content = lines.join('\n')
    try {
      await deps.pushNotification(content, { setup: 'true' })
    } catch {
      // Notification push failed — stderr backup is sufficient
    }
    console.error(`[ci-channel] ${content}`)
  }

  return { webhookSecret: secret, smeeUrl, wasProvisioned }
}

export async function fetchSmeeChannel(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)

    const resp = await fetch('https://smee.io/new', { redirect: 'manual', signal: controller.signal })
    clearTimeout(timer)

    const location = resp.headers.get('location')
    if (location && location.startsWith('https://smee.io/')) {
      return location
    }
    console.error('[ci-channel] Warning: smee.io did not return a channel URL')
    return null
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error('[ci-channel] Warning: smee.io timed out (5s) — continuing without relay')
    } else {
      console.error(`[ci-channel] Warning: could not reach smee.io: ${err}`)
    }
    return null
  }
}

export function persistSmeeUrlReal(url: string): void {
  try {
    const envPath = DEFAULT_ENV_PATH
    const dir = dirname(envPath)
    mkdirSync(dir, { recursive: true })

    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8')
      if (content.includes('SMEE_URL=')) return // already persisted
    }

    appendFileSync(envPath, `SMEE_URL=${url}\n`)
    console.error(`[ci-channel] Persisted smee URL to ${envPath}`)
  } catch (err) {
    console.error(`[ci-channel] Warning: could not persist smee URL: ${err}`)
  }
}
