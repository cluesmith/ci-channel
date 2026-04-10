import { randomBytes } from 'node:crypto'
import { fetchSmeeChannel } from '../bootstrap.js'
import { parseSetupArgs, setupUsage } from './args.js'
import { SetupError } from './errors.js'
import { ghCreateHook, ghListHooks } from './gh.js'
import { isGitignored } from './gitignore.js'
import { readMcpJson, writeMcpJson } from './mcp-json.js'
import { runInstall, type InstallDeps, type Io } from './orchestrator.js'
import { detectProjectRoot } from './project.js'
import {
  legacyGlobalStateExists,
  readStateForSetup,
  writeStateForSetup,
} from './state.js'

/**
 * Entry point for the `ci-channel setup` subcommand.
 *
 * Phase 2 wires parseSetupArgs to the non-interactive installer core
 * (orchestrator + deps). Interactive prompts (for non-`--yes` runs) land
 * in Phase 3.
 *
 * Returns a process exit code. SetupError instances are caught and their
 * userMessage is written to stderr without a stack; any other error is
 * re-thrown for debuggability.
 */
export async function runSetup(argv: string[]): Promise<number> {
  try {
    const parsed = parseSetupArgs(argv)
    if (parsed.kind === 'help') {
      process.stdout.write(setupUsage() + '\n')
      return 0
    }

    // Phase 2 scope guard: only --yes runs are supported in this phase.
    // Phase 3 will add interactive prompts for non-`--yes` runs and
    // prompt for --repo when missing in interactive mode.
    if (!parsed.args.yes) {
      throw new SetupError(
        'Interactive mode not yet implemented — pass --yes to run non-interactively',
      )
    }

    const deps = buildInstallDeps()
    const io = buildAutoYesIo()
    await runInstall(parsed.args, deps, io)
    return 0
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`[ci-channel setup] ${err.userMessage}`)
      return err.exitCode
    }
    throw err
  }
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
    readMcpJson,
    writeMcpJson,
  }
}

/**
 * Phase 2 `Io` implementation: all `confirm` calls auto-return true
 * because Phase 2 only supports `--yes` mode. `prompt` throws because
 * it should never be called in non-interactive mode — Phase 3 will
 * provide an interactive variant.
 */
function buildAutoYesIo(): Io {
  return {
    info: (msg) => console.error(msg),
    warn: (msg) => console.error(msg),
    confirm: async () => true,
    prompt: async () => {
      throw new SetupError(
        'Internal error: interactive prompt requested in --yes mode',
      )
    },
  }
}
