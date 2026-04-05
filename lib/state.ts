import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export interface PluginState {
  webhookSecret?: string
  smeeUrl?: string
}

export const DEFAULT_STATE_PATH = join(homedir(), '.claude', 'channels', 'ci', 'state.json')

export function loadState(path?: string): PluginState {
  const statePath = path ?? DEFAULT_STATE_PATH
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
  const statePath = path ?? DEFAULT_STATE_PATH
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
  } catch (err) {
    console.error(`[ci-channel] Warning: could not write state to ${statePath}: ${err}`)
  }
}
