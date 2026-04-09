# CI Channel for Claude Code

Real-time CI/CD notifications delivered straight into your Claude Code session. When a CI workflow or pipeline fails, Claude sees it immediately and can investigate the failure, check logs, and suggest fixes — without you having to context-switch.

Supports **GitHub Actions**, **GitLab CI**, and **Gitea Actions**.

## How It Works

```
Forge (GitHub/GitLab/Gitea)
        │
    webhook POST
        │
        ▼
   smee.io (relay)     ← auto-provisioned on first run
        │
        ▼
   localhost:{port}    ← random port, no conflicts
        │
        ▼
┌───────────────────┐
│  Channel Plugin   │  ← validates signature, deduplicates, filters
│   (MCP server)    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│   Claude Code     │  ← receives structured notification
│    (session)      │
└───────────────────┘
```

## Zero-Config Quick Start

> **NOTE:** Claude Channels is still a new feature so config is a bit complicated.
>
> **LLM agents**: See [INSTALL.md](INSTALL.md) for step-by-step installation instructions designed for AI agents to follow programmatically.

The plugin auto-generates a webhook secret and provisions a smee.io relay on first run. You just need to:

### 1. Clone and install

```bash
git clone https://github.com/cluesmith/ci-channel.git
cd ci-channel
npm install
```

### 2. Register the MCP server

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts"],"cwd":"/absolute/path/to/ci-channel"}'
```

### 3. Start Claude Code with the channel enabled

```bash
claude --dangerously-load-development-channels server:ci
```

On first run, the plugin:
1. Generates a `WEBHOOK_SECRET` and provisions a smee.io relay channel
2. Saves auto-provisioned state to `~/.claude/channels/ci/state.json` (persists across restarts)
3. Sends a channel notification to Claude with the webhook URL and secret:

```
CI channel ready. Configure your forge webhook:
  URL: https://smee.io/abc123
  Secret: a1b2c3d4...
  Events: Workflow runs (GitHub/Gitea) or Pipeline events (GitLab)
