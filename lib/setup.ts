import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchSmeeChannel } from './bootstrap.js'
import { findProjectRoot } from './project-root.js'
import { loadState } from './state.js'

const CODEV_FLAG = '--dangerously-load-development-channels server:ci'
const VALID_FORGES = ['github', 'gitlab', 'gitea'] as const
type Forge = (typeof VALID_FORGES)[number]

const log = (msg: string) => console.error(`[ci-channel] ${msg}`)

function parseArgs(argv: string[]): { repo: string; forge: Forge; giteaUrl?: string } {
  let repo: string | undefined
  let forge: Forge = 'github'
  let giteaUrl: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo' && i + 1 < argv.length) { repo = argv[++i]; continue }
    if (a === '--forge' && i + 1 < argv.length) {
      const v = argv[++i]
      if (!VALID_FORGES.includes(v as Forge)) {
        throw new Error(`Invalid --forge '${v}'. Must be one of: github, gitlab, gitea (lowercase).`)
      }
      forge = v as Forge
      continue
    }
    if (a === '--gitea-url' && i + 1 < argv.length) { giteaUrl = argv[++i]; continue }
    throw new Error(`Usage: ci-channel setup --repo owner/repo [--forge github|gitlab|gitea] [--gitea-url URL] (unexpected arg: ${a})`)
  }
  if (!repo) throw new Error('Usage: ci-channel setup --repo owner/repo [--forge github|gitlab|gitea] [--gitea-url URL]')
  if (forge === 'gitea' && !giteaUrl) throw new Error('--gitea-url is required when --forge gitea')
  if (forge !== 'gitea' && giteaUrl) throw new Error('--gitea-url is only valid with --forge gitea')
  if (giteaUrl && !/^https?:\/\//i.test(giteaUrl)) throw new Error(`--gitea-url must start with http:// or https:// (got '${giteaUrl}')`)
  return { repo, forge, giteaUrl }
}

function readEnvToken(envPath: string, key: string): string | undefined {
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const raw of content.split('\n')) {
      const line = raw.trim().replace(/^export\s+/, '')
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      if (line.slice(0, eq).trim() !== key) continue
      let v = line.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v
    }
  } catch { /* missing or unreadable file → undefined */ }
  return undefined
}

function cliApi(bin: 'gh' | 'glab', args: string[], stdinBody: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => {
      Object.assign(err, { bin, args, stderr: '' })
      reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout)
      const e = new Error(`${bin} ${args.join(' ')} exited ${code}: ${stderr.trim()}`) as Error & { bin: string; code: number | null; stderr: string; args: string[] }
      e.bin = bin; e.code = code; e.stderr = stderr; e.args = args
      reject(e)
    })
    child.stdin.end(stdinBody ?? '')
  })
}

// biome-ignore lint/suspicious/noExplicitAny: err is opaque until classified
function classifyForgeError(bin: 'gh' | 'glab', err: any, repo: string): Error {
  if (err?.code === 'ENOENT') {
    return bin === 'gh'
      ? new Error('gh CLI not found. Install from https://cli.github.com/ and run `gh auth login`.')
      : new Error('glab CLI not found. Install from https://gitlab.com/gitlab-org/cli and run `glab auth login`.')
  }
  const stderr = String(err?.stderr ?? '')
  if (/HTTP 404|Not Found/i.test(stderr)) {
    return bin === 'gh'
      ? new Error(`Could not find repo '${repo}'. Check the spelling, or verify you have access (gh returned 404).`)
      : new Error(`Could not find project '${repo}'. Check the spelling, or verify you have access (glab returned 404).`)
  }
  if (/HTTP 403|Forbidden/i.test(stderr)) {
    return bin === 'gh'
      ? new Error(`Access denied to '${repo}' webhooks. Your gh token likely needs the 'admin:repo_hook' scope. Run \`gh auth refresh -s admin:repo_hook\` and retry.`)
      : new Error(`Access denied to '${repo}' hooks. Your glab token needs project maintainer/owner permission and the 'api' scope. Run \`glab auth login\` and retry.`)
  }
  if (/HTTP 401|Unauthorized|not logged in|authentication/i.test(stderr)) {
    return new Error(`${bin} is not authenticated. Run \`${bin} auth login\` and retry.`)
  }
  return err instanceof Error ? err : new Error(`${bin} ${(err?.args ?? []).join(' ')} exited ${err?.code ?? '?'}: ${stderr.trim()}`)
}

