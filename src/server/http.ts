import express from "express";
import { loadConfig } from "../config.js";
import { mountOAuth } from "../auth/oauth-server.js";
import { oauthStore } from "../auth/oauth-store.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "../logger.js";

export function buildApp(): express.Express {
  const cfg = loadConfig();
  const app = express();
  app.set("trust proxy", false);
  app.use(express.json({ limit: "8mb" }));
  app.use(express.urlencoded({ extended: false, limit: "8mb" }));

  app.use(( _req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION, mode: cfg.mode });
  });

  mountOAuth(app);

  const resource = `${cfg.publicUrl.replace(/\/+$/, "")}/mcp`;
  const challenge = `Bearer resource_metadata="${cfg.publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource"`;

  app.post("/mcp", async (req, res) => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !oauthStore.verifyAccess(token, resource)) {
      res.setHeader("WWW-Authenticate", challenge);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: valid Bearer token required" }, id: null });
      return;
    }
    // Origin validation (DNS rebinding defense).
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      try {
        const o = new URL(origin);
        const p = new URL(cfg.publicUrl);
        const local = new Set(["127.0.0.1", "localhost"]);
        const ok = o.host === p.host || (local.has(o.hostname) && local.has(p.hostname));
        if (!ok) {
          res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: "bad Origin" }, id: null });
          return;
        }
      } catch {
        res.status(403).json({ jsonrpc: "2.0", error: { code: -32001, message: "bad Origin" }, id: null });
        return;
      }
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error("mcp request failed", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Stateless endpoint; use POST." }, id: null });
  });
  app.delete("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Stateless endpoint; use POST." }, id: null });
  });

  return app;
}
