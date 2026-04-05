# CI Channel for Claude Code

Real-time CI/CD failure notifications delivered straight into your Claude Code session. When a CI workflow fails, Claude sees it immediately and can investigate the failure, check logs, and suggest fixes — without you having to context-switch.

## How It Works

```
GitHub Actions ──webhook──▸ smee.io ──forward──▸ localhost:8789
                                                      │
                                              ┌───────┴───────┐
                                              │ Channel Plugin │
                                              │  (MCP server)  │
                                              └───────┬───────┘
                                                      │
                                              ┌───────┴───────┐
                                              │  Claude Code   │
                                              │   (session)    │
                                              └───────────────┘
```

1. GitHub sends a `workflow_run` webhook when a workflow completes
2. [smee.io](https://smee.io) relays it to the plugin's local HTTP server
3. The plugin validates the HMAC signature, deduplicates, and filters
4. A channel notification is pushed into the Claude Code session
5. Claude sees the failure and can investigate immediately

When Claude receives a failure alert, it looks like this:

```xml
<channel source="ci" workflow="CI" branch="main" run_url="https://github.com/..." conclusion="failure">
CI failure: CI on branch main — commit "fix: widget alignment" by developer
</channel>
```

## Prerequisites

- **Node.js** v20+
- **[gh CLI](https://cli.github.com/)** installed and authenticated (for startup reconciliation and job enrichment)
- **Claude Code** v2.1.80+ (channels support)

## Quick Start

### 1. Clone the plugin

```bash
git clone https://github.com/cluesmith/ci-channel.git
cd ci-channel
npm install
```

### 2. Create a smee.io channel

Go to [smee.io](https://smee.io/) and click **Start a new channel**. Copy the URL — you'll need it in step 4.

smee.io acts as a public relay that forwards GitHub webhooks to your local machine, even behind NAT/firewalls.

### 3. Configure your GitHub webhook

In your GitHub repository (or organization): **Settings > Webhooks > Add webhook**

| Field | Value |
|-------|-------|
| **Payload URL** | Your smee.io channel URL |
| **Content type** | `application/json` |
| **Secret** | A strong random string (you'll use this in step 4) |
| **Events** | Select **"Workflow runs"** only |

### 4. Configure the plugin

Create the config directory and `.env` file:

```bash
mkdir -p ~/.claude/channels/ci
```

Create `~/.claude/channels/ci/.env`:

```env
WEBHOOK_SECRET=your-github-webhook-secret-here
SMEE_URL=https://smee.io/your-channel-url
```

### 5. Register the MCP server

Add to your project's `.mcp.json` (or `~/.claude/.mcp.json` for global):

```json
{
  "mcpServers": {
    "ci": {
      "command": "npx",
      "args": ["tsx", "server.ts"],
      "cwd": "/absolute/path/to/ci-channel"
    }
  }
}
```

### 6. Start Claude Code

```bash
claude
```

The plugin starts automatically as an MCP server. When a workflow fails, Claude will be notified in real-time.

## Configuration

All configuration goes in `~/.claude/channels/ci/.env` or as environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WEBHOOK_SECRET` | Yes | — | Shared secret for HMAC-SHA256 signature validation |
| `PORT` | No | `8789` | HTTP server port for receiving webhooks |
| `SMEE_URL` | No | — | smee.io channel URL (plugin auto-spawns smee-client if set) |
| `GITHUB_REPOS` | No | — | Comma-separated repo allowlist (e.g., `owner/repo1,owner/repo2`) |
| `WORKFLOW_FILTER` | No | — | Comma-separated workflow names to monitor (e.g., `CI,Deploy`) |
| `RECONCILE_BRANCHES` | No | `ci,develop` | Branches to check for recent failures on startup |

### Example: Monitor specific repos and workflows

```env
WEBHOOK_SECRET=super-secret-value
SMEE_URL=https://smee.io/abc123
GITHUB_REPOS=myorg/api,myorg/frontend
WORKFLOW_FILTER=CI,Deploy to Production
RECONCILE_BRANCHES=main,develop
```

## Features

### Startup Reconciliation

When the plugin starts, it runs `gh run list` to check if any recent workflows failed while Claude Code was offline. This catches failures you might have missed between sessions.

### Job Enrichment

After pushing the initial failure notification, the plugin asynchronously fetches the names of failed jobs via `gh api`. A follow-up notification with job details arrives shortly after — without blocking the initial alert.

### Deduplication

GitHub occasionally retries webhook delivery. The plugin tracks the last 100 delivery IDs to prevent duplicate notifications.

### Filtering

- **Repository allowlist**: Only receive notifications from repos you care about
- **Workflow filter**: Only monitor specific workflows (e.g., just `CI`, not `Lint`)

## Security

This plugin was designed with security as a priority:

- **HMAC-SHA256 signature validation** — Every webhook payload is verified against the shared secret using timing-safe comparison. Invalid signatures are rejected with 403.
- **Localhost-only binding** — The HTTP server binds to `127.0.0.1` only. No external network access.
- **Repository allowlist** — Optional `GITHUB_REPOS` restricts which repos can push events.
- **Prompt injection prevention** — All user-controlled fields (commit messages, branch names, workflow names, author names) are sanitized before being included in notifications:
  - HTML entities escaped (`<` to `&lt;`, `>` to `&gt;`)
  - Control characters stripped
  - Fields truncated to safe maximum lengths
- **Deduplication** — Prevents replay of duplicate webhook deliveries.

## Troubleshooting

### No notifications arriving

1. Verify `SMEE_URL` is set — the plugin auto-spawns smee-client
2. Check your webhook secret matches between GitHub and your `.env`
3. Confirm the webhook is configured for **"Workflow runs"** events in GitHub
4. Verify the MCP server is registered in `.mcp.json`

### Port already in use

Set a different port:
```env
PORT=9999
```

### gh CLI errors

Startup reconciliation and job enrichment require `gh` to be installed and authenticated (`gh auth login`). If `gh` is unavailable, the plugin logs a warning to stderr and continues — live webhook notifications still work fine.

### smee-client not starting

The plugin spawns smee-client via `npx smee-client`. Make sure `npx` is available (it ships with Node.js).

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests (Node.js built-in test runner)
npx tsx server.ts    # Start the server locally
```

### Testing with curl

Generate a signed test payload and send it to your local server:

```bash
SECRET="your-test-secret"
PAYLOAD='{"action":"completed","workflow_run":{"id":1,"name":"CI","head_branch":"main","head_sha":"abc123","html_url":"http://example.com","conclusion":"failure","head_commit":{"message":"test commit","author":{"name":"dev"}}},"repository":{"full_name":"owner/repo"}}'
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)"

curl -X POST http://localhost:8789/webhook/github \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Event: workflow_run" \
  -H "X-GitHub-Delivery: test-$(date +%s)" \
  -d "$PAYLOAD"
```

### Project Structure

```
server.ts                  # MCP server entry point — HTTP server, smee-client, reconciliation
lib/
  config.ts                # Configuration loader (.env file + environment variables)
  handler.ts               # Webhook handler pipeline (validate → dedup → filter → notify)
  webhook.ts               # GitHub webhook parsing, signature validation, deduplication
  notify.ts                # Notification formatting and sanitization
  reconcile.ts             # Startup reconciliation and async job enrichment
tests/
  webhook.test.ts          # Signature validation, event parsing, deduplication
  notify.test.ts           # Sanitization, formatting
  config.test.ts           # Config loading
  reconcile.test.ts        # Job fetching, reconciliation
  integration.test.ts      # Full HTTP pipeline end-to-end
  stdio-lifecycle.test.ts  # MCP stdio stability regression test
  fixtures/                # Sample GitHub webhook payloads
```

### Development with Codev

This project uses [Codev](https://github.com/cluesmith/codev) for AI-assisted development. Codev provides structured protocols for building software with AI agents, including multi-model consultation at every checkpoint.

Each feature follows the **three-document model**:
- **Specification** (`codev/specs/`) — What to build and why
- **Plan** (`codev/plans/`) — How to build it, in testable phases
- **Review** (`codev/reviews/`) — What was learned, deviations from plan, consultation feedback

The project's architectural knowledge lives in:
- **Architecture** (`codev/resources/arch.md`) — System design, data flow, components
- **Lessons Learned** (`codev/resources/lessons-learned.md`) — Accumulated insights from reviews

For larger contributions, PRs that include Codev artifacts (spec, plan, review) are significantly easier to integrate. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

See `CLAUDE.md` for Claude Code-specific instructions and `AGENTS.md` for cross-tool AI agent compatibility (Cursor, GitHub Copilot, etc.).

## Architecture

The plugin is structured as a pipeline with clear separation of concerns:

1. **Config** (`lib/config.ts`) — Loads settings from `~/.claude/channels/ci/.env` and environment variables. Environment variables take precedence.

2. **Webhook Parsing** (`lib/webhook.ts`) — Validates HMAC-SHA256 signatures, parses `workflow_run` events, manages deduplication with a bounded set (100 entries).

3. **Handler** (`lib/handler.ts`) — Orchestrates the pipeline: signature check, dedup, parse, repo filter, workflow filter, format, push. Returns HTTP responses.

4. **Notification** (`lib/notify.ts`) — Sanitizes all user-controlled input and formats channel notifications with structured metadata.

5. **Reconciliation** (`lib/reconcile.ts`) — On startup, checks configured branches for recent failures via `gh run list`. Also provides async job name enrichment via `gh api`.

6. **Server** (`server.ts`) — Wires everything together: starts the MCP server, HTTP server, smee-client subprocess, and delayed startup reconciliation.

## License

MIT License. See [LICENSE](LICENSE) for details.
