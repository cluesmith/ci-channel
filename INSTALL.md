# CI Channel — LLM Installation Guide

Step-by-step instructions for an LLM agent to install and configure ci-channel.

## Prerequisites

- Node.js v20+
- `gh` CLI installed and authenticated
- Claude Code v2.1.80+ with channels support

## Step 1: Clone and install

```bash
git clone https://github.com/cluesmith/ci-channel.git
cd ci-channel
npm install
```

## Step 2: Register the MCP server

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts"],"cwd":"ABSOLUTE_PATH_TO_CI_CHANNEL"}'
```

Replace `ABSOLUTE_PATH_TO_CI_CHANNEL` with the absolute path where you cloned the repo (e.g., `/home/user/ci-channel`).

## Step 3: Read the auto-provisioned credentials

On first run, the plugin auto-generates a webhook secret and smee.io relay URL. These are saved to `~/.claude/channels/ci/state.json`. If the file doesn't exist yet, start Claude Code once with the channel flag to trigger provisioning:

```bash
claude --dangerously-load-development-channels server:ci
```

Then read the credentials:

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

## Step 5: Launch Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:ci
```

The channel is now active. CI failure notifications will be pushed into the session automatically.

## GitLab CI variant

Replace step 2 with:

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--forge","gitlab","--repos","GROUP/PROJECT"],"cwd":"ABSOLUTE_PATH_TO_CI_CHANNEL"}'
```

For the webhook (step 4), use the GitLab API or UI:
- **URL**: smee URL from step 3
- **Secret token**: webhook secret from step 3
- **Trigger**: Pipeline events

Optional: Install `glab` CLI for reconciliation and job enrichment.

## Gitea Actions variant

Replace step 2 with:

```bash
claude mcp add-json --scope user ci '{"command":"npx","args":["tsx","server.ts","--forge","gitea","--gitea-url","https://YOUR_GITEA_INSTANCE","--repos","OWNER/REPO"],"cwd":"ABSOLUTE_PATH_TO_CI_CHANNEL"}'
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
