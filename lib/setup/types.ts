/**
 * Types for the `ci-channel setup` subcommand.
 *
 * The installer is GitHub-only in v1; the MCP server itself supports all
 * three forges (github, gitlab, gitea). If a user passes `--forge gitlab` or
 * `--forge gitea` to `setup`, parseSetupArgs throws a SetupError that
 * explicitly points them at the manual install flow in INSTALL.md.
 */

export interface SetupArgs {
  /** Target repository in `owner/repo` format. null means the runner will prompt (TTY + no --yes). */
  repo: string | null
  /** Only 'github' is accepted in v1. */
  forge: 'github'
  /** Skip all confirmation prompts. */
  yes: boolean
  /** Print planned actions without executing them; no mutating network/fs calls. */
  dryRun: boolean
  /** Explicit smee.io channel URL; if absent the installer auto-provisions one. */
  smeeUrl: string | null
}

/**
 * Discriminated union returned by parseSetupArgs.
 *
 * `kind: 'help'` means --help / -h was passed; the runner prints usage and exits 0.
 * `kind: 'run'` means regular execution; the runner inspects `args` to drive the install.
 */
export type ParseSetupArgsResult =
  | { kind: 'run'; args: SetupArgs }
  | { kind: 'help' }
