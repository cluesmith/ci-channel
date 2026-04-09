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
const envKeys = [
  'WEBHOOK_SECRET', 'PORT', 'SMEE_URL', 'GITHUB_REPOS', 'REPOS',
  'WORKFLOW_FILTER', 'RECONCILE_BRANCHES', 'FORGE', 'GITEA_URL', 'GITEA_TOKEN',
]

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
    for (const key of envKeys) {
      delete process.env[key]
    }
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-channel-test-'))
    envPath = join(tmpDir, '.env')
  })

  afterEach(() => {
    restoreEnv()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  test('webhookSecret is null when not set (auto-generate later)', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, null)
  })

  test('loads WEBHOOK_SECRET from env var', () => {
    process.env.WEBHOOK_SECRET = 'test-secret'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, 'test-secret')
  })

  test('loads WEBHOOK_SECRET from env file', () => {
    writeEnvFile('WEBHOOK_SECRET=file-secret')
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, 'file-secret')
  })

  test('env var takes precedence over env file', () => {
    writeEnvFile('WEBHOOK_SECRET=file-secret')
    process.env.WEBHOOK_SECRET = 'env-secret'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, 'env-secret')
  })

  test('defaults port to 0', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.port, 0)
  })

  test('parses custom PORT from env', () => {
    process.env.PORT = '9999'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.port, 9999)
  })

  test('--port CLI arg takes precedence over PORT env', () => {
    process.env.PORT = '9999'
    const config = loadConfig(envPath, ['--port', '7777'])
    assert.strictEqual(config.port, 7777)
  })

  test('throws on non-numeric PORT', () => {
    process.env.PORT = 'abc'
    assert.throws(() => loadConfig(envPath, [], join(tmpDir, 'state.json')), { message: /Invalid PORT/ })
  })

  test('throws on PORT with trailing junk', () => {
    process.env.PORT = '8789junk'
    assert.throws(() => loadConfig(envPath, [], join(tmpDir, 'state.json')), { message: /Invalid PORT/ })
  })

  test('throws on floating point PORT', () => {
    process.env.PORT = '8789.5'
    assert.throws(() => loadConfig(envPath, [], join(tmpDir, 'state.json')), { message: /Invalid PORT/ })
  })

  test('parses SMEE_URL', () => {
    process.env.SMEE_URL = 'https://smee.io/abc123'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.smeeUrl, 'https://smee.io/abc123')
  })

  test('SMEE_URL defaults to null', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.smeeUrl, null)
  })

  test('parses comma-separated GITHUB_REPOS into repos', () => {
    process.env.GITHUB_REPOS = 'owner/repo1, owner/repo2 , owner/repo3'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.repos, ['owner/repo1', 'owner/repo2', 'owner/repo3'])
  })

  test('repos defaults to null', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.repos, null)
  })

  test('parses comma-separated WORKFLOW_FILTER', () => {
    process.env.WORKFLOW_FILTER = 'CI Validation, Deploy Staging (Fly.io)'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.workflowFilter, ['CI Validation', 'Deploy Staging (Fly.io)'])
  })

  test('defaults RECONCILE_BRANCHES to ci,develop', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.reconcileBranches, ['ci', 'develop'])
  })

  test('parses custom RECONCILE_BRANCHES', () => {
    process.env.RECONCILE_BRANCHES = 'main, staging'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.reconcileBranches, ['main', 'staging'])
  })

  test('handles quoted values in env file', () => {
    writeEnvFile('WEBHOOK_SECRET="quoted-secret"\nSMEE_URL=\'single-quoted\'')
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, 'quoted-secret')
    assert.strictEqual(config.smeeUrl, 'single-quoted')
  })

  test('ignores comments and blank lines in env file', () => {
    writeEnvFile('# Comment\n\nWEBHOOK_SECRET=my-secret\n# Another comment')
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.webhookSecret, 'my-secret')
  })

  test('handles empty GITHUB_REPOS as null', () => {
    process.env.GITHUB_REPOS = '  ,  , '
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.repos, null)
  })

  test('handles missing env file gracefully', () => {
    const config = loadConfig(join(tmpDir, 'nonexistent', '.env'), [])
    assert.strictEqual(config.webhookSecret, null)
  })
})

