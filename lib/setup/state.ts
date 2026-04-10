import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadState, type PluginState } from '../state.js'
import { SetupError } from './errors.js'

/**
 * Project-local state file path: `<project-root>/.claude/channels/ci/state.json`.
 * The installer always writes to this path; the runtime plugin's legacy fallback
 * to `~/.claude/channels/ci/state.json` is never read or written here.
 */
export function stateFilePath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'channels', 'ci', 'state.json')
}

/**
 * Reads state.json using the runtime `loadState` helper (which returns `{}`
 * on missing file or parse errors — the behavior the installer wants).
 */
export function readStateForSetup(projectRoot: string): PluginState {
  return loadState(stateFilePath(projectRoot))
}

/**
 * Writes state.json with `mode: 0o600` (owner read/write only).
 *
 * Intentionally does NOT reuse `saveState` from `lib/state.ts` because
 * that helper swallows write errors with a log warning. For the installer
 * we need errors to propagate so a failed write isn't silently followed
 * by a webhook-create that leaves the user with inconsistent state.
 *
 * Note on permissions: `writeFileSync({ mode: 0o600 })` only applies the
 * mode when the file is *created*. If the file already exists (e.g.,
 * from a previous run or from an overriding `--smee-url`), the existing
 * mode bits are preserved. That's not safe for a file containing a
 * secret, so we follow the write with an explicit `chmodSync(path, 0o600)`
 * to guarantee the mode regardless of whether the file pre-existed.
 *
 * This introduces a brief TOCTOU window on first-write only (the file
 * is briefly at the default umask mode before chmod runs), but the
 * window is bounded by a single `chmodSync` and is unavoidable without
 * creating-then-renaming. Acceptable for an install-time tool.
 */
export function writeStateForSetup(projectRoot: string, state: PluginState): void {
  const path = stateFilePath(projectRoot)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      flag: 'w',
    })
    // Enforce 0o600 even if the file pre-existed — writeFileSync only
    // applies mode on create. Skipped on Windows where POSIX perms
    // don't apply.
    if (process.platform !== 'win32') {
      chmodSync(path, 0o600)
    }
  } catch (err) {
    throw new SetupError(
      `Failed to write state file at ${path}: ${(err as Error).message}`,
    )
  }
}

/**
 * Returns true if a legacy global state file at
 * `~/.claude/channels/ci/state.json` exists. Used to emit an
 * informational note; the file is never read by the installer.
 */
export function legacyGlobalStateExists(): boolean {
  return existsSync(join(homedir(), '.claude', 'channels', 'ci', 'state.json'))
}
