# CI Channel — LLM Installation Guide

Step-by-step instructions for an LLM agent to install and configure ci-channel.

## Prerequisites

- Node.js v20+
- `gh` CLI installed and authenticated
- Claude Code v2.1.80+ with channels support

## Step 1: Register the MCP server in the project you want to monitor

From the project directory you want to monitor:

```bash
cd /path/to/target-project
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel"]}'
```

`npx -y ci-channel` downloads and runs the [ci-channel npm package](https://www.npmjs.com/package/ci-channel) on first invocation — no local clone needed. Project scope means each project gets its own isolated smee channel and webhook.

## Step 2: Launch Claude Code once to trigger auto-provisioning

```bash
claude --dangerously-load-development-channels server:ci
```

On first launch, the plugin generates a webhook secret and provisions a smee.io relay URL, saving them to `~/.claude/channels/ci/state.json`. Exit Claude Code after startup completes.

## Step 3: Read the auto-provisioned credentials

```bash
cat ~/.claude/channels/ci/state.json
```

This returns JSON with `webhookSecret` and `smeeUrl` fields.

If `~/.claude/channels/ci/.env` exists with `WEBHOOK_SECRET` and `SMEE_URL` already set, use those values instead.

## Step 4: Create the GitHub webhook

Use the `gh` CLI to create the webhook programmatically. Replace `OWNER/REPO` with the target repository, and substitute the smee URL and secret from step 3:

```bash
gh api repos/OWNER/REPO/hooks --method POST --input - <<'EOF'
{
  "config": {
    "url": "SMEE_URL_FROM_STEP_3",
    "content_type": "json",
    "secret": "WEBHOOK_SECRET_FROM_STEP_3"
  },
  "events": ["workflow_run"],
  "active": true
}
EOF
```

Verify the webhook was created:

```bash
gh api repos/OWNER/REPO/hooks --jq '.[].config.url'
```

## Step 5: Relaunch Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:ci
```

The channel is now active. CI failure notifications will be pushed into the session automatically.

## GitLab CI variant

Replace step 1 with:

```bash
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel","--forge","gitlab","--repos","GROUP/PROJECT"]}'
```

For the webhook (step 4), use the GitLab API or UI:
- **URL**: smee URL from step 3
- **Secret token**: webhook secret from step 3
- **Trigger**: Pipeline events

Optional: Install `glab` CLI for reconciliation and job enrichment.

## Gitea Actions variant

Replace step 1 with:

```bash
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel","--forge","gitea","--gitea-url","https://YOUR_GITEA_INSTANCE","--repos","OWNER/REPO"]}'
```

Add a Gitea API token to `~/.claude/channels/ci/.env`:

```bash
echo 'GITEA_TOKEN=your-gitea-api-token' >> ~/.claude/channels/ci/.env
```

For the webhook (step 4), configure in Gitea UI:
- **Target URL**: smee URL from step 3
- **Secret**: webhook secret from step 3
- **Events**: Workflow runs

## Verification

After setup, you can verify the channel is working:

1. The `ci` MCP server should appear in `claude mcp list`
2. Trigger a CI failure (e.g., push a commit with a broken test)
3. A `<channel source="ci" ...>` notification should appear in the Claude Code session
