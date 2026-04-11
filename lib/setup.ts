import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchSmeeChannel } from './bootstrap.js'
import { findProjectRoot } from './project-root.js'
import { loadState } from './state.js'

const CI_MCP_ENTRY = { command: 'npx', args: ['-y', 'ci-channel'] }

const log = (msg: string) => console.error(`[ci-channel] ${msg}`)

function parseArgs(argv: string[]): { repo: string } {
  let repo: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && i + 1 < argv.length) {
      repo = argv[i + 1]
      i++
    } else {
      throw new Error(`Usage: ci-channel setup --repo owner/repo (unexpected arg: ${argv[i]})`)
    }
  }
  if (!repo) throw new Error('Usage: ci-channel setup --repo owner/repo')
  return { repo }
}

class GhError extends Error {
  constructor(
    public readonly code: number,
    public readonly stderr: string,
    public readonly command: string,
  ) {
    super(`gh ${command} exited ${code}: ${stderr.trim()}`)
  }
  get is404(): boolean {
    return /HTTP 404|Not Found/i.test(this.stderr)
  }
  get is403(): boolean {
    return /HTTP 403|Forbidden/i.test(this.stderr)
  }
  get isAuth(): boolean {
    return /authentication|not logged in|401/i.test(this.stderr)
  }
}

function ghApi(args: string[], stdinBody: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('gh CLI not found. Install from https://cli.github.com/ and run `gh auth login`.'))
      } else {
        reject(err)
      }
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new GhError(code ?? -1, stderr, args.join(' ')))
      }
    })
    child.stdin.end(stdinBody ?? '')
  })
}

export async function setup(argv: string[]): Promise<void> {
  try {
    const { repo } = parseArgs(argv)
    const root = findProjectRoot()
    if (!root) {
      throw new Error('No project root found (no .git/ or .mcp.json in any ancestor). Run this from inside the project you want to install into.')
    }
    log(`Project root: ${root}`)
    log(`Target repo:  ${repo}`)

    const statePath = join(root, '.claude', 'channels', 'ci', 'state.json')
    const existing = loadState(statePath)

    let secret = existing.webhookSecret
    if (!secret) {
      secret = randomBytes(32).toString('hex')
      log('Generated new webhook secret')
    } else {
      log('Reusing existing webhook secret from state.json')
    }

    let smeeUrl = existing.smeeUrl
    if (!smeeUrl) {
      log('Provisioning smee.io channel...')
      const fetched = await fetchSmeeChannel()
      if (!fetched) {
        throw new Error('Failed to provision smee.io channel (smee.io unreachable or returned no Location header)')
      }
      smeeUrl = fetched
      log(`Provisioned smee channel: ${smeeUrl}`)
    } else {
      log(`Reusing existing smee channel: ${smeeUrl}`)
    }

    // Correctness check, not speed optimization. PluginState has exactly
    // two optional fields; if on-disk state has extras (manual edit, version
    // drift), the key-count check forces a rewrite to match desired state.
    const unchanged =
      existing.webhookSecret === secret &&
      existing.smeeUrl === smeeUrl &&
      Object.keys(existing).length === 2
    if (!unchanged) {
      const desired = { webhookSecret: secret, smeeUrl }
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(desired, null, 2) + '\n', { mode: 0o600 })
      log(`Wrote ${statePath} (mode 0o600)`)
    } else {
      log(`state.json already matches desired state — skipping write`)
    }

    log(`Listing existing webhooks on ${repo}...`)
    let listOut: string
    try {
      listOut = await ghApi(
        ['api', '--paginate', '--slurp', `repos/${repo}/hooks`],
        null,
      )
    } catch (err) {
      if (err instanceof GhError) {
        if (err.is404) {
          throw new Error(`Could not find repo '${repo}'. Check the spelling, or verify you have access (gh returned 404).`)
        }
        if (err.is403) {
          throw new Error(`Access denied to '${repo}' webhooks. Your gh token likely needs the 'admin:repo_hook' scope. Run \`gh auth refresh -s admin:repo_hook\` and retry.`)
        }
        if (err.isAuth) {
          throw new Error(`gh is not authenticated. Run \`gh auth login\` and retry.`)
        }
      }
      throw err
    }
    const pages = JSON.parse(listOut)
    const hooks = Array.isArray(pages) ? pages.flat() : []
    // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped JSON
    const existingHook = hooks.find((h: any) => h?.config?.url === smeeUrl)

    const payload = JSON.stringify({
      config: { url: smeeUrl, content_type: 'json', secret },
      events: ['workflow_run'],
      active: true,
    })
    if (existingHook) {
      log(`Updating existing webhook (id ${existingHook.id}) on ${repo}...`)
      await ghApi(
        ['api', '--method', 'PATCH', `repos/${repo}/hooks/${existingHook.id}`, '--input', '-'],
        payload,
      )
      log(`Updated webhook ${existingHook.id}`)
    } else {
      log(`Creating new webhook on ${repo}...`)
      await ghApi(
        ['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'],
        payload,
      )
      log('Created webhook')
    }

    // .mcp.json: KEY-PRESENCE check, not truthiness. If `ci: null` or
    // `ci: { custom }` already exists, leave it alone.
    const mcpPath = join(root, '.mcp.json')
    const mcp = existsSync(mcpPath)
      ? JSON.parse(readFileSync(mcpPath, 'utf-8'))
      : {}
    const servers = mcp.mcpServers ?? {}
    if (!('ci' in servers)) {
      mcp.mcpServers = { ...servers, ci: CI_MCP_ENTRY }
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
      log(`Registered 'ci' in ${mcpPath}`)
    } else {
      log(`'ci' already registered in ${mcpPath} — skipping (user customizations preserved)`)
    }

    console.log(
      '\nDone. Launch Claude Code with `claude --dangerously-load-development-channels server:ci`.',
    )
  } catch (err) {
    console.error(`[ci-channel] setup failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
