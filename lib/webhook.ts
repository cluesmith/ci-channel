export interface WebhookEvent {
  branch: string;
  commitAuthor: string | null;
  commitMessage: string | null;
  commitSha: string;
  conclusion: string;
  deliveryId: string;
  repoFullName: string;
  runId: number;
  runUrl: string;
  workflowName: string;
}

export type ParseResult =
  | { type: "event"; event: WebhookEvent }
  | { type: "irrelevant" }
  | { type: "malformed"; reason: string };

// Deduplication set — tracks recent delivery IDs
const recentDeliveries = new Set<string>();
const MAX_DEDUP_SIZE = 100;

export function isDuplicate(deliveryId: string): boolean {
  if (recentDeliveries.has(deliveryId)) {
    return true;
  }

  // Evict oldest if at capacity
  if (recentDeliveries.size >= MAX_DEDUP_SIZE) {
    const oldest = recentDeliveries.keys().next().value;
    if (oldest !== undefined) {
      recentDeliveries.delete(oldest);
    }
  }

  recentDeliveries.add(deliveryId);
  return false;
}

// Exposed for testing
export function clearDedup() {
  recentDeliveries.clear();
}

export function isRepoAllowed(
  repoFullName: string,
  allowlist: string[] | null
): boolean {
  if (!allowlist) {
    return true; // no allowlist configured = all repos allowed
  }
  return allowlist.includes(repoFullName);
}

export function isWorkflowAllowed(
  workflowName: string,
  filter: string[] | null
): boolean {
  if (!filter) {
    return true; // no filter configured = all workflows allowed
  }
  return filter.includes(workflowName);
}
