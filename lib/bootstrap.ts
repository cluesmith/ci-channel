import { randomBytes } from 'node:crypto'
import type { Config } from './config.js'
import { loadState, saveState, type PluginState } from './state.js'

export interface BootstrapResult {
  webhookSecret: string
  smeeUrl: string | null
  wasProvisioned: boolean
}

export interface BootstrapDeps {
  ensureSecret(existing: string | null): { secret: string; generated: boolean }
  fetchSmeeChannel(): Promise<string | null>
  persistState(state: PluginState): void
  startSmeeClient(source: string, target: string): void
  pushNotification(content: string, meta: Record<string, string>): Promise<void>
}

export function ensureSecretReal(existing: string | null): { secret: string; generated: boolean } {
  if (existing) {
    return { secret: existing, generated: false }
  }

  // Check state.json for a previously generated secret
  const state = loadState()
  if (state.webhookSecret) {
    return { secret: state.webhookSecret, generated: false }
  }

  return { secret: randomBytes(32).toString('hex'), generated: true }
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
    } else {
      console.error('[ci-channel] Warning: could not provision smee channel — webhook relay not available')
    }
  }

  // Step 3: Persist auto-provisioned state to state.json
  if (secretGenerated || smeeProvisioned) {
    const stateToSave: PluginState = {}
    if (secretGenerated) stateToSave.webhookSecret = secret
    if (smeeProvisioned && smeeUrl) stateToSave.smeeUrl = smeeUrl

    // Merge with existing state
    const existing = loadState()
    deps.persistState({ ...existing, ...stateToSave })
    console.error('[ci-channel] Saved auto-provisioned state to state.json')
  }

  // Step 4: Start smee client
  if (smeeUrl) {
    try {
      deps.startSmeeClient(smeeUrl, localTarget)
      console.error(`[ci-channel] Webhook relay active: ${smeeUrl}`)
    } catch (err) {
      console.error(`[ci-channel] Warning: smee-client failed to start: ${err}`)
    }
  }

  // Step 5: Push ready notification on every startup
  const wasProvisioned = secretGenerated || smeeProvisioned
  const repoInfo = config.repos?.length
    ? ` Monitoring: ${config.repos.join(', ')}.`
    : ' Monitoring: all repos (no filter).'
  const content = `CI channel ready (${config.forge}).${repoInfo}`
  try {
    await deps.pushNotification(content, { setup: 'true' })
  } catch {
    // Notification push failed — stderr backup is sufficient
  }
  console.error(`[ci-channel] ${content}`)

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
