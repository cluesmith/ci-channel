import { spawn } from 'node:child_process'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Config } from './config.js'
import type { WebhookEvent } from './webhook.js'
import { formatNotification, pushNotification } from './notify.js'

async function runCommand(args: string[], timeoutMs: number): Promise<string | null> {
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

export async function runStartupReconciliation(mcp: Server, config: Config): Promise<void> {
  const startTime = Date.now()
  const totalBudgetMs = 10000

  for (const branch of config.reconcileBranches) {
    const remaining = totalBudgetMs - (Date.now() - startTime)
    if (remaining <= 0) {
      console.error(`[ci-channel] Startup reconciliation timed out after checking ${config.reconcileBranches.indexOf(branch)} of ${config.reconcileBranches.length} branches`)
      break
    }

    const output = await runCommand(
      ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'conclusion,name,headBranch,headSha,url,databaseId'],
      remaining
    )

    if (!output) {
      console.error(`[ci-channel] Startup reconciliation: could not check branch "${branch}" (gh unavailable or timed out)`)
      continue
    }

    let runs: any[]
    try {
      runs = JSON.parse(output)
    } catch {
      console.error(`[ci-channel] Startup reconciliation: invalid JSON from gh for branch "${branch}"`)
      continue
    }

    if (!Array.isArray(runs) || runs.length === 0) continue

    const run = runs[0]
    if (run.conclusion !== 'failure') continue

    // Apply workflow filter if configured (match live webhook behavior)
    if (config.workflowFilter && run.name && !config.workflowFilter.includes(run.name)) continue

    const event: WebhookEvent = {
      deliveryId: `reconcile-${branch}-${run.databaseId ?? 'unknown'}`,
      workflowName: run.name ?? 'unknown',
      conclusion: run.conclusion,
      branch: run.headBranch ?? branch,
      commitSha: run.headSha ?? 'unknown',
      commitMessage: null,
      commitAuthor: null,
      runUrl: run.url ?? '',
      runId: run.databaseId ?? 0,
      repoFullName: '', // not available from gh run list
    }

    const notification = formatNotification(event)
    await pushNotification(mcp, notification)
  }
}

export async function fetchFailedJobs(repoFullName: string, runId: number): Promise<string[] | null> {
  const output = await runCommand(
    ['gh', 'api', `/repos/${repoFullName}/actions/runs/${runId}/jobs`, '--jq', '.jobs[] | select(.conclusion == "failure") | .name'],
    3000
  )

  if (!output) {
    return null
  }

  const jobs = output.split('\n').map(s => s.trim()).filter(Boolean)
  return jobs.length > 0 ? jobs : null
}
