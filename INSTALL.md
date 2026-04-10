# CI Channel — LLM Installation Guide

Step-by-step instructions for an LLM agent to install and configure ci-channel.

## Prerequisites

- Node.js v20.17.0 or later (required by `@inquirer/prompts` transitive deps)
- `gh` CLI installed and authenticated with the `admin:repo_hook` scope (for the recommended `setup` subcommand)
- Claude Code v2.1.80+ with channels support

## Recommended: `ci-channel setup` (GitHub only)

For GitHub repos, a single command replaces the entire manual flow below:

```bash
cd /path/to/target-project
npx ci-channel setup --repo OWNER/REPO --yes
```

This:

1. Walks up from `cwd` to find the project root (`.mcp.json` or `.git/`).
2. Provisions a fresh smee.io channel and generates a 256-bit webhook secret.
3. Writes `<project-root>/.claude/channels/ci/state.json` with mode `0o600`.
4. Creates the GitHub webhook via `gh api repos/OWNER/REPO/hooks POST` (subscribed to `workflow_run`).
5. Updates `<project-root>/.mcp.json` to register the `ci` MCP server (idempotent — no duplicate entries).
6. Prints the next-steps guidance, including the `claude --dangerously-load-development-channels server:ci` command to launch.

Flag summary:

| Flag | Purpose |
|------|---------|
| `--repo OWNER/REPO` | Target repository (required for GitHub) |
| `--yes`, `-y` | Skip all confirmation prompts (agents + scripts) |
| `--dry-run` | Print every planned action without executing — no network mutations, no file writes |
| `--smee-url URL` | Reuse an existing smee.io channel instead of provisioning a new one |
| `--help`, `-h` | Show full help and exit |

Idempotency: re-running `setup` on an already-configured project is safe. The installer detects existing `state.json`, skips creating a duplicate webhook, and leaves `.mcp.json` alone if the `ci` entry is already present.

**GitLab / Gitea note**: The `setup` subcommand only supports GitHub in v1. The MCP server itself supports all three forges — for GitLab or Gitea installs, follow the manual flow in the next section.

### Verification

After `setup` completes, launch Claude Code with the channel flag:

```bash
claude --dangerously-load-development-channels server:ci
```

The `ci` MCP server should appear in `claude mcp list`. Trigger a CI failure (push a commit with a broken test) and a `<channel source="ci" ...>` notification should appear in your session.

### `setup` troubleshooting

- **`gh CLI not found`** — Install from https://cli.github.com/ and run `gh auth login`.
- **`gh api failed (exit 1): HTTP 404: Not Found`** — The repo doesn't exist, your `gh` token lacks access, or you don't have admin on the repo.
- **`gh api failed (exit 1): HTTP 403: Resource not accessible`** — Your `gh` token needs the `admin:repo_hook` scope. Re-run `gh auth login --scopes admin:repo_hook`.
- **`Could not locate project root`** — Run `setup` from inside a directory that contains (or is nested under) a `.git/` or `.mcp.json`.
- **`stdin is not a TTY; pass --yes`** — Running non-interactively (e.g., in CI or piped stdin) requires `--yes` to skip confirmation prompts.
- **`.mcp.json is not valid JSON`** — The file exists but has invalid JSON syntax. Fix it manually and re-run `setup`.
- **`.mcp.json has invalid mcpServers`** — The file's `mcpServers` key is not an object. Fix it manually and re-run `setup`.
- **`Warning: .claude/channels/ci/ is not in .gitignore`** — The installer writes a secret to `state.json`; add `.claude/channels/ci/` to your `.gitignore` before committing.

---

## Manual install (advanced / troubleshooting / GitLab / Gitea)

Use this flow if you need GitLab/Gitea, if `gh` isn't available, or if you want fine-grained control over the setup.

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

Add a Gitea API token to `.claude/channels/ci/.env`:

```bash
echo 'GITEA_TOKEN=your-gitea-api-token' >> .claude/channels/ci/.env
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

## Troubleshooting

**`/mcp` shows `ci` as "failed" but debug logs show "Successfully connected"** — You forgot the channel flag. The MCP server connected fine, but without `--dangerously-load-development-channels server:ci`, Claude Code doesn't treat it as a channel. Relaunch with the flag.

**"Failed to reconnect to ci-channel"** — You're using the package name instead of the server key. The channel flag takes the key from your `.mcp.json` (which is `ci`), not the npm package name (`ci-channel`). Use `server:ci`.

**Install appears to succeed but no notifications arrive** — If you used `--scope project`, the server is dormant until approved. Run `claude mcp list` to confirm it shows `Connected`; if it's missing, approve it via `/mcp` inside a session, or re-register with `--scope user`.

**No `state.json` after first launch** — The plugin writes credentials only when bootstrap completes. Check stderr for `[ci-channel] Saved auto-provisioned state to state.json`. If you see `smee.io timed out` instead, your network may be blocking smee.io.
