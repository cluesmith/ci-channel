import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadState } from './state.js'
import { findProjectRoot } from './project-root.js'

export const VALID_FORGES = ['github', 'gitlab', 'gitea'] as const
export type ForgeName = (typeof VALID_FORGES)[number]

export interface Config {
  forge: ForgeName
  webhookSecret: string | null
  port: number
  smeeUrl: string | null
  repos: string[] | null
  workflowFilter: string[] | null
  reconcileBranches: string[]
  giteaUrl: string | null
  giteaToken: string | null
}

function parseEnvFile(path: string): Record<string, string> {
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }

  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function splitCommaList(value: string | undefined): string[] | null {
  if (!value) return null
  const items = value.split(',').map(s => s.trim()).filter(Boolean)
  return items.length > 0 ? items : null
}

const GLOBAL_ENV_PATH = join(homedir(), '.claude', 'channels', 'ci', '.env')

/**
 * Resolves the default .env path:
 *  1. If a project root is detected (nearest .mcp.json or .git/), use
 *     <project-root>/.claude/channels/ci/.env
 *  2. Else if the legacy global .env exists, use it (backward compat)
 *  3. Else default to the project-scoped path under cwd
 */
export function getDefaultEnvPath(): string {
  const projectRoot = findProjectRoot()
  if (projectRoot) {
    const projectEnv = join(projectRoot, '.claude', 'channels', 'ci', '.env')
    // Prefer project-local; fall back to global only if project-local doesn't exist
    if (existsSync(projectEnv)) return projectEnv
    if (existsSync(GLOBAL_ENV_PATH)) return GLOBAL_ENV_PATH
    return projectEnv
  }
  if (existsSync(GLOBAL_ENV_PATH)) return GLOBAL_ENV_PATH
  return join(process.cwd(), '.claude', 'channels', 'ci', '.env')
}

// Kept for backward compatibility with tests and callers that expect a constant.
export const DEFAULT_ENV_PATH = GLOBAL_ENV_PATH

/**
 * Parse CLI args from argv (process.argv.slice(2)).
 * Supports --flag value pairs. Unknown flags throw.
 */
function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  const knownFlags = new Set([
    '--forge', '--repos', '--port', '--workflow-filter',
    '--reconcile-branches', '--gitea-url', '--smee-url',
  ])

  let i = 0
  while (i < argv.length) {
    const flag = argv[i]
    if (!flag.startsWith('--')) {
      throw new Error(`Unexpected argument: ${flag}. All arguments must be --flag value pairs.`)
    }
    if (!knownFlags.has(flag)) {
      throw new Error(`Unknown flag: ${flag}. Valid flags: ${[...knownFlags].join(', ')}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for flag: ${flag}`)
    }
    args[flag] = value
    i += 2
  }

  return args
}

export function loadConfig(envFilePath?: string, argv?: string[], statePath?: string): Config {
  const envPath = envFilePath ?? getDefaultEnvPath()
  const fileEnv = parseEnvFile(envPath)
  const cliArgs = parseCliArgs(argv ?? process.argv.slice(2))

  // Load persisted state (auto-provisioned values) as lowest priority
  const state = loadState(statePath)

  // Precedence: CLI args > env vars > .env file > state.json
  const get = (key: string, cliFlag?: string, stateKey?: string): string | undefined => {
    if (cliFlag && cliArgs[cliFlag] !== undefined) return cliArgs[cliFlag]
    const envVal = process.env[key] ?? fileEnv[key]
    if (envVal !== undefined) return envVal
    if (stateKey && state[stateKey as keyof typeof state]) return state[stateKey as keyof typeof state]
    return undefined
  }

  // Forge selection
  const forgeStr = get('FORGE', '--forge') ?? 'github'
  if (!VALID_FORGES.includes(forgeStr as ForgeName)) {
    throw new Error(
      `Invalid FORGE value: "${forgeStr}". Must be one of: ${VALID_FORGES.join(', ')}`
    )
  }
  const forge = forgeStr as ForgeName

  // Webhook secret — null means auto-generate in bootstrap
  const webhookSecret = get('WEBHOOK_SECRET', undefined, 'webhookSecret') ?? null

  // Port — default 0 (OS-assigned)
  const portStr = get('PORT', '--port')
  const port = portStr ? Number(portStr) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${portStr}. Must be an integer between 0 and 65535.`)
  }

  // Repos — CLI --repos > REPOS env > GITHUB_REPOS env (backward compat)
  const reposFromCli = cliArgs['--repos']
  const reposStr = reposFromCli ?? process.env.REPOS ?? fileEnv.REPOS ?? process.env.GITHUB_REPOS ?? fileEnv.GITHUB_REPOS
  const repos = splitCommaList(reposStr)

  // Smee URL — CLI > env > .env > state.json
  const smeeUrl = get('SMEE_URL', '--smee-url', 'smeeUrl') ?? null

  const reconcileBranchesStr = get('RECONCILE_BRANCHES', '--reconcile-branches')
  const reconcileBranches = reconcileBranchesStr
    ? reconcileBranchesStr.split(',').map(s => s.trim()).filter(Boolean)
    : ['ci', 'develop']

  return {
    forge,
    webhookSecret,
    port,
    smeeUrl,
    repos,
    workflowFilter: splitCommaList(get('WORKFLOW_FILTER', '--workflow-filter')),
    reconcileBranches,
    giteaUrl: get('GITEA_URL', '--gitea-url') ?? null,
    giteaToken: get('GITEA_TOKEN') ?? null,
  }
}
