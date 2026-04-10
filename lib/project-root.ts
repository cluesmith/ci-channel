import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walks up from the given directory (defaults to process.cwd()) looking for
 * a project-root marker. Returns the first directory containing one of:
 *   - .mcp.json  (Claude Code project)
 *   - .git/      (git repository)
 *
 * Returns null if no marker is found before reaching the filesystem root.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir)
  const markers = ['.mcp.json', '.git']

  while (true) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) {
        return current
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      // Reached filesystem root
      return null
    }
    current = parent
  }
}
