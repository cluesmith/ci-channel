import { parseSetupArgs, setupUsage } from './args.js'
import { SetupError } from './errors.js'

/**
 * Entry point for the `ci-channel setup` subcommand.
 *
 * Phase 1 scope: dispatch + arg parsing + fail-fast matrix. The actual
 * install logic (state.json, gh wrapper, .mcp.json merger) lands in Phase 2;
 * interactive prompts land in Phase 3.
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

    // Phase 1 scaffolding: print the parsed args so users (and the dispatch
    // smoke test) can verify the command reached the installer. Phase 2
    // replaces this with the actual runInstall call.
    console.error('[ci-channel setup] parsed args:', parsed.args)
    console.error(
      '[ci-channel setup] installer not yet implemented (phase 1 scaffolding)',
    )
    return 0
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`[ci-channel setup] ${err.userMessage}`)
      return err.exitCode
    }
    throw err
  }
}
