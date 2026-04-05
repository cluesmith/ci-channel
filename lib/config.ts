import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Config {
  webhookSecret: string
  port: number
  smeeUrl: string | null
  githubRepos: string[] | null
  workflowFilter: string[] | null
  reconcileBranches: string[]
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

export const DEFAULT_ENV_PATH = join(homedir(), '.claude', 'channels', 'ci', '.env')

export function loadConfig(envFilePath?: string): Config {
  const envPath = envFilePath ?? DEFAULT_ENV_PATH
  const fileEnv = parseEnvFile(envPath)

  // process.env takes precedence over file
  const get = (key: string): string | undefined => process.env[key] ?? fileEnv[key]

  const webhookSecret = get('WEBHOOK_SECRET')
  if (!webhookSecret) {
    throw new Error(
      'WEBHOOK_SECRET is required. Set it in ~/.claude/channels/ci/.env or as an environment variable.'
    )
  }

  const portStr = get('PORT')
  const port = portStr ? Number(portStr) : 8789
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${portStr}. Must be an integer between 1 and 65535.`)
  }

  const reconcileBranchesStr = get('RECONCILE_BRANCHES')
  const reconcileBranches = reconcileBranchesStr
    ? reconcileBranchesStr.split(',').map(s => s.trim()).filter(Boolean)
    : ['ci', 'develop']

  return {
    webhookSecret,
    port,
    smeeUrl: get('SMEE_URL') ?? null,
    githubRepos: splitCommaList(get('GITHUB_REPOS')),
    workflowFilter: splitCommaList(get('WORKFLOW_FILTER')),
    reconcileBranches,
  }
}
