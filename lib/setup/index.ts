import { randomBytes } from 'node:crypto'
import { fetchSmeeChannel } from '../bootstrap.js'
import { parseSetupArgs, setupUsage } from './args.js'
import { SetupError, UserDeclinedError } from './errors.js'
import { ghCreateHook, ghListHooks, ghUpdateHook } from './gh.js'
import { isGitignored } from './gitignore.js'
import { createAutoYesIo, createInteractiveIo } from './io.js'
import { readMcpJson, writeMcpJson } from './mcp-json.js'
import { runInstall, type InstallDeps, type Io } from './orchestrator.js'
import { detectProjectRoot } from './project.js'
import {
  legacyGlobalStateExists,
  readStateForSetup,
  writeStateForSetup,
} from './state.js'
import type { SetupArgs } from './types.js'

/** Repo validation regex (kept in sync with args.ts). */
const REPO_REGEX = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** Maximum interactive attempts to accept a valid repo string. */
const MAX_REPO_PROMPT_ATTEMPTS = 3

/**
 * Entry point for the `ci-channel setup` subcommand.
 *
 * Phase 3 wires the interactive `Io` when `--yes` is not passed and
 * prompts for `--repo` when missing (only reachable in TTY mode per
 * the parser matrix). All other behavior is inherited from Phase 2.
 *
 * Returns a process exit code. SetupError instances are caught and
 * printed to stderr without a stack; `UserDeclinedError` is treated
 * as a clean exit (code 0) with a "(stopped by user)" suffix; any
 * other error is re-thrown for debuggability.
 */
export async function runSetup(argv: string[]): Promise<number> {
  try {
    const parsed = parseSetupArgs(argv)
    if (parsed.kind === 'help') {
      process.stdout.write(setupUsage() + '\n')
      return 0
    }

    // Select I/O based on --yes. This instance is passed through to
    // the orchestrator so prompt state is owned by a single object.
    const io: Io = parsed.args.yes ? createAutoYesIo() : createInteractiveIo()

    // If --repo is missing we're guaranteed (by parseSetupArgs) to be
    // in TTY + !yes mode. Prompt interactively with regex validation.
    const resolvedRepo = parsed.args.repo ?? (await promptForRepo(io))

    const resolvedArgs: SetupArgs = { ...parsed.args, repo: resolvedRepo }

    const deps = buildInstallDeps()
    await runInstall(resolvedArgs, deps, io)
    return 0
  } catch (err) {
    if (err instanceof UserDeclinedError) {
      console.error(`[ci-channel setup] ${err.userMessage} (stopped by user)`)
      return err.exitCode
    }
    if (err instanceof SetupError) {
      console.error(`[ci-channel setup] ${err.userMessage}`)
      return err.exitCode
    }
    throw err
  }
}

/**
 * Prompt the user for a repo string. Re-prompts on invalid format up
 * to MAX_REPO_PROMPT_ATTEMPTS times; throws SetupError after the cap
 * to avoid infinite loops against a scripted-but-broken input.
 *
 * Exported for unit testing with a scripted Io. Production callers
 * should go through `runSetup`.
 */
export async function promptForRepo(io: Io): Promise<string> {
  for (let attempt = 0; attempt < MAX_REPO_PROMPT_ATTEMPTS; attempt++) {
    const value = await io.prompt('Target GitHub repo (owner/repo):')
    if (REPO_REGEX.test(value)) return value
    io.warn(`Invalid repo format: ${value}. Expected owner/repo.`)
  }
  throw new SetupError(
    `Too many invalid repo attempts (${MAX_REPO_PROMPT_ATTEMPTS}); aborting.`,
  )
}

/**
 * Build the real InstallDeps used by production runSetup. Wires the
 * orchestrator to real filesystem / subprocess / network helpers.
 * Tests don't call this — they build their own deps inline.
 */
function buildInstallDeps(): InstallDeps {
  return {
    detectProjectRoot: () => detectProjectRoot(),
    readState: (root) => readStateForSetup(root),
    writeState: (root, state) => writeStateForSetup(root, state),
    legacyGlobalStateExists,
    isGitignored,
    generateSecret: () => randomBytes(32).toString('hex'),
    fetchSmeeChannel,
    ghListHooks,
    ghCreateHook,
    ghUpdateHook,
    readMcpJson,
    writeMcpJson,
  }
}
