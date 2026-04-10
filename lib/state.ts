import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { findProjectRoot } from './project-root.js'

export interface PluginState {
  webhookSecret?: string
  smeeUrl?: string
}

const GLOBAL_STATE_PATH = join(homedir(), '.claude', 'channels', 'ci', 'state.json')

/**
 * Resolves the default state path:
 *  1. If a project root is detected (nearest .mcp.json or .git/), use
 *     <project-root>/.claude/channels/ci/state.json
 *  2. Else if the legacy global state file exists, use it (backward compat)
 *  3. Else default to the project-scoped path under cwd
 */
export function getDefaultStatePath(): string {
  const projectRoot = findProjectRoot()
  if (projectRoot) {
    return join(projectRoot, '.claude', 'channels', 'ci', 'state.json')
  }
  if (existsSync(GLOBAL_STATE_PATH)) {
    return GLOBAL_STATE_PATH
  }
  return join(process.cwd(), '.claude', 'channels', 'ci', 'state.json')
}

// Kept for backward compatibility with tests and callers that expect a constant.
export const DEFAULT_STATE_PATH = GLOBAL_STATE_PATH

export function loadState(path?: string): PluginState {
  const statePath = path ?? getDefaultStatePath()
  try {
    const content = readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

export function saveState(state: PluginState, path?: string): void {
  const statePath = path ?? getDefaultStatePath()
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    console.error(`[ci-channel] Warning: could not write state to ${statePath}: ${err}`)
  }
}
