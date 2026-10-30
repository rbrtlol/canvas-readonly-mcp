// Streamable HTTP transport (stateless), for remote clients such as claude.ai custom connectors.

import express from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApp } from "./app.js";
import { Config } from "./config.js";
import { log } from "./log.js";

export async function runHttp(config: Config) {
  const app = await createApp(config);
  const secret = Buffer.from(config.MCP_SECRET!);

  const secretMatches = (candidate: string | undefined): boolean => {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    return a.length === secret.length && timingSafeEqual(a, secret);
  };

  const http = express();
  http.disable("x-powered-by");
  http.use(express.json({ limit: "1mb" }));

  http.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Auth: either the secret is the last path segment (/mcp/<secret>, for claude.ai custom
  // connectors, which take a URL) or sent as "Authorization: Bearer <secret>" to /mcp.
  async function handleMcp(req: express.Request, res: express.Response) {
    const fromPath = typeof req.params.secret === "string" ? req.params.secret : undefined;
    const auth = req.headers.authorization;
    const fromHeader = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!secretMatches(fromPath) && !secretMatches(fromHeader)) {
      res.status(404).json({ error: "not found" });
      return;
    }

    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream, no sessions to delete.
      res.status(405).set("Allow", "POST").json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
      return;
    }

    const server = app.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  }

  http.all("/mcp", handleMcp);
  http.all("/mcp/:secret", handleMcp);

  app.snapshots?.startScheduler();

  http.listen(config.PORT, config.HOST, () => {
    log(`canvas-readonly-mcp listening on http://${config.HOST}:${config.PORT} (Canvas: ${config.CANVAS_BASE_URL})`);
  });
}
