import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebhookEvent } from "./webhook.js";

export interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

export function sanitize(input: string, maxLength: number): string {
  let result = input
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars except newline/tab
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  if (result.length > maxLength) {
    result = `${result.slice(0, maxLength - 3)}...`;
  }

  return result;
}

// Non-terminal states — for these we keep the line short (no commit info)
// because a workflow just starting up doesn't need to identify a specific
// commit; the user just wants to know CI is running.
const NON_TERMINAL_STATES = new Set([
  "requested",
  "in_progress",
  "queued",
  "pending",
  "waiting",
]);

export function formatNotification(
  event: WebhookEvent,
  failedJobs?: string[]
): ChannelNotification {
  const workflow = sanitize(event.workflowName, 200);
  const branch = sanitize(event.branch, 100);
  const conclusion = sanitize(event.conclusion, 50);

  // Compact format: "<state>: <workflow> · <branch>" plus commit info on
  // terminal states only. Drops the redundant "CI " prefix (channel source
  // already says "ci:") and the "on branch " filler so more useful info
  // fits inside the terminal width before truncation.
  let content = `${conclusion}: ${workflow} · ${branch}`;

  if (!NON_TERMINAL_STATES.has(conclusion)) {
    if (event.commitMessage) {
      const msg = sanitize(event.commitMessage.split("\n")[0], 200); // First line only
      content += ` — ${msg}`;
      if (event.commitAuthor) {
        const author = sanitize(event.commitAuthor, 100);
        content += ` by ${author}`;
      }
    } else {
      content += ` — ${event.commitSha.slice(0, 8)}`;
    }
  }

  if (failedJobs && failedJobs.length > 0) {
    const jobList = failedJobs.map((j) => sanitize(j, 200)).join(", ");
    content += `\nFailed jobs: ${jobList}`;
  }

  return {
    content,
    meta: {
      workflow: sanitize(event.workflowName, 200),
      branch: sanitize(event.branch, 100),
      commit_sha: event.commitSha, // machine-generated, safe
      run_url: event.runUrl, // machine-generated URL, safe
      run_id: String(event.runId), // numeric, safe
      conclusion: sanitize(event.conclusion, 50),
    },
  };
}

export async function pushNotification(
  mcp: Server,
  notification: ChannelNotification
): Promise<void> {
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: notification.content,
      meta: notification.meta,
    },
  });
}
