import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Config } from './config.js'
import type { Forge } from './forge.js'
import { formatNotification, pushNotification } from './notify.js'

// Re-export for backward compatibility with existing imports
export { runCommand } from './exec.js'

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
