#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./lib/config.js";
import { createWebhookHandler } from "./lib/handler.js";
import { runStartupReconciliation } from "./lib/reconcile.js";
import { bootstrap, fetchSmeeChannel, ensureSecretReal } from "./lib/bootstrap.js";
import { saveState } from "./lib/state.js";
import { pushNotification } from "./lib/notify.js";
import { githubForge } from "./lib/forges/github.js";
import { gitlabForge } from "./lib/forges/gitlab.js";
import { giteaForge } from "./lib/forges/gitea.js";
import type { Forge } from "./lib/forge.js";

if (process.argv[2] === "setup" || process.argv[2] === "remove") {
  const mod = await import("./lib/setup.js");
  await (process.argv[2] === "setup" ? mod.setup : mod.remove)(process.argv.slice(3));
  process.exit(0);
}
const initialConfig = loadConfig();

// Select forge implementation based on config
const forgeMap: Record<string, Forge> = {
  github: githubForge,
  gitlab: gitlabForge,
  gitea: giteaForge,
};

const forge = forgeMap[initialConfig.forge];
if (!forge) {
  throw new Error(
    `Forge "${initialConfig.forge}" is not yet implemented. Available: ${Object.keys(forgeMap).join(", ")}`
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
      "2. Use the run_url to investigate the failure details",
      "3. Check recent commits on that branch with `git log`",
      "4. Investigate and fix the failure if possible",
      "These are one-way alerts — no reply is expected through the channel.",
    ].join("\n"),
  }
);

await mcp.connect(new StdioServerTransport());

// Mutable config — bootstrap resolves the secret before webhooks are processed
let resolvedConfig: Config = initialConfig;

const handleWebhook = createWebhookHandler(
  // Use a getter so the handler always sees the resolved config
  new Proxy(initialConfig, { get: (_target, prop) => (resolvedConfig as any)[prop] }),
  mcp,
  forge,
);

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
      `Port ${initialConfig.port} already in use. Use --port to specify a different port, or use port 0 for auto-assignment.`
    );
  } else {
    console.error(`[ci-channel] HTTP server error: ${error.message}`);
  }
  process.exit(1);
});

httpServer.listen(initialConfig.port, "127.0.0.1", () => {
  const addr = httpServer.address() as { port: number };
  console.error(`[ci-channel] Listening on port ${addr.port}`);

  // Determine webhook target path — use /webhook/github for GitHub backward compat
  const webhookPath = initialConfig.forge === "github" ? "/webhook/github" : "/webhook";
  const localTarget = `http://127.0.0.1:${addr.port}${webhookPath}`;

  // Delay bootstrap and reconciliation to ensure MCP handshake completes first.
  // Writing to stdout before the initialize handshake corrupts the JSON-RPC stream.
  setTimeout(async () => {
    // Bootstrap: auto-provision secret and smee channel
    try {
      const result = await bootstrap(initialConfig, localTarget, {
        ensureSecret: ensureSecretReal,
        fetchSmeeChannel,
        persistState: saveState,
        startSmeeClient(source: string, target: string) {
          import("smee-client").then((mod) => {
            const SmeeClient = mod.default;
            const client = new SmeeClient({ source, target, logger: { info: () => {}, error: (...args: unknown[]) => console.error("[ci-channel] smee:", ...args) } });
            const events = client.start();
            console.error(`[ci-channel] smee-client started: ${source} → ${target}`);

            const cleanup = () => {
              try { events.close(); } catch { /* already closed */ }
            };
            process.on("exit", cleanup);
            process.on("SIGINT", () => { cleanup(); process.exit(0); });
            process.on("SIGTERM", () => { cleanup(); process.exit(0); });
          }).catch((err) => {
            console.error(`[ci-channel] Warning: smee-client not available: ${err}`);
          });
        },
        async pushNotification(content: string, meta: Record<string, string>) {
          await pushNotification(mcp, { content, meta });
        },
      });

      // Update resolved config with bootstrap results
      if (result.webhookSecret) {
        resolvedConfig = { ...initialConfig, webhookSecret: result.webhookSecret };
        if (result.smeeUrl) {
          resolvedConfig = { ...resolvedConfig, smeeUrl: result.smeeUrl };
        }
      }
    } catch (err) {
      console.error(`[ci-channel] Bootstrap failed: ${err}`);
    }

    // Startup reconciliation
    try {
      await runStartupReconciliation(mcp, resolvedConfig, forge);
    } catch (err) {
      console.error(`[ci-channel] Startup reconciliation failed: ${err}`);
    }
  }, 5000);
});

// Export for testing
export { mcp, resolvedConfig as config, httpServer as server };
