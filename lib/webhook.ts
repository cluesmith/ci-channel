import { createHmac, timingSafeEqual } from "node:crypto";

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

export function validateSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const received = signature.slice(prefix.length);

  if (expected.length !== received.length) {
    return false;
  }

  try {
    return timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(received, "hex")
    );
  } catch {
    return false;
  }
}

export function parseWebhookEvent(
  eventType: string | null,
  deliveryId: string | null,
  body: string
): ParseResult {
  // Parse JSON first — malformed payloads get 400 regardless of event type
  // biome-ignore lint/suspicious/noExplicitAny: webhook payload is untyped JSON
  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return {
      type: "malformed",
      reason: `Invalid JSON: ${(e as Error).message}`,
    };
  }

  if (!payload || typeof payload !== "object") {
    return { type: "malformed", reason: "Payload is not an object" };
  }

  // Then check event type — non-workflow_run events are irrelevant
  if (eventType !== "workflow_run") {
    return { type: "irrelevant" };
  }

  if (payload.action !== "completed") {
    return { type: "irrelevant" };
  }

  const run = payload.workflow_run;
  if (!run || typeof run !== "object") {
    return { type: "malformed", reason: "Missing workflow_run field" };
  }

  // Alert on all completed workflow runs (success, failure, cancelled, etc.)
  // The architect can decide what to act on based on the conclusion field.

  const repo = payload.repository;
  if (!repo || typeof repo !== "object" || typeof repo.full_name !== "string") {
    return { type: "malformed", reason: "Missing repository.full_name" };
  }

  return {
    type: "event",
    event: {
      deliveryId: deliveryId ?? "unknown",
      workflowName: run.name ?? "unknown",
      conclusion: run.conclusion ?? "unknown",
      branch: run.head_branch ?? "unknown",
      commitSha: run.head_sha ?? "unknown",
      commitMessage: run.head_commit?.message ?? null,
      commitAuthor: run.head_commit?.author?.name ?? null,
      runUrl: run.html_url ?? "",
      runId: run.id ?? 0,
      repoFullName: repo.full_name,
    },
  };
}

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
