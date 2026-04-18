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

// Known non-failure and non-terminal outcomes. Events whose normalized
// conclusion matches any of these are dropped under the default filter.
// Anything else (including failure/cancelled/timed_out/action_required and
// genuinely unknown strings) is forwarded.
const DEFAULT_EXCLUDED_CONCLUSIONS = new Set([
  // Known non-failure terminal outcomes
  "success",
  "skipped",
  "neutral",
  "manual",
  "stale",
  // Known non-terminal / in-progress outcomes
  "requested",
  "in_progress",
  "completed",
  "running",
  "pending",
  "queued",
  "waiting",
  "preparing",
  // GitLab-specific non-terminal states (see GitLab pipeline status docs)
  "created",
  "waiting_for_resource",
  "scheduled",
]);

export function normalizeConclusion(s: string): string {
  const lower = s.toLowerCase();
  if (lower === "failed") return "failure";
  if (lower === "canceled") return "cancelled";
  return lower;
}

/**
 * Returns true if an event with the given conclusion should be forwarded.
 *
 * - `allowlist === null` → default mode: drop known non-failure / in-progress
 *   outcomes; forward everything else (including unknown strings so new forge
 *   outcomes aren't silently lost).
 * - `allowlist === ['all']` → disable filtering entirely.
 * - otherwise → inclusion mode: forward only if the event's normalized
 *   conclusion is in the allowlist. The allowlist is expected to be
 *   pre-normalized at config-load time; only the event side is normalized here.
 */
export function isConclusionAllowed(
  conclusion: string,
  allowlist: string[] | null
): boolean {
  const normalized = normalizeConclusion(conclusion);

  if (allowlist === null) {
    return !DEFAULT_EXCLUDED_CONCLUSIONS.has(normalized);
  }

  if (allowlist.length === 1 && allowlist[0] === "all") {
    return true;
  }

  return allowlist.includes(normalized);
}
