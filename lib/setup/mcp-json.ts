import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SetupError } from './errors.js'

/**
 * The `ci` entry that the installer registers in `.mcp.json`.
 * Matches the form recommended in INSTALL.md.
 */
export const CI_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'ci-channel'],
} as const

/** Discriminated union returned by {@link readMcpJson}. */
export type McpJsonReadResult =
  | { exists: false }
  | { exists: true; content: unknown; indent: number }

/** Loose shape of an `.mcp.json` object. */
export type McpJson = { [key: string]: unknown; mcpServers?: unknown }

/**
 * Read `.mcp.json` from disk.
 *
 * - Missing file → `{ exists: false }` (valid; installer will create one).
 * - Present + valid JSON → `{ exists: true, content, indent }`.
 * - Present + invalid JSON → throws SetupError.
 *
 * Shape validation (top-level not an object, `mcpServers` not an object)
 * happens in {@link mergeCiServer}, not here — this function's job is I/O
 * and JSON parsing only.
 */
export function readMcpJson(path: string): McpJsonReadResult {
  if (!existsSync(path)) return { exists: false }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    throw new SetupError(`Failed to read ${path}: ${(err as Error).message}`)
  }

  let content: unknown
  try {
    content = JSON.parse(raw)
  } catch (err) {
    throw new SetupError(
      `${path} is not valid JSON: ${(err as Error).message}. Fix the file and re-run setup.`,
    )
  }

  return { exists: true, content, indent: detectIndent(raw) }
}

/**
 * Merge the `ci` server entry into a parsed `.mcp.json` content tree.
 *
 * Handles all 7 shapes from the spec:
 *   1. File does not exist → creates `{ mcpServers: { ci: ... } }`
 *   2. Has `mcpServers.ci` already → skip, return unchanged
 *   3. Has `mcpServers` with other entries → merge in `ci` alongside them
 *   4. Has no `mcpServers` key → add `mcpServers: { ci: ... }`
 *   5. `mcpServers` is not an object → throws SetupError
 *   6. Top-level is not an object → throws SetupError
 *   7. Invalid JSON → handled in readMcpJson, doesn't reach here
 */
export function mergeCiServer(
  raw: McpJsonReadResult,
): { updated: McpJson; action: 'created' | 'merged' | 'skipped_exists' } {
  if (!raw.exists) {
    return {
      updated: { mcpServers: { ci: { ...CI_SERVER_ENTRY } } },
      action: 'created',
    }
  }

  const mcp = raw.content
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) {
    throw new SetupError(
      '.mcp.json top-level is not an object (expected `{}`). Fix the file and re-run setup.',
    )
  }

  const mcpObj = mcp as Record<string, unknown>
  const servers = mcpObj.mcpServers

  if (servers === undefined) {
    return {
      updated: { ...mcpObj, mcpServers: { ci: { ...CI_SERVER_ENTRY } } },
      action: 'merged',
    }
  }

  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new SetupError(
      '.mcp.json has invalid `mcpServers` (expected object). Fix the file and re-run setup.',
    )
  }

  const serversObj = servers as Record<string, unknown>
  if ('ci' in serversObj) {
    return { updated: mcpObj as McpJson, action: 'skipped_exists' }
  }

  return {
    updated: {
      ...mcpObj,
      mcpServers: { ...serversObj, ci: { ...CI_SERVER_ENTRY } },
    },
    action: 'merged',
  }
}

/**
 * Write an `.mcp.json` tree to disk with the given indentation.
 * Errors are re-thrown as `SetupError` so callers can surface a
 * clean message instead of a raw stack.
 */
export function writeMcpJson(path: string, mcp: McpJson, indent: number): void {
  try {
    writeFileSync(path, JSON.stringify(mcp, null, indent) + '\n')
  } catch (err) {
    throw new SetupError(`Failed to write ${path}: ${(err as Error).message}`)
  }
}

/**
 * Detect the indentation size (in spaces) from the first indented
 * line of a JSON blob. Defaults to 2 if nothing is found. Tab indents
 * also resolve to 2 (we normalize to spaces on write).
 */
export function detectIndent(raw: string): number {
  for (const line of raw.split('\n')) {
    const match = line.match(/^( +)\S/)
    if (match) return match[1].length
  }
  return 2
}