describe('loadConfig: forge selection', () => {
  beforeEach(() => {
    saveEnv()
    for (const key of envKeys) delete process.env[key]
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-channel-test-'))
    envPath = join(tmpDir, '.env')
  })

  afterEach(() => {
    restoreEnv()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  test('defaults forge to github', () => {
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.forge, 'github')
  })

  test('--forge cli arg selects forge', () => {
    const config = loadConfig(envPath, ['--forge', 'gitlab'])
    assert.strictEqual(config.forge, 'gitlab')
  })

  test('FORGE env var selects forge', () => {
    process.env.FORGE = 'gitea'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.forge, 'gitea')
  })

  test('--forge cli arg takes precedence over FORGE env', () => {
    process.env.FORGE = 'gitea'
    const config = loadConfig(envPath, ['--forge', 'gitlab'])
    assert.strictEqual(config.forge, 'gitlab')
  })

  test('invalid forge throws', () => {
    assert.throws(() => loadConfig(envPath, ['--forge', 'bitbucket']), { message: /Invalid FORGE/ })
  })
})

describe('loadConfig: CLI arg parsing', () => {
  beforeEach(() => {
    saveEnv()
    for (const key of envKeys) delete process.env[key]
    tmpDir = mkdtempSync(join(tmpdir(), 'ci-channel-test-'))
    envPath = join(tmpDir, '.env')
  })

  afterEach(() => {
    restoreEnv()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  test('--repos CLI arg works', () => {
    const config = loadConfig(envPath, ['--repos', 'owner/repo1,owner/repo2'])
    assert.deepStrictEqual(config.repos, ['owner/repo1', 'owner/repo2'])
  })

  test('--repos takes precedence over REPOS env', () => {
    process.env.REPOS = 'env/repo'
    const config = loadConfig(envPath, ['--repos', 'cli/repo'])
    assert.deepStrictEqual(config.repos, ['cli/repo'])
  })

  test('REPOS env takes precedence over GITHUB_REPOS', () => {
    process.env.GITHUB_REPOS = 'github/repo'
    process.env.REPOS = 'repos/repo'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.repos, ['repos/repo'])
  })

  test('GITHUB_REPOS works as fallback', () => {
    process.env.GITHUB_REPOS = 'github/repo'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.deepStrictEqual(config.repos, ['github/repo'])
  })

  test('unknown flag throws', () => {
    assert.throws(() => loadConfig(envPath, ['--badarg', 'value']), { message: /Unknown flag/ })
  })

  test('missing value for flag throws', () => {
    assert.throws(() => loadConfig(envPath, ['--forge']), { message: /Missing value/ })
  })

  test('non-flag argument throws', () => {
    assert.throws(() => loadConfig(envPath, ['notaflag']), { message: /Unexpected argument/ })
  })

  test('--smee-url CLI arg works', () => {
    const config = loadConfig(envPath, ['--smee-url', 'https://smee.io/test'])
    assert.strictEqual(config.smeeUrl, 'https://smee.io/test')
  })

  test('--workflow-filter CLI arg works', () => {
    const config = loadConfig(envPath, ['--workflow-filter', 'CI,Deploy'])
    assert.deepStrictEqual(config.workflowFilter, ['CI', 'Deploy'])
  })

  test('--reconcile-branches CLI arg works', () => {
    const config = loadConfig(envPath, ['--reconcile-branches', 'main,staging'])
    assert.deepStrictEqual(config.reconcileBranches, ['main', 'staging'])
  })

  test('--gitea-url CLI arg works', () => {
    const config = loadConfig(envPath, ['--gitea-url', 'https://gitea.example.com'])
    assert.strictEqual(config.giteaUrl, 'https://gitea.example.com')
  })

  test('GITEA_TOKEN loaded from env', () => {
    process.env.GITEA_TOKEN = 'my-token'
    const config = loadConfig(envPath, [], join(tmpDir, 'state.json'))
    assert.strictEqual(config.giteaToken, 'my-token')
  })
})
