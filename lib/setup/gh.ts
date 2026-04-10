import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { SetupError } from './errors.js'

/**
 * Minimal shape of a GitHub webhook entry as returned by
 * `gh api repos/{owner}/{repo}/hooks`. We only look at `config.url`
 * for the idempotency check, but the extra fields are included so
 * the type doesn't lie about what's actually on the object.
 */
export interface GhHook {
  id?: number
  config?: {
    url?: string
    content_type?: string
    secret?: string
  }
  events?: string[]
  active?: boolean
}

/** Dependency-injection shim for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

interface GhDeps {
  /** Override the subprocess spawner. Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn
}

/**
 * List the webhooks configured on a GitHub repo.
 *
 * Invokes `gh api --paginate --slurp repos/{repo}/hooks`. The `--slurp`
 * flag (available since gh 2.29, 2023-05) wraps paginated output in a
 * single top-level JSON array, so the parser can just `JSON.parse` the
 * whole stdout.
 *
 * If `--slurp` is rejected by the user's `gh` version (older `gh`), we
 * fall back to `gh api --paginate` and parse the page-by-page output
 * with a newline-tolerant strategy: split on newlines that precede
 * `[` or `{`, parse each chunk as JSON, and flatten.
 */
export async function ghListHooks(
  repo: string,
  deps: GhDeps = {},
): Promise<GhHook[]> {
  const spawner = deps.spawn ?? spawn

  const slurpResult = await runGh(
    spawner,
    ['api', '--paginate', '--slurp', `repos/${repo}/hooks`],
    undefined,
  )

  if (slurpResult.code === 0) {
    return parseSlurpOutput(slurpResult.stdout)
  }

  // Detect "unknown flag --slurp" and fall back. We match on the stderr
  // text because gh's exit code is just "1" for unknown flags.
  if (/unknown flag.*--slurp|unrecognized arguments.*--slurp/i.test(slurpResult.stderr)) {
    const fallback = await runGh(
      spawner,
      ['api', '--paginate', `repos/${repo}/hooks`],
      undefined,
    )
    if (fallback.code !== 0) {
      throw new SetupError(
        `gh api failed (exit ${fallback.code}): ${fallback.stderr.trim()}`,
      )
    }
    return parsePaginateOutput(fallback.stdout)
  }

  throw new SetupError(
    `gh api failed (exit ${slurpResult.code}): ${slurpResult.stderr.trim()}`,
  )
}

/**
 * Create a GitHub webhook on the given repo.
 *
 * Invokes `gh api repos/{repo}/hooks --method POST --input -` and pipes
 * the JSON payload to the child's stdin. Uses a dedicated stdin pipe
 * (NOT `stdin: 'ignore'` and NOT `stdin: 'inherit'`) so the invariant
 * "subprocesses must not inherit `process.stdin`" is preserved while
 * still allowing the `--input -` flag to receive the payload.
 */
export async function ghCreateHook(
  repo: string,
  payload: object,
  deps: GhDeps = {},
): Promise<void> {
  const spawner = deps.spawn ?? spawn
  const body = JSON.stringify(payload)
  const result = await runGh(
    spawner,
    ['api', `repos/${repo}/hooks`, '--method', 'POST', '--input', '-'],
    body,
  )
  if (result.code !== 0) {
    throw new SetupError(
      `gh api failed (exit ${result.code}): ${result.stderr.trim()}`,
    )
  }
}

/**
 * Update an existing GitHub webhook's config in place.
 *
 * Invokes `gh api repos/{repo}/hooks/{hookId} --method PATCH --input -`
 * with the payload piped to stdin. Same stdio invariant as
 * ghCreateHook: dedicated stdin pipe, never inherits process.stdin.
 *
 * Used by the installer when a matching webhook URL already exists
 * but the local secret has been regenerated (e.g., state.json was
 * deleted and re-provisioned). Without this PATCH, the existing
 * webhook would continue signing payloads with a stale secret that
 * the runtime no longer has, and every event would fail HMAC
 * validation — a silent broken install.
 */
export async function ghUpdateHook(
  repo: string,
  hookId: number,
  payload: object,
  deps: GhDeps = {},
): Promise<void> {
  const spawner = deps.spawn ?? spawn
  const body = JSON.stringify(payload)
  const result = await runGh(
    spawner,
    [
      'api',
      `repos/${repo}/hooks/${hookId}`,
      '--method',
      'PATCH',
      '--input',
      '-',
    ],
    body,
  )
  if (result.code !== 0) {
    throw new SetupError(
      `gh api failed (exit ${result.code}): ${result.stderr.trim()}`,
    )
  }
}

interface GhResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Spawn `gh` and collect stdout/stderr. If `input` is provided, it's
 * written to the child's stdin and the stream is ended. If `input` is
 * undefined, stdin is ignored (no bytes are written or inherited).
 *
 * Both paths satisfy the invariant: the child never inherits the
 * parent's `process.stdin`.
 */
function runGh(
  spawner: SpawnFn,
  args: readonly string[],
  input: string | undefined,
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const stdio: SpawnOptions['stdio'] =
      input === undefined
        ? ['ignore', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe']

    const child = spawner('gh', args, { stdio })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new SetupError(
            'gh CLI not found. Install from https://cli.github.com/ and run `gh auth login`.',
          ),
        )
      } else {
        reject(err)
      }
    })

    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })

    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

/**
 * Parse output from `gh api --paginate --slurp`. Expected format is a
 * single top-level JSON array whose elements are the pages (each an
 * array of hook objects). We flatten to a single flat list.
 */
function parseSlurpOutput(stdout: string): GhHook[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) {
    throw new SetupError(
      `Unexpected gh --slurp output: expected array, got ${typeof parsed}`,
    )
  }
  // Slurp nests pages inside the outer array, so each element may be
  // an array of hooks OR (if gh flattens differently) a hook object.
  const result: GhHook[] = []
  for (const item of parsed) {
    if (Array.isArray(item)) {
      for (const hook of item) result.push(hook as GhHook)
    } else {
      result.push(item as GhHook)
    }
  }
  return result
}

/**
 * Fallback parser for `gh api --paginate` (without --slurp). Output
 * format varies: pages may be concatenated with newlines, or joined
 * directly. We split on newlines that precede `[` or `{` and parse
 * each chunk independently.
 */
function parsePaginateOutput(stdout: string): GhHook[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const chunks = trimmed.split(/\n(?=[\[\{])/)
  const result: GhHook[] = []
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    const parsed = JSON.parse(chunk)
    if (Array.isArray(parsed)) {
      for (const hook of parsed) result.push(hook as GhHook)
    } else {
      result.push(parsed as GhHook)
    }
  }
  return result
}
