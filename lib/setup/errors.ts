/**
 * Error type used across the installer.
 *
 * `userMessage` is a short, terminal-friendly string suitable for writing to stderr
 * without a stack. `exitCode` is the process exit code to return from runSetup.
 *
 * runSetup catches SetupError instances and prints the userMessage; any other
 * thrown error is re-thrown with its stack for debuggability.
 */
export class SetupError extends Error {
  public readonly userMessage: string
  public readonly exitCode: number

  constructor(userMessage: string, exitCode: number = 1) {
    super(userMessage)
    this.name = 'SetupError'
    this.userMessage = userMessage
    this.exitCode = exitCode
  }
}

/**
 * Thrown when the user declines an interactive confirmation prompt.
 *
 * Distinct from a regular SetupError so runSetup can treat it as a
 * clean exit (code 0 — "the user said no, that's not an error") while
 * still using the same catch path. runSetup recognizes
 * UserDeclinedError and prints a "(stopped by user)" suffix.
 */
export class UserDeclinedError extends SetupError {
  constructor(message: string) {
    super(message, 0)
    this.name = 'UserDeclinedError'
  }
}