```

### 4. Configure your forge webhook (one-time)

Copy the URL and secret from the notification and configure your forge's webhook. For GitHub, you can use the `gh` CLI:

```bash
gh api repos/OWNER/REPO/hooks --method POST --input - <<'EOF'
{
  "config": {
    "url": "https://smee.io/YOUR_CHANNEL_URL",
    "content_type": "json",
    "secret": "YOUR_WEBHOOK_SECRET"
  },
  "events": ["workflow_run"],
  "active": true
}
EOF
```

Or configure it manually in the GitHub UI (see [Per-Forge Setup Guides](#per-forge-setup-guides) below).

That's it. No `.env` file to create manually, no browser visit to smee.io.

## Per-Forge Setup Guides

### GitHub Actions

**Setup:**
```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts"],"cwd":"/path/to/ci-channel"}'
claude --dangerously-load-development-channels server:ci
```

No `--forge` flag needed — GitHub is the default.

**Webhook configuration** — Use the `gh` CLI or the GitHub UI:

```bash
gh api repos/OWNER/REPO/hooks --method POST --input - <<'EOF'
{
  "config": {
    "url": "SMEE_URL_FROM_NOTIFICATION",
    "content_type": "json",
    "secret": "SECRET_FROM_NOTIFICATION"
  },
  "events": ["workflow_run"],
  "active": true
}
EOF
```

Or manually: **Settings > Webhooks > Add webhook**

| Field | Value |
|-------|-------|
| **Payload URL** | The smee.io URL from the notification |
| **Content type** | `application/json` |
| **Secret** | The secret from the notification |
| **Events** | Select **"Workflow runs"** only |

**`.env` file** (`~/.claude/channels/ci/.env`): auto-generated on first run. If configuring manually:
```env
WEBHOOK_SECRET=your-webhook-secret
```

**Optional CLI**: Install [gh CLI](https://cli.github.com/) for startup reconciliation and failed job enrichment.

**Reference**: [GitHub Webhooks docs](https://docs.github.com/en/webhooks), [workflow_run event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run)

### GitLab CI

**Setup:**
```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--forge","gitlab","--repos","group/project"],"cwd":"/path/to/ci-channel"}'
claude --dangerously-load-development-channels server:ci
```

For nested namespaces, use the exact `path_with_namespace` value: `--repos "group/subgroup/project"`.

**Webhook configuration** — Go to your GitLab project: **Settings > Webhooks > Add new webhook**

| Field | Value |
|-------|-------|
| **URL** | The smee.io URL from the notification |
| **Secret token** | The secret from the notification |
| **Trigger** | Check **Pipeline events** only |

**`.env` file** (`~/.claude/channels/ci/.env`): auto-generated on first run. If configuring manually:
```env
WEBHOOK_SECRET=your-gitlab-secret-token
```

**Optional CLI**: Install [glab CLI](https://gitlab.com/gitlab-org/cli) for startup reconciliation and failed job enrichment.

**Reference**: [GitLab Webhooks docs](https://docs.gitlab.com/ee/user/project/integrations/webhooks.html), [Pipeline events](https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#pipeline-events)

### Gitea Actions

**Setup:**
```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--forge","gitea","--gitea-url","https://your-gitea-instance.com","--repos","owner/repo"],"cwd":"/path/to/ci-channel"}'
claude --dangerously-load-development-channels server:ci
```

**Secrets** — Add to `~/.claude/channels/ci/.env`:
```env
GITEA_TOKEN=your-gitea-api-token
```

**Webhook configuration** — Go to your Gitea repo: **Settings > Webhooks > Add Webhook > Gitea**

| Field | Value |
|-------|-------|
| **Target URL** | The smee.io URL from the notification |
| **Secret** | The secret from the notification |
| **Events** | Select **"Workflow runs"** |

**`.env` file** (`~/.claude/channels/ci/.env`):
```env
WEBHOOK_SECRET=your-webhook-secret
GITEA_TOKEN=your-gitea-api-token
```

**Note**: `--gitea-url` is required for startup reconciliation and job enrichment (uses the Gitea API directly). `GITEA_TOKEN` enables authenticated API access.

**Reference**: [Gitea Webhooks docs](https://docs.gitea.com/usage/webhooks)

## Configuration Reference

Configuration uses CLI args (passed in the `args` array when registering the MCP server) for structural settings, and `~/.claude/channels/ci/.env` for secrets. Auto-provisioned state (generated secret, smee URL) is persisted to `~/.claude/channels/ci/state.json`.

Precedence: CLI args > env vars > `.env` file > `state.json`.

### CLI args (structural config)

| Arg | Default | Description |
|-----|---------|-------------|
| `--forge` | `github` | Forge type: `github`, `gitlab`, or `gitea` |
| `--repos` | — | Comma-separated repo/project allowlist |
| `--workflow-filter` | — | Comma-separated workflow names to monitor |
| `--reconcile-branches` | `ci,develop` | Branches to check for recent failures on startup |
| `--port` | `0` (random) | HTTP server port (0 = OS-assigned) |
| `--gitea-url` | — | Gitea instance base URL (required for Gitea reconciliation) |
| `--smee-url` | — | smee.io channel URL (auto-provisioned if not set) |

### Secrets (`.env` file)

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | No (auto-generated) | Shared secret for webhook signature validation |
| `GITEA_TOKEN` | No | Gitea API token for authenticated access |

### Backward-compatible env vars

All CLI args also accept env vars for backward compatibility:

| Env var | Maps to | Notes |
|---------|---------|-------|
| `FORGE` | `--forge` | CLI arg takes precedence |
| `REPOS` | `--repos` | CLI arg takes precedence |
| `GITHUB_REPOS` | `--repos` | Legacy alias, lowest precedence |
| `PORT` | `--port` | CLI arg takes precedence |
| `SMEE_URL` | `--smee-url` | CLI arg takes precedence |
| `WORKFLOW_FILTER` | `--workflow-filter` | CLI arg takes precedence |
| `RECONCILE_BRANCHES` | `--reconcile-branches` | CLI arg takes precedence |
| `GITEA_URL` | `--gitea-url` | CLI arg takes precedence |

### Example: Monitor specific repos and workflows

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--repos","myorg/api,myorg/frontend","--workflow-filter","CI,Deploy to Production","--reconcile-branches","main,develop"],"cwd":"/path/to/ci-channel"}'
claude --dangerously-load-development-channels server:ci
```

### Smee channel management

By default, the plugin auto-provisions a smee.io channel on first run and persists it to `state.json`, so the same URL is reused across restarts. You only configure your forge webhook once.

