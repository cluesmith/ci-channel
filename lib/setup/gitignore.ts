import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Returns true if `relPath` (e.g., `.claude/channels/ci/`) appears to be
 * gitignored by any ancestor `.gitignore` from `projectRoot` up to the
 * filesystem root.
 *
 * This is NOT full gitignore pattern matching — we only check whether
 * each `.gitignore` contains a non-comment line that, after trimming
 * leading `/` and trailing `/`, is either equal to or a prefix of
 * `relPath` (normalized the same way). That's enough to drive a
 * "state.json contains a secret, consider gitignoring it" warning
 * without pulling in a gitignore-parsing dependency.
 *
 * We walk upward (from `projectRoot` to `/`) because a user may have a
 * `.gitignore` in a parent directory (e.g., a monorepo root) that
 * already excludes `.claude/`.
 */
export function isGitignored(projectRoot: string, relPath: string): boolean {
  const normalized = normalizePath(relPath)
  if (!normalized) return false

  let current = resolve(projectRoot)
  while (true) {
    const gi = join(current, '.gitignore')
    if (existsSync(gi)) {
      try {
        const content = readFileSync(gi, 'utf-8')
        if (gitignoreMentions(content, normalized)) return true
      } catch {
        // Unreadable .gitignore — skip it and continue upward.
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * Strip leading/trailing slashes and collapse `./` prefix so we can
 * do simple prefix matches. `.claude/channels/ci/` → `.claude/channels/ci`.
 */
function normalizePath(p: string): string {
  let n = p.trim()
  if (n.startsWith('./')) n = n.slice(2)
  if (n.startsWith('/')) n = n.slice(1)
  if (n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/**
 * Returns true if any non-comment line in `content` (gitignore syntax)
 * is equal to `normalized` or matches it as an ancestor prefix
 * (e.g., `.claude/` matches `.claude/channels/ci`).
 */
function gitignoreMentions(content: string, normalized: string): boolean {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // Ignore negation patterns — we only care about "is it mentioned".
    if (line.startsWith('!')) continue
    const pattern = normalizePath(line)
    if (!pattern) continue
    if (pattern === normalized) return true
    if (normalized.startsWith(pattern + '/')) return true
  }
  return false
}
