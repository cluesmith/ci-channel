import { findProjectRoot } from '../project-root.js'
import { SetupError } from './errors.js'

/**
 * Walks upward from `cwd` looking for a project root marker
 * (`.mcp.json` or `.git/`). Throws SetupError if none is found —
 * the installer requires a project root.
 *
 * `cwd` is injectable for tests; defaults to `process.cwd()`.
 */
export function detectProjectRoot(cwd: string = process.cwd()): string {
  const root = findProjectRoot(cwd)
  if (!root) {
    throw new SetupError(
      `Could not locate project root (no .mcp.json or .git/ found walking up from ${cwd}). Run this from inside the project you want to install into.`,
    )
  }
  return root
}
