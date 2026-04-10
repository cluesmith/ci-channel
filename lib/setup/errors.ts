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
