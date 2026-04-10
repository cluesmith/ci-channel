import { confirm, input } from '@inquirer/prompts'
import { SetupError } from './errors.js'
import type { Io } from './orchestrator.js'

/**
 * Auto-yes I/O: every `confirm` returns true, `prompt` throws if ever
 * called. Used when `--yes` is passed — the installer runs through
 * every mutating step without stopping.
 *
 * `info` and `warn` both go to stderr. Stdout is reserved for
 * primary output (e.g., `setupUsage`) so scripts that capture stdout
 * get clean values.
 */
export function createAutoYesIo(): Io {
  return {
    info: (msg) => process.stderr.write(msg + '\n'),
    warn: (msg) => process.stderr.write(msg + '\n'),
    confirm: async () => true,
    prompt: async () => {
      throw new SetupError(
        'Internal error: interactive prompt requested in --yes mode',
      )
    },
  }
}

/**
 * Interactive I/O: `confirm` and `prompt` wrap `@inquirer/prompts`'
 * `confirm` and `input` functions. The installer calls `io.confirm`
 * before each side-effecting step; if the user declines, the
 * orchestrator throws `UserDeclinedError` and the subcommand exits
 * cleanly with code 0.
 *
 * `info`/`warn` are routed to stderr to stay out of the inquirer
 * terminal buffer.
 *
 * This implementation is only instantiated when `parseSetupArgs` has
 * already verified TTY presence; a non-TTY call to `input`/`confirm`
 * raises inquirer's own `NonInteractiveError`, which we catch and
 * convert to a clearer `SetupError`.
 */
export function createInteractiveIo(): Io {
  return {
    info: (msg) => process.stderr.write(msg + '\n'),
    warn: (msg) => process.stderr.write(msg + '\n'),
    confirm: async (message) => {
      try {
        return await confirm({ message, default: true })
      } catch (err) {
        throw wrapInquirerError(err)
      }
    },
    prompt: async (message) => {
      try {
        return await input({ message })
      } catch (err) {
        throw wrapInquirerError(err)
      }
    },
  }
}

/**
 * Convert inquirer errors to SetupError with clearer messages.
 *
 * Notable cases:
 * - `ExitPromptError` (raised when the user hits Ctrl-C) becomes a
 *   "cancelled by user" SetupError with exitCode 130 (128 + SIGINT).
 * - Anything else becomes a generic "interactive prompt failed"
 *   SetupError with the underlying message.
 */
function wrapInquirerError(err: unknown): SetupError {
  const e = err as { name?: string; message?: string }
  if (e?.name === 'ExitPromptError' || e?.name === 'AbortPromptError') {
    return new SetupError('Cancelled by user (Ctrl-C)', 130)
  }
  return new SetupError(
    `Interactive prompt failed: ${e?.message ?? String(err)}`,
  )
}
