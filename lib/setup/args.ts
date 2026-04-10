import { SetupError } from './errors.js'
import type { ParseSetupArgsResult, SetupArgs } from './types.js'

/**
 * Repo validation regex (from spec Security section): owner/repo with the
 * character set GitHub allows for both the org/user and the repo name.
 */
const REPO_REGEX = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** Known boolean flags (no value consumed). */
const BOOLEAN_FLAGS = new Set(['--yes', '-y', '--dry-run', '--help', '-h'])

/** Known value flags (consume the next argv token). */
const VALUE_FLAGS = new Set(['--repo', '--forge', '--smee-url'])

interface ParseOptions {
  /**
   * Reports whether stdin is a TTY. Injected so tests can drive the
   * interactive/non-interactive matrix without touching real process state.
   */
  isTty?: () => boolean
}

/**
 * Parse the arguments passed after `ci-channel setup`.
 *
 * Implements the interactive/non-interactive matrix from the spec:
 *
 *   TTY?  --yes?  --repo missing → behavior
 *   yes   no      yes             → return args with repo=null; runner prompts
 *   yes   yes     yes             → SetupError (--yes requires --repo)
 *   no    no      yes             → SetupError (stdin is not a TTY; pass --yes)
 *   no    yes     yes             → SetupError (--yes requires --repo)
 *
 * `--forge` other than `github` is rejected with a message that clarifies
 * the installer is GitHub-only in v1 while the MCP server itself still
 * supports all three forges.
 *
 * Repeated flags (e.g. `--repo a/b --repo c/d`) throw SetupError. This
 * matches the style of parseCliArgs in lib/config.ts (fail fast on
 * unexpected input).
 */
export function parseSetupArgs(
  argv: string[],
  opts: ParseOptions = {},
): ParseSetupArgsResult {
  const isTty = opts.isTty ?? (() => process.stdin.isTTY === true)

  // First pass: tokenize. Track which flags we've already seen so repeated
  // flags throw.
  const seen = new Set<string>()
  const values: Record<string, string> = {}
  const bools: Record<string, boolean> = {}

  let i = 0
  while (i < argv.length) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      throw new SetupError(
        `Unexpected positional argument: ${token}. All arguments must be --flag or --flag value pairs.`,
      )
    }

    // Normalize -y → --yes and -h → --help for dedup tracking.
    const canonical =
      token === '-y' ? '--yes' : token === '-h' ? '--help' : token

    if (seen.has(canonical)) {
      throw new SetupError(`Duplicate flag: ${canonical}`)
    }
    seen.add(canonical)

    if (BOOLEAN_FLAGS.has(token)) {
      bools[canonical] = true
      i += 1
      continue
    }

    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new SetupError(`Missing value for flag: ${token}`)
      }
      values[token] = value
      i += 2
      continue
    }

    throw new SetupError(
      `Unknown flag: ${token}. Valid flags: --repo, --forge, --yes, --dry-run, --smee-url, --help`,
    )
  }

  // Help short-circuits before any matrix checks.
  if (bools['--help']) {
    return { kind: 'help' }
  }

  // Forge validation (v1 = github only).
  const forgeRaw = values['--forge'] ?? 'github'
  if (forgeRaw !== 'github') {
    throw new SetupError(
      `setup subcommand only supports GitHub in v1 — the MCP server itself supports all three forges; use the manual install flow in INSTALL.md for ${forgeRaw}`,
    )
  }

  // Repo validation — if present, must match the regex.
  const repoRaw = values['--repo'] ?? null
  if (repoRaw !== null && !REPO_REGEX.test(repoRaw)) {
    throw new SetupError(
      `Invalid --repo value: "${repoRaw}". Expected format: owner/repo (alphanumeric plus . _ -).`,
    )
  }

  const yes = bools['--yes'] === true
  const dryRun = bools['--dry-run'] === true
  const smeeUrl = values['--smee-url'] ?? null

  // Interactive / non-interactive matrix:
  //
  //   TTY?  --yes?  --repo missing → behavior
  //   yes   no      yes             → valid; runner will prompt for repo
  //   yes   no      no              → valid; runner asks confirm-per-step
  //   yes   yes     yes             → SetupError (--yes requires --repo)
  //   yes   yes     no              → valid (non-interactive, all flags set)
  //   no    no      any             → SetupError (stdin is not a TTY)
  //   no    yes     yes             → SetupError (--yes requires --repo)
  //   no    yes     no              → valid (non-interactive)
  //
  // The key rule: if `--yes` is NOT set, we are going to prompt at least
  // for per-step confirmations, so a TTY is required regardless of
  // whether --repo was passed.
  if (!yes && !isTty()) {
    throw new SetupError(
      'stdin is not a TTY; pass --yes (with --repo) to run non-interactively',
    )
  }
  if (repoRaw === null && yes) {
    throw new SetupError('--yes requires --repo')
  }

  const args: SetupArgs = {
    repo: repoRaw,
    forge: 'github',
    yes,
    dryRun,
    smeeUrl,
  }

  return { kind: 'run', args }
}

/**
 * Printable usage string for `ci-channel setup --help` / `-h`.
 * Shown to stdout (help is user-requested output, not an error).
 */
export function setupUsage(): string {
  return [
    'Usage: ci-channel setup [options]',
    '',
    'Install ci-channel into the current project: provisions a smee.io channel,',
    'generates a webhook secret, creates the GitHub webhook, and registers the',
    'ci MCP server in .mcp.json.',
    '',
    'Options:',
    '  --repo OWNER/REPO     Target repository (required unless running interactively)',
    '  --forge FORGE         Forge type (default: github; v1 is GitHub-only)',
    '  --yes, -y             Skip all confirmation prompts',
    '  --dry-run             Print planned actions without executing them',
    '  --smee-url URL        Use an existing smee.io channel instead of provisioning',
    '  --help, -h            Show this message',
    '',
    'Examples:',
    '  ci-channel setup --repo owner/my-project',
    '  ci-channel setup --repo owner/my-project --yes',
    '  ci-channel setup --repo owner/my-project --dry-run --yes',
    '',
    'For manual installation (GitLab, Gitea, or troubleshooting), see INSTALL.md.',
  ].join('\n')
}