To use a manually provisioned channel instead (e.g., for shared team use), include `--smee-url` in the args:

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--smee-url","https://smee.io/your-channel"],"cwd":"/path/to/ci-channel"}'
```

## Features

### Startup Reconciliation

When the plugin starts, it checks configured branches for recent CI failures that occurred while offline:
- **GitHub**: `gh run list` (requires gh CLI)
- **GitLab**: `glab ci list` (requires glab CLI)
- **Gitea**: Gitea API via `--gitea-url`

### Job Enrichment

After pushing the initial failure notification, the plugin asynchronously fetches the names of failed jobs. A follow-up notification with job details arrives shortly after — without blocking the initial alert.

### Deduplication

Forges occasionally retry webhook delivery. The plugin tracks the last 100 delivery IDs to prevent duplicate notifications. For GitLab, a synthetic delivery ID (`gitlab-{project_id}-{pipeline_id}-{status}`) ensures different pipeline state transitions aren't suppressed.

### Filtering

- **Repository allowlist** (`--repos`): Only receive notifications from repos you care about
- **Workflow filter** (`--workflow-filter`): Only monitor specific workflows

## Security

- **Signature validation** — Every webhook payload is verified:
  - GitHub/Gitea: HMAC-SHA256 with timing-safe comparison
  - GitLab: Token comparison with timing-safe comparison
- **Localhost-only binding** — The HTTP server binds to `127.0.0.1` only
- **Repository allowlist** — Optional `--repos` restricts which repos can push events
- **Prompt injection prevention** — All user-controlled fields sanitized before inclusion in notifications
- **Deduplication** — Prevents replay of duplicate webhook deliveries

## How to Check It's Working

1. **Verify the MCP server is connected:**
   ```bash
   claude mcp list
   ```
   The `ci` server should show `Connected`.

2. **Check webhook deliveries are arriving:**
   ```bash
   gh api repos/OWNER/REPO/hooks --jq '.[0].id'
   # Use the hook ID:
   gh api repos/OWNER/REPO/hooks/HOOK_ID/deliveries --jq '.[:3] | .[] | {event, status_code, delivered_at}'
   ```
   You should see `workflow_run` events with `status_code: 200`.

3. **Trigger a test failure:** Push a commit that breaks a test. Within a minute, you should see a channel notification like:
   ```xml
   <channel source="ci" workflow="CI" branch="main" run_url="..." conclusion="failure">
   CI failure: CI on branch main — commit "break a test" by you
   </channel>
   ```

4. **Check the plugin logs:** The plugin logs to stderr. If running locally, stderr output shows webhook receipt, signature validation, and notification delivery.

## Troubleshooting

### No notifications arriving

1. Check that the plugin sent a setup notification on startup (with URL and secret)
2. Verify the webhook URL and secret match between your forge and the plugin
3. Confirm the correct events are enabled (Workflow runs for GitHub/Gitea, Pipeline events for GitLab)
4. Verify the MCP server is registered (`claude mcp list`) and you launched with `--dangerously-load-development-channels server:ci`

### Multiple Claude sessions

The plugin defaults to port 0 (OS-assigned random port), so multiple sessions can run concurrently without port conflicts. Each session auto-provisions its own smee channel.

### CLI tool errors

Startup reconciliation and job enrichment are best-effort:
- **GitHub**: Requires `gh` CLI installed and authenticated
- **GitLab**: Requires `glab` CLI installed and authenticated
- **Gitea**: Requires `--gitea-url` configured

If the CLI/API is unavailable, the plugin logs a warning and continues — live webhook notifications still work.

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests (170 tests across 11 files)
npx tsx server.ts    # Start the server
```

### Project Structure

```
server.ts                  # MCP server entry point — HTTP, smee, bootstrap, reconciliation
lib/
  forge.ts                 # Forge interface definition
  forges/
    github.ts              # GitHub Actions forge implementation
    gitlab.ts              # GitLab CI forge implementation
    gitea.ts               # Gitea Actions forge implementation
  config.ts                # Configuration loader (CLI args + env vars + .env file)
  bootstrap.ts             # First-run auto-provisioning (secret, smee, notification)
  handler.ts               # Webhook handler pipeline (validate → dedup → filter → notify)
  webhook.ts               # WebhookEvent type, deduplication, filtering
  notify.ts                # Notification formatting and sanitization
  reconcile.ts             # Startup reconciliation orchestration
tests/
  forges/
    gitlab.test.ts         # GitLab forge unit tests
    gitea.test.ts          # Gitea forge unit tests
  webhook.test.ts          # GitHub forge + shared webhook tests
  notify.test.ts           # Sanitization, formatting
  config.test.ts           # Config loading, CLI args, precedence
  bootstrap.test.ts        # Auto-provisioning with injected deps
  reconcile.test.ts        # Reconciliation, job enrichment
  integration.test.ts      # GitHub HTTP pipeline end-to-end
  integration-gitlab.test.ts  # GitLab HTTP pipeline end-to-end
  integration-gitea.test.ts   # Gitea HTTP pipeline end-to-end
  stdio-lifecycle.test.ts  # MCP stdio stability regression test
  fixtures/                # Sample webhook payloads per forge
```

## Contributing

This is a [Codev](https://github.com/cluesmith/codev) project and follows the Codev methodology for AI-assisted development. The preferred way to contribute is via PRs generated with Codev.

Each feature follows the **three-document model**:
- **Specification** (`codev/specs/`) — What to build and why
- **Plan** (`codev/plans/`) — How to build it, in testable phases
- **Review** (`codev/reviews/`) — What was learned, deviations from plan

PRs that include Codev artifacts (spec, plan, review) are significantly easier to review and integrate. See `CLAUDE.md` for Claude Code-specific instructions and `AGENTS.md` for cross-tool AI agent compatibility (Cursor, GitHub Copilot, etc.).

## License

MIT License. See [LICENSE](LICENSE) for details.
