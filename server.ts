#!/usr/bin/env node
import { spawn } from "node:child_process";
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

const config = loadConfig();

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

const handleWebhook = createWebhookHandler(config, mcp);

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
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);

      if (req.method === "POST" && url.pathname === "/webhook/github") {
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
      `Port ${config.port} already in use. Set PORT in ~/.claude/channels/ci/.env or as an environment variable.`
    );
    process.exit(1);
  }
  throw error;
});

httpServer.listen(config.port, "127.0.0.1", () => {
  const addr = httpServer.address() as { port: number };
  console.error(`[ci-channel] Listening on port ${addr.port}`);
});

// Spawn smee-client if SMEE_URL is configured
if (config.smeeUrl) {
  const smeeProc = spawn(
    "npx",
    [
      "smee-client",
      "-u",
      config.smeeUrl,
      "-t",
      `http://127.0.0.1:${config.port}/webhook/github`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );

  const killSmee = () => {
    try {
      smeeProc.kill();
    } catch {
      /* already exited */
    }
  };
  process.on("exit", killSmee);
  process.on("SIGINT", () => {
    killSmee();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killSmee();
    process.exit(0);
  });
  process.stdin.on("close", () => {
    killSmee();
    process.exit(0);
  });
}

// Delay startup reconciliation to ensure MCP handshake completes first.
// Writing to stdout before the initialize handshake corrupts the JSON-RPC stream.
setTimeout(() => {
  runStartupReconciliation(mcp, config).catch((err) => {
    console.error(`[ci-channel] Startup reconciliation failed: ${err}`);
  });
}, 5000);

// Export for testing
export { mcp, config, httpServer as server };
