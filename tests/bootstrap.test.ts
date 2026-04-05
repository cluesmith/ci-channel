import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { bootstrap, type BootstrapDeps } from '../lib/bootstrap.js'
import type { Config } from '../lib/config.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    forge: 'github',
    webhookSecret: null,
    port: 0,
    smeeUrl: null,
    repos: null,
    workflowFilter: null,
    reconcileBranches: ['ci', 'develop'],
    giteaUrl: null,
    giteaToken: null,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps & {
  notifications: Array<{ content: string; meta: Record<string, string> }>
  smeeClients: Array<{ source: string; target: string }>
  persistedSmeeUrls: string[]
} {
  const notifications: Array<{ content: string; meta: Record<string, string> }> = []
  const smeeClients: Array<{ source: string; target: string }> = []
  const persistedSmeeUrls: string[] = []
  return {
    notifications,
    smeeClients,
    persistedSmeeUrls,
    ensureSecret: (existing) => {
      if (existing) return { secret: existing, generated: false }
      return { secret: 'generated-secret-abc123', generated: true }
    },
    fetchSmeeChannel: async () => 'https://smee.io/test-channel',
    persistSmeeUrl: (url) => { persistedSmeeUrls.push(url) },
    startSmeeClient: (source, target) => { smeeClients.push({ source, target }) },
    pushNotification: async (content, meta) => { notifications.push({ content, meta }) },
    ...overrides,
  }
}

describe('bootstrap', () => {
  test('auto-generates secret when webhookSecret is null', async () => {
    const deps = makeDeps()
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(result.webhookSecret, 'generated-secret-abc123')
    assert.strictEqual(result.wasProvisioned, true)
  })

  test('uses existing secret when provided', async () => {
    const deps = makeDeps()
    const result = await bootstrap(
      makeConfig({ webhookSecret: 'my-existing-secret' }),
      'http://127.0.0.1:1234/webhook',
      deps,
    )

    assert.strictEqual(result.webhookSecret, 'my-existing-secret')
  })

  test('auto-provisions smee channel when smeeUrl is null', async () => {
    const deps = makeDeps()
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(result.smeeUrl, 'https://smee.io/test-channel')
    assert.strictEqual(result.wasProvisioned, true)
  })

  test('uses existing smeeUrl when provided', async () => {
    const deps = makeDeps()
    const result = await bootstrap(
      makeConfig({ smeeUrl: 'https://smee.io/existing' }),
      'http://127.0.0.1:1234/webhook',
      deps,
    )

    assert.strictEqual(result.smeeUrl, 'https://smee.io/existing')
    // smeeProvisioned is false — only secretGenerated might be true
  })

  test('starts smee client with correct source and target', async () => {
    const deps = makeDeps()
    await bootstrap(makeConfig(), 'http://127.0.0.1:5678/webhook', deps)

    assert.strictEqual(deps.smeeClients.length, 1)
    assert.strictEqual(deps.smeeClients[0].source, 'https://smee.io/test-channel')
    assert.strictEqual(deps.smeeClients[0].target, 'http://127.0.0.1:5678/webhook')
  })

  test('pushes setup notification when provisioned', async () => {
    const deps = makeDeps()
    await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(deps.notifications.length, 1)
    assert.ok(deps.notifications[0].content.includes('CI channel ready'))
    assert.ok(deps.notifications[0].content.includes('https://smee.io/test-channel'))
    assert.ok(deps.notifications[0].content.includes('generated-secret-abc123'))
    assert.deepStrictEqual(deps.notifications[0].meta, { setup: 'true' })
  })

  test('does not push notification when nothing provisioned', async () => {
    const deps = makeDeps()
    await bootstrap(
      makeConfig({ webhookSecret: 'existing', smeeUrl: 'https://smee.io/existing' }),
      'http://127.0.0.1:1234/webhook',
      deps,
    )

    assert.strictEqual(deps.notifications.length, 0)
  })

  test('handles smee provisioning failure gracefully', async () => {
    const deps = makeDeps({
      fetchSmeeChannel: async () => null,
    })
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(result.smeeUrl, null)
    assert.strictEqual(result.wasProvisioned, true) // secret was still generated
    assert.strictEqual(deps.smeeClients.length, 0) // no client started
  })

  test('handles smee client crash gracefully', async () => {
    const deps = makeDeps({
      startSmeeClient: () => { throw new Error('SmeeClient crashed') },
    })
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    // Should not throw — continues without relay
    assert.strictEqual(result.smeeUrl, 'https://smee.io/test-channel')
    assert.strictEqual(result.wasProvisioned, true)
  })

  test('handles notification push failure gracefully', async () => {
    const deps = makeDeps({
      pushNotification: async () => { throw new Error('MCP push failed') },
    })

    // Should not throw
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)
    assert.strictEqual(result.wasProvisioned, true)
  })

  test('persists auto-provisioned smee URL', async () => {
    const deps = makeDeps()
    await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(deps.persistedSmeeUrls.length, 1)
    assert.strictEqual(deps.persistedSmeeUrls[0], 'https://smee.io/test-channel')
  })

  test('does not persist smee URL when provided via config', async () => {
    const deps = makeDeps()
    await bootstrap(
      makeConfig({ smeeUrl: 'https://smee.io/existing' }),
      'http://127.0.0.1:1234/webhook',
      deps,
    )

    assert.strictEqual(deps.persistedSmeeUrls.length, 0)
  })

  test('idempotent: existing secret returned when ensureSecret finds one', async () => {
    const deps = makeDeps({
      ensureSecret: (existing) => {
        // Simulate: secret not passed in config but found on disk
        if (!existing) return { secret: 'found-on-disk', generated: false }
        return { secret: existing, generated: false }
      },
    })
    const result = await bootstrap(makeConfig(), 'http://127.0.0.1:1234/webhook', deps)

    assert.strictEqual(result.webhookSecret, 'found-on-disk')
    // wasProvisioned = smeeProvisioned only (secretGenerated is false)
    assert.strictEqual(result.wasProvisioned, true) // smee was still auto-provisioned
  })
})
