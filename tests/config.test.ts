import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../lib/config.js'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tmpDir: string
let envPath: string

// Save and restore original env vars
const savedEnv: Record<string, string | undefined> = {}
const envKeys = ['WEBHOOK_SECRET', 'PORT', 'SMEE_URL', 'GITHUB_REPOS', 'WORKFLOW_FILTER', 'RECONCILE_BRANCHES']

function saveEnv() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
  }
}

function restoreEnv() {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
}

function writeEnvFile(content: string) {
  writeFileSync(envPath, content)
}

describe('loadConfig', () => {
  beforeEach(() => {
    saveEnv()
    // Clear all relevant env vars
    for (const key of envKeys) {
      delete process.env[key]
    }
    // Create a temp directory for the env file
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-channel-test-'))
    envPath = join(tmpDir, '.env')
  })

  afterEach(() => {
    restoreEnv()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  test('throws when WEBHOOK_SECRET is missing', () => {
    assert.throws(() => loadConfig(envPath), { message: /WEBHOOK_SECRET is required/ })
  })

  test('loads WEBHOOK_SECRET from env var', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath)
    assert.strictEqual(config.webhookSecret, 'test-secret')
  })

  test('loads WEBHOOK_SECRET from env file', () => {
    writeEnvFile('WEBHOOK_SECRET=file-secret')
    const config = loadConfig(envPath)
    assert.strictEqual(config.webhookSecret, 'file-secret')
  })

  test('env var takes precedence over env file', () => {
    writeEnvFile('WEBHOOK_SECRET=file-secret')
    process.env.WEBHOOK_SECRET = 'env-secret'
    const config = loadConfig(envPath)
    assert.strictEqual(config.webhookSecret, 'env-secret')
  })

  test('defaults port to 8789', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath)
    assert.strictEqual(config.port, 8789)
  })

  test('parses custom PORT', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.PORT = '9999'
    const config = loadConfig(envPath)
    assert.strictEqual(config.port, 9999)
  })

  test('throws on non-numeric PORT', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.PORT = 'abc'
    assert.throws(() => loadConfig(envPath), { message: /Invalid PORT/ })
  })

  test('throws on PORT with trailing junk', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.PORT = '8789junk'
    assert.throws(() => loadConfig(envPath), { message: /Invalid PORT/ })
  })

  test('throws on floating point PORT', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.PORT = '8789.5'
    assert.throws(() => loadConfig(envPath), { message: /Invalid PORT/ })
  })

  test('parses SMEE_URL', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.SMEE_URL = 'https://smee.io/abc123'
    const config = loadConfig(envPath)
    assert.strictEqual(config.smeeUrl, 'https://smee.io/abc123')
  })

  test('SMEE_URL defaults to null', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath)
    assert.strictEqual(config.smeeUrl, null)
  })

  test('parses comma-separated GITHUB_REPOS', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.GITHUB_REPOS = 'owner/repo1, owner/repo2 , owner/repo3'
    const config = loadConfig(envPath)
    assert.deepStrictEqual(config.githubRepos, ['owner/repo1', 'owner/repo2', 'owner/repo3'])
  })

  test('GITHUB_REPOS defaults to null', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath)
    assert.strictEqual(config.githubRepos, null)
  })

  test('parses comma-separated WORKFLOW_FILTER', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.WORKFLOW_FILTER = 'CI Validation, Deploy Staging (Fly.io)'
    const config = loadConfig(envPath)
    assert.deepStrictEqual(config.workflowFilter, ['CI Validation', 'Deploy Staging (Fly.io)'])
  })

  test('defaults RECONCILE_BRANCHES to ci,develop', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath)
    assert.deepStrictEqual(config.reconcileBranches, ['ci', 'develop'])
  })

  test('parses custom RECONCILE_BRANCHES', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.RECONCILE_BRANCHES = 'main, staging'
    const config = loadConfig(envPath)
    assert.deepStrictEqual(config.reconcileBranches, ['main', 'staging'])
  })

  test('handles quoted values in env file', () => {
    writeEnvFile('WEBHOOK_SECRET="quoted-secret"\nSMEE_URL=\'single-quoted\'')
    const config = loadConfig(envPath)
    assert.strictEqual(config.webhookSecret, 'quoted-secret')
    assert.strictEqual(config.smeeUrl, 'single-quoted')
  })

  test('ignores comments and blank lines in env file', () => {
    writeEnvFile('# Comment\n\nWEBHOOK_SECRET=my-secret\n# Another comment')
    const config = loadConfig(envPath)
    assert.strictEqual(config.webhookSecret, 'my-secret')
  })

  test('handles empty GITHUB_REPOS as null', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    process.env.GITHUB_REPOS = '  ,  , '
    const config = loadConfig(envPath)
    assert.strictEqual(config.githubRepos, null)
  })

  test('handles missing env file gracefully', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(join(tmpDir, 'nonexistent', '.env'))
    assert.strictEqual(config.webhookSecret, 'test-secret')
  })
})
