import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchSmeeChannel } from './bootstrap.js'
import { findProjectRoot } from './project-root.js'
import { loadState } from './state.js'

const CI_MCP_ENTRY = { command: 'npx', args: ['-y', 'ci-channel'] }

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
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`gh ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
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
      throw new Error('No project root found (no .git/ or .mcp.json in any ancestor)')
    }
    const statePath = join(root, '.claude', 'channels', 'ci', 'state.json')
    const existing = loadState(statePath)
    const secret = existing.webhookSecret ?? randomBytes(32).toString('hex')
    let smeeUrl = existing.smeeUrl
    if (!smeeUrl) {
      const fetched = await fetchSmeeChannel()
      if (!fetched) {
        throw new Error('Failed to provision smee.io channel')
      }
      smeeUrl = fetched
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
    }

    const listOut = await ghApi(
      ['api', '--paginate', '--slurp', `repos/${repo}/hooks`],
      null,
    )
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
      await ghApi(
        ['api', '--method', 'PATCH', `repos/${repo}/hooks/${existingHook.id}`, '--input', '-'],
        payload,
      )
    } else {
      await ghApi(
        ['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'],
        payload,
      )
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
    }

    console.log(
      'Done. Launch Claude Code with `claude --dangerously-load-development-channels server:ci`.',
    )
  } catch (err) {
    console.error(`[ci-channel] setup failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
