/**
 * Regression test for the `.env` path resolution rule:
 *
 * When a project root is detected (via .git/ or .mcp.json), the runtime
 * MUST resolve `.env` to the project-local path, never falling back to
 * the legacy global `~/.claude/channels/ci/.env`. Otherwise, a stale
 * global `WEBHOOK_SECRET` or `SMEE_URL` could silently override
 * project-local state written by `ci-channel setup`, breaking new
 * installs on machines with legacy config.
 *
 * We exercise the real `getDefaultEnvPath()` by temporarily `chdir`-ing
 * into a temp directory that contains a `.git/` marker, calling the
 * function, and asserting the returned path is rooted at the temp
 * directory (not at $HOME/.claude/channels/ci/).
 */
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { getDefaultEnvPath } from '../lib/config.js'

let tmpProject: string
let savedCwd: string

describe('getDefaultEnvPath — project-root takes precedence over legacy global', () => {
  beforeEach(() => {
    savedCwd = process.cwd()
    tmpProject = realpathSync(
      mkdtempSync(join(tmpdir(), 'ci-channel-envpath-')),
    )
    mkdirSync(join(tmpProject, '.git'), { recursive: true })
    process.chdir(tmpProject)
  })

  afterEach(() => {
    process.chdir(savedCwd)
    try {
      rmSync(tmpProject, { recursive: true })
    } catch {}
  })

  test('project root detected → returns project-local .env path', () => {
    const resolved = getDefaultEnvPath()
    const expected = join(tmpProject, '.claude', 'channels', 'ci', '.env')
    assert.equal(resolved, expected)
  })

  test('project root detected → does NOT return a path under $HOME/.claude/', () => {
    const resolved = getDefaultEnvPath()
    const legacyGlobalDir = join(homedir(), '.claude', 'channels', 'ci')
    assert.ok(
      !resolved.startsWith(legacyGlobalDir + sep) && resolved !== legacyGlobalDir,
      `expected project-local path, got a global-looking path: ${resolved}`,
    )
  })

  test('project root detected → returned path is under the temp project root', () => {
    const resolved = getDefaultEnvPath()
    assert.ok(
      resolved.startsWith(tmpProject + sep),
      `expected path under ${tmpProject}, got: ${resolved}`,
    )
  })
})
