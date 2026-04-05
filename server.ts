#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./lib/config.js";
import { createWebhookHandler } from "./lib/handler.js";
import { runStartupReconciliation } from "./lib/reconcile.js";
import { bootstrap, fetchSmeeChannel, ensureSecretReal } from "./lib/bootstrap.js";
import { pushNotification } from "./lib/notify.js";
import { githubForge } from "./lib/forges/github.js";
import { gitlabForge } from "./lib/forges/gitlab.js";
import type { Forge } from "./lib/forge.js";

const config = loadConfig();

// Select forge implementation based on config
const forgeMap: Record<string, Forge> = {
  github: githubForge,
  gitlab: gitlabForge,
  // gitea added in later phase
};

const forge = forgeMap[config.forge];
if (!forge) {
  // This shouldn't happen — config validation catches invalid forge names.
  // But during development, new forges may not be registered yet.
  throw new Error(
    `Forge "${config.forge}" is not yet implemented. Available: ${Object.keys(forgeMap).join(", ")}`
  );
}

const mcp = new Server(
  { name: "ci", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "Events from the ci channel are CI/deploy failure alerts.",
      'Each event arrives as <channel source="ci" workflow="..." branch="..." run_url="..." ...>.',
      "When you receive a failure alert:",
      "1. Read the workflow name and branch to understand what failed",
      "2. Use the run_url to investigate (or run `gh run view <run_id>` for details)",
      "3. Check recent commits on that branch with `git log`",
      "4. Investigate and fix the failure if possible",
      "These are one-way alerts — no reply is expected through the channel.",
    ].join("\n"),
  }
);

await mcp.connect(new StdioServerTransport());

const handleWebhook = createWebhookHandler(config, mcp, forge);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      // Accept both /webhook and /webhook/github for backward compatibility
      if (req.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/webhook/github")) {
        const body = await readBody(req);

        // Build a Web Request from the Node.js IncomingMessage
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          } else if (Array.isArray(value)) {
            for (const v of value) {
              headers.append(key, v);
            }
          }
        }

        const webReq = new Request(url.href, { method: "POST", headers, body });
        const webRes = await handleWebhook(webReq);

        res.writeHead(webRes.status);
        res.end(await webRes.text());
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (err) {
      console.error(`[ci-channel] HTTP handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  }
);

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} already in use. Use --port to specify a different port, or use port 0 for auto-assignment.`
    );
  } else {
    console.error(`[ci-channel] HTTP server error: ${error.message}`);
  }
  process.exit(1);
});

httpServer.listen(config.port, "127.0.0.1", async () => {
  const addr = httpServer.address() as { port: number };
  console.error(`[ci-channel] Listening on port ${addr.port}`);

  // Determine webhook target path — use /webhook/github for GitHub backward compat
  const webhookPath = config.forge === "github" ? "/webhook/github" : "/webhook";
  const localTarget = `http://127.0.0.1:${addr.port}${webhookPath}`;

  // Bootstrap: auto-provision secret and smee channel
  try {
    const result = await bootstrap(config, localTarget, {
      ensureSecret: ensureSecretReal,
      fetchSmeeChannel,
      startSmeeClient(source: string, target: string) {
        // Dynamic import — smee-client is optional
        import("smee-client").then((mod) => {
          const SmeeClient = mod.default;
          const client = new SmeeClient({ source, target, logger: { info: () => {}, error: () => {} } });
          const events = client.start();

          const cleanup = () => {
            try { events.close(); } catch { /* already closed */ }
          };
          process.on("exit", cleanup);
          process.on("SIGINT", () => { cleanup(); process.exit(0); });
          process.on("SIGTERM", () => { cleanup(); process.exit(0); });
          process.stdin.on("close", () => { cleanup(); process.exit(0); });
        }).catch((err) => {
          console.error(`[ci-channel] Warning: smee-client not available: ${err}`);
        });
      },
      async pushNotification(content: string, meta: Record<string, string>) {
        await pushNotification(mcp, { content, meta });
      },
    });

    // Update config with resolved secret
    if (result.webhookSecret && !config.webhookSecret) {
      (config as any).webhookSecret = result.webhookSecret;
    }
  } catch (err) {
    console.error(`[ci-channel] Bootstrap failed: ${err}`);
  }

  // Delay startup reconciliation to ensure MCP handshake completes first.
  setTimeout(() => {
    runStartupReconciliation(mcp, config, forge).catch((err) => {
      console.error(`[ci-channel] Startup reconciliation failed: ${err}`);
    });
  }, 5000);
});

// Export for testing
export { mcp, config, httpServer as server };