async function giteaFetch(url: string, init: RequestInit, repo: string, base: string): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10000)
  let resp: Response
  try { resp = await fetch(url, { ...init, signal: ac.signal }) }
  finally { clearTimeout(timer) }
  if (resp.ok) return resp
  const body = await resp.text().catch(() => '')
  if (resp.status === 404) throw new Error(`Could not find Gitea repo '${repo}' at ${base}. Check the URL and repo path.`)
  if (resp.status === 403) throw new Error(`Access denied to '${repo}' hooks on ${base}. Your GITEA_TOKEN needs write:repository scope.`)
  if (resp.status === 401) throw new Error(`GITEA_TOKEN is invalid or expired. Generate a new one at ${base}/user/settings/applications.`)
  throw new Error(`Gitea API error (status ${resp.status}): ${body}`)
}

function codevIntegrate(root: string): void {
  const codevPath = join(root, '.codev', 'config.json')
  if (!existsSync(codevPath)) return
  try {
    // biome-ignore lint/suspicious/noExplicitAny: user-owned JSON
    const config: any = JSON.parse(readFileSync(codevPath, 'utf-8'))
    const architect = config?.shell?.architect
    if (typeof architect !== 'string' || architect.length === 0) {
      log(`.codev/config.json has no shell.architect — skipping (unexpected Codev shape)`)
      return
    }
    if (architect.includes(CODEV_FLAG)) {
      log(`.codev/config.json already loads ci channel — skipping`)
      return
    }
    config.shell.architect = `${architect} ${CODEV_FLAG}`
    writeFileSync(codevPath, JSON.stringify(config, null, 2) + '\n')
    log(`Updated .codev/config.json: architect session will now load ci channel`)
  } catch (err) {
    log(`warning: Codev integration failed: ${(err as Error).message}. Webhook install succeeded; edit .codev/config.json manually to add ${CODEV_FLAG} to shell.architect.`)
  }
}

