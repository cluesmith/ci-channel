import { spawn } from 'node:child_process'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Config } from './config.js'
import type { Forge } from './forge.js'
import { formatNotification, pushNotification } from './notify.js'

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

export async function runStartupReconciliation(mcp: Server, config: Config, forge: Forge): Promise<void> {
  const startTime = Date.now()
  const totalBudgetMs = 10000

  for (const branch of config.reconcileBranches) {
    const remaining = totalBudgetMs - (Date.now() - startTime)
    if (remaining <= 0) {
      console.error(`[ci-channel] Startup reconciliation timed out after checking ${config.reconcileBranches.indexOf(branch)} of ${config.reconcileBranches.length} branches`)
      break
    }

    const event = await forge.runReconciliation(config, branch, remaining)
    if (!event) continue

    // Apply workflow filter if configured (match live webhook behavior)
    if (config.workflowFilter && event.workflowName && !config.workflowFilter.includes(event.workflowName)) continue

    const notification = formatNotification(event)
    await pushNotification(mcp, notification)
  }
}
