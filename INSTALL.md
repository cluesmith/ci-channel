# CI Channel — LLM Installation Guide

Step-by-step instructions for an LLM agent to install and configure ci-channel.

## Prerequisites

- Node.js v20.17.0+
- A forge-specific CLI or token:
  - **GitHub**: `gh` CLI installed and authenticated (`gh auth status`)
  - **GitLab**: `glab` CLI installed and authenticated (`glab auth status`)
  - **Gitea**: a `GITEA_TOKEN` with `write:repository` scope, exported in your shell or written to `<project-root>/.claude/channels/ci/.env`
- Claude Code v2.1.80+ with channels support

## Quick Path: `ci-channel setup` (recommended for all three forges)

One command from inside the project you want to monitor:

```bash
# GitHub (default)
cd /path/to/target-project
npx -y ci-channel setup --repo OWNER/REPO

# GitLab
npx -y ci-channel setup --forge gitlab --repo GROUP/PROJECT

# Gitea
npx -y ci-channel setup --forge gitea --gitea-url https://gitea.example.com --repo OWNER/REPO
```

That's the entire install. The command:

1. Walks up from the current directory to find the project root (nearest `.mcp.json` or `.git/`)
2. For Gitea: validates `GITEA_TOKEN` is set (fails fast before any state is written if missing)
3. Generates a webhook secret (if one is not already stored)
4. Provisions a smee.io relay URL (if one is not already stored)
5. Writes `<project-root>/.claude/channels/ci/state.json` with mode `0o600` (skipped if the file is already deep-equal to the desired state)
6. Creates or updates the forge webhook (`gh api` for GitHub, `glab api` for GitLab, `fetch` against the Gitea REST API for Gitea) — always-PATCH/PUT existing hooks so the secret matches our state
7. Adds `mcpServers.ci` to `<project-root>/.mcp.json` (creates the file if missing; leaves any existing `ci` entry alone so user customizations are preserved)
8. If `<project-root>/.codev/config.json` exists, appends the channel loader flag to `shell.architect` (once, idempotent)
9. Prints `Done. Launch Claude Code with \`claude --dangerously-load-development-channels server:ci\`.` and exits 0

Then launch Claude Code with the channel enabled:

```bash
claude --dangerously-load-development-channels server:ci
```

Re-running the setup command is idempotent on all three forges. If anything fails mid-way (e.g., `gh api` returns non-zero), fix the underlying problem and re-run — no state gets into an inconsistent position.

**Current limitations**:
- No `--yes`, `--dry-run`, `--rotate`, or `--smee-url` flags — running the command IS the confirmation. Edit `state.json` by hand if you need a specific smee channel.
- The installer requires a detectable project root; it does NOT fall back to `~/.claude/channels/ci/` the way the runtime plugin does.
- **GitLab**: for self-hosted GitLab, point `glab` at your instance (`glab auth login` / `GITLAB_URI`) before running setup. We don't take a `--gitlab-url` flag.
- **Gitea**: if `GITEA_TOKEN` is missing from both `process.env` and `<project-root>/.claude/channels/ci/.env`, the installer fails fast before touching `state.json` or smee.io.

## Manual Path: Step by step (advanced)

Use this flow if:
- You want to understand exactly what's happening under the hood
- The one-command flow failed and you're debugging
- You have non-standard requirements the one-command flow doesn't cover (custom smee channel, pre-existing webhook, shared state across projects, etc.)

### Step 1: Register the MCP server in the project you want to monitor

From the project directory you want to monitor:

```bash
cd /path/to/target-project
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel"]}'
```

