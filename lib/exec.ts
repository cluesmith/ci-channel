import { spawn } from 'node:child_process'

/**
 * Run a CLI command with timeout. Returns stdout on success, null on failure.
 * All subprocess calls use stdin: 'ignore' to prevent consuming MCP stdin bytes.
 */
export async function runCommand(args: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = spawn(args[0], args.slice(1), {
      // CRITICAL: stdin must be 'ignore' to prevent child from inheriting
      // the MCP stdio pipe. Inheriting stdin allows child processes to
      // consume MCP protocol bytes, breaking the transport connection.
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    let stdout = ''
    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

    let timer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try { proc.kill() } catch {}
        resolve(null)
      }, timeoutMs)
    })

    const resultPromise = new Promise<string | null>((resolve) => {
      proc.on('close', (code) => {
        resolve(code === 0 ? stdout.trim() : null)
      })
      proc.on('error', () => resolve(null))
    })

    return await Promise.race([resultPromise, timeoutPromise]).finally(() => clearTimeout(timer!))
  } catch {
    return null
  }
}