export async function setup(argv: string[]): Promise<void> {
  try {
    const { repo, forge, giteaUrl } = parseArgs(argv)
    const root = findProjectRoot()
    if (!root) {
      throw new Error('No project root found (no .git/ or .mcp.json in any ancestor). Run this from inside the project you want to install into.')
    }
    log(`Project root: ${root}`)
    log(`Target repo:  ${repo}`)
    log(`Forge:        ${forge}`)

    // Step 3: forge-specific input validation (Gitea token check BEFORE state provisioning)
    let giteaToken: string | undefined
    if (forge === 'gitea') {
      const envPath = join(root, '.claude', 'channels', 'ci', '.env')
      giteaToken = (process.env.GITEA_TOKEN ?? '').trim() || (readEnvToken(envPath, 'GITEA_TOKEN') ?? '').trim() || undefined
      if (!giteaToken) {
        throw new Error(`GITEA_TOKEN not set. Generate a token at ${giteaUrl}/user/settings/applications (scopes: write:repository) and add it to ${envPath} as GITEA_TOKEN=... or export GITEA_TOKEN in your shell.`)
      }
    }

    const statePath = join(root, '.claude', 'channels', 'ci', 'state.json')
    const existing = loadState(statePath)

    let secret = existing.webhookSecret
    if (secret) log('Reusing existing webhook secret from state.json')
    else { secret = randomBytes(32).toString('hex'); log('Generated new webhook secret') }

    let smeeUrl = existing.smeeUrl
    if (smeeUrl) log(`Reusing existing smee channel: ${smeeUrl}`)
    else {
      log('Provisioning smee.io channel...')
      const fetched = await fetchSmeeChannel()
      if (!fetched) throw new Error('Failed to provision smee.io channel (smee.io unreachable or returned no Location header)')
      smeeUrl = fetched
      log(`Provisioned smee channel: ${smeeUrl}`)
    }

    // Conditional state write (correctness check, not optimization); state-first ordering
    const unchanged = existing.webhookSecret === secret && existing.smeeUrl === smeeUrl && Object.keys(existing).length === 2
    if (!unchanged) {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify({ webhookSecret: secret, smeeUrl }, null, 2) + '\n', { mode: 0o600 })
      log(`Wrote ${statePath} (mode 0o600)`)
    } else {
      log(`state.json already matches desired state — skipping write`)
    }

    // Forge-specific webhook install
    if (forge === 'github') {
      log(`Listing existing webhooks on ${repo}...`)
      const payload = JSON.stringify({ config: { url: smeeUrl, content_type: 'json', secret }, events: ['workflow_run'], active: true })
      try {
        const listOut = await cliApi('gh', ['api', '--paginate', '--slurp', `repos/${repo}/hooks`], null)
        const pages = JSON.parse(listOut)
        const hooks = Array.isArray(pages) ? pages.flat() : []
        // biome-ignore lint/suspicious/noExplicitAny: untyped webhook JSON
        const existingHook = hooks.find((h: any) => h?.config?.url === smeeUrl)
        if (existingHook) {
          log(`Updating existing webhook (id ${existingHook.id}) on ${repo}...`)
          await cliApi('gh', ['api', '--method', 'PATCH', `repos/${repo}/hooks/${existingHook.id}`, '--input', '-'], payload)
          log(`Updated webhook ${existingHook.id}`)
        } else {
          log(`Creating new webhook on ${repo}...`)
          await cliApi('gh', ['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'], payload)
          log('Created webhook')
        }
      } catch (err) {
        throw classifyForgeError('gh', err, repo)
      }
    } else if (forge === 'gitlab') {
      const encoded = encodeURIComponent(repo)
      log(`Listing existing hooks on project ${repo} (encoded as ${encoded})...`)
      const payload = JSON.stringify({
        url: smeeUrl, token: secret,
        pipeline_events: true,
        push_events: false, merge_requests_events: false, tag_push_events: false,
        issues_events: false, confidential_issues_events: false,
        note_events: false, confidential_note_events: false,
        job_events: false, wiki_page_events: false,
        deployment_events: false, releases_events: false,
        enable_ssl_verification: true,
      })
      try {
        const listOut = await cliApi('glab', ['api', `projects/${encoded}/hooks`], null)
        const hooks = JSON.parse(listOut)
        // biome-ignore lint/suspicious/noExplicitAny: untyped hook JSON
        const existingHook = Array.isArray(hooks) ? hooks.find((h: any) => h?.url === smeeUrl) : null
        if (existingHook) {
          log(`Updating existing hook (id ${existingHook.id}) on ${repo}...`)
          await cliApi('glab', ['api', '--method', 'PUT', `projects/${encoded}/hooks/${existingHook.id}`, '--input', '-'], payload)
          log(`Updated hook ${existingHook.id}`)
        } else {
          log(`Creating new hook on ${repo}...`)
          await cliApi('glab', ['api', '--method', 'POST', `projects/${encoded}/hooks`, '--input', '-'], payload)
          log('Created hook')
        }
      } catch (err) {
        throw classifyForgeError('glab', err, repo)
      }
    } else {
      // gitea — giteaUrl and giteaToken are guaranteed defined at this point
      const base = giteaUrl!.replace(/\/$/, '')
      const url = `${base}/api/v1/repos/${repo}/hooks`
      const authHdrs = { Authorization: `token ${giteaToken!}` }
      const jsonHdrs = { ...authHdrs, 'Content-Type': 'application/json' }
      log(`Listing existing hooks at ${url}...`)
      const listResp = await giteaFetch(url, { headers: authHdrs }, repo, base)
      // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
      const hooks = (await listResp.json()) as any[]
      // biome-ignore lint/suspicious/noExplicitAny: untyped JSON
      const existingHook = Array.isArray(hooks) ? hooks.find((h: any) => h?.config?.url === smeeUrl) : null
      const cfg = { url: smeeUrl, content_type: 'json', secret }
      if (existingHook) {
        log(`Updating existing hook (id ${existingHook.id}) on ${repo}...`)
        await giteaFetch(`${url}/${existingHook.id}`, {
          method: 'PATCH',
          headers: jsonHdrs,
          body: JSON.stringify({ config: cfg, events: ['workflow_run'], active: true }),
        }, repo, base)
        log(`Updated hook ${existingHook.id}`)
      } else {
        log(`Creating new hook on ${repo}...`)
        await giteaFetch(url, {
          method: 'POST',
          headers: jsonHdrs,
          body: JSON.stringify({ type: 'gitea', config: cfg, events: ['workflow_run'], active: true }),
        }, repo, base)
        log('Created hook')
      }
    }

    // .mcp.json key-presence merge (not truthiness); preserves user customizations.
    // The ci entry is forge-specific so the runtime launches with the right forge:
    //   github  → no extra args (default)
    //   gitlab  → --forge gitlab
    //   gitea   → --forge gitea --gitea-url <base>
    const mcpPath = join(root, '.mcp.json')
    const mcp = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf-8')) : {}
    const servers = mcp.mcpServers ?? {}
    if (!('ci' in servers)) {
      const ciArgs: string[] = ['-y', 'ci-channel']
      if (forge !== 'github') ciArgs.push('--forge', forge)
      if (forge === 'gitea') ciArgs.push('--gitea-url', giteaUrl!.replace(/\/$/, ''))
      mcp.mcpServers = { ...servers, ci: { command: 'npx', args: ciArgs } }
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
      log(`Registered 'ci' in ${mcpPath}`)
    } else {
      log(`'ci' already registered in ${mcpPath} — skipping (user customizations preserved)`)
    }

    // Codev integration — wraps its own try/catch (logs warning, continues on failure)
    codevIntegrate(root)

    console.log(
      '\nDone. Launch Claude Code with `claude --dangerously-load-development-channels server:ci`.',
    )
  } catch (err) {
    console.error(`[ci-channel] setup failed: ${(err as Error).message}`)
    process.exit(1)
  }
}