`npx -y ci-channel` downloads and runs the [ci-channel npm package](https://www.npmjs.com/package/ci-channel) on first invocation — no local clone needed. Project scope means each project gets its own isolated smee channel and webhook.

> **Important — server name vs package name:** The `ci` in the command above is the **server key** used inside Claude Code. The package name is `ci-channel`, but the channel flag in step 2 uses the key: `server:ci`. These are intentionally different. Don't try `server:ci-channel` — it won't match.

> **Project-scoped servers need explicit approval.** After `claude mcp add-json --scope project`, the server is dormant until you either (a) approve it via `/mcp` inside a Claude Code session, or (b) add the key to `enabledMcpjsonServers` in `~/.claude.json`. Install can appear to succeed while the server silently stays unloaded. If unsure, use `--scope user` instead.

### Step 2: Launch Claude Code once to trigger auto-provisioning

```bash
claude --dangerously-load-development-channels server:ci
```

On first launch, the plugin generates a webhook secret and provisions a smee.io relay URL, saving them to `.claude/channels/ci/state.json`. Exit Claude Code after startup completes.

### Step 3: Read the auto-provisioned credentials

```bash
cat .claude/channels/ci/state.json
```

This returns JSON with `webhookSecret` and `smeeUrl` fields.

If `.claude/channels/ci/.env` exists with `WEBHOOK_SECRET` and `SMEE_URL` already set, use those values instead.

### Step 4: Create the GitHub webhook

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

### Step 5: Relaunch Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:ci
```

The channel is now active. CI failure notifications will be pushed into the session automatically.

### GitLab CI variant

Replace step 1 with:

```bash
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel","--forge","gitlab","--repos","GROUP/PROJECT"]}'
```

For the webhook (step 4), use the GitLab API or UI:
- **URL**: smee URL from step 3
- **Secret token**: webhook secret from step 3
- **Trigger**: Pipeline events

Optional: Install `glab` CLI for reconciliation and job enrichment.

### Gitea Actions variant

Replace step 1 with:

```bash
claude mcp add-json --scope project ci '{"command":"npx","args":["-y","ci-channel","--forge","gitea","--gitea-url","https://YOUR_GITEA_INSTANCE","--repos","OWNER/REPO"]}'
```

Add a Gitea API token to `.claude/channels/ci/.env`:

```bash
echo 'GITEA_TOKEN=your-gitea-api-token' >> .claude/channels/ci/.env
```

For the webhook (step 4), configure in Gitea UI:
- **Target URL**: smee URL from step 3
- **Secret**: webhook secret from step 3
- **Events**: Workflow runs

## Verification

After setup, verify the channel is working:

1. The `ci` MCP server should appear in `claude mcp list`
2. Trigger a CI failure (e.g., push a commit with a broken test)
3. A `<channel source="ci" ...>` notification should appear in the Claude Code session

## Troubleshooting

**`/mcp` shows `ci` as "failed" but debug logs show "Successfully connected"** — You forgot the channel flag. The MCP server connected fine, but without `--dangerously-load-development-channels server:ci`, Claude Code doesn't treat it as a channel. Relaunch with the flag.

**"Failed to reconnect to ci-channel"** — You're using the package name instead of the server key. The channel flag takes the key from your `.mcp.json` (which is `ci`), not the npm package name (`ci-channel`). Use `server:ci`.

**Install appears to succeed but no notifications arrive** — If you used `--scope project`, the server is dormant until approved. Run `claude mcp list` to confirm it shows `Connected`; if it's missing, approve it via `/mcp` inside a session, or re-register with `--scope user`.

**No `state.json` after first launch** — The plugin writes credentials only when bootstrap completes. Check stderr for `[ci-channel] Saved auto-provisioned state to state.json`. If you see `smee.io timed out` instead, your network may be blocking smee.io.

**`ci-channel setup` exits with "No project root found"** — The installer walks up from `process.cwd()` looking for `.mcp.json` or `.git/`. If neither is found in any ancestor directory, the installer refuses to guess. Run it from inside a real project (one with a git repo or an existing `.mcp.json`).

**`ci-channel setup` exits with a `gh` error** — The installer shells out to `gh api`. If `gh` is not installed, not on PATH, not authenticated, or lacks `admin:repo_hook` scope on your token, the error is surfaced verbatim. Run `gh auth status` to verify your session, and `gh auth refresh -s admin:repo_hook` if the scope is missing.
