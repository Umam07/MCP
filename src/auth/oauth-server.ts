import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import { loadConfig, isRedirectAllowed } from "../config.js";
import { oauthStore } from "./oauth-store.js";
import { log } from "../logger.js";

function resourceUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

export function mountOAuth(app: Express): void {
  const cfg = loadConfig();
  const resource = resourceUrl(cfg.publicUrl);
  const issuer = cfg.publicUrl.replace(/\/+$/, "");

  const authMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: false,
  };

  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["tools"],
    bearer_methods_supported: ["header"],
  };

  const sendProtected = (_req: Request, res: Response) => res.json(protectedResource);
  app.get("/.well-known/oauth-protected-resource", sendProtected);
  app.get("/.well-known/oauth-protected-resource/mcp", sendProtected);
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authMetadata));
  app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(authMetadata));
  app.get("/.well-known/openid-configuration", (_req, res) => res.json(authMetadata));
  app.get("/.well-known/openid-configuration/mcp", (_req, res) => res.json(authMetadata));

  // Dynamic Client Registration (RFC7591), public clients only.
  app.post("/register", (req: Request, res: Response) => {
    const body = req.body as { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string };
    const redirectUris = body.redirect_uris || [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_redirect_uri" });
      return;
    }
    for (const uri of redirectUris) {
      if (!isRedirectAllowed(uri, cfg)) {
        log.warn("DCR rejected redirect_uri", { uri });
        res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uri not allowed" });
        return;
      }
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "only public clients (none) are supported" });
      return;
    }
    const client = oauthStore.registerClient(body.client_name, redirectUris);
    log.info("DCR registered", { client_id: client.client_id });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // Authorize: GET renders consent, POST checks passphrase and issues code.
  app.get("/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, resource: resParam } = req.query as Record<string, string>;
    if (!client_id || !redirect_uri || !code_challenge) {
      res.status(400).send("missing client_id, redirect_uri, or code_challenge");
      return;
    }
    const client = oauthStore.getClient(client_id);
    if (!client) {
      res.status(400).send("unknown client_id; register via POST /register first");
      return;
    }
    if (!client.redirect_uris.includes(redirect_uri)) {
      log.warn("authorize rejected redirect_uri", { redirect_uri, client_id });
      res.status(400).send("redirect_uri mismatch");
      return;
    }
    if (!isRedirectAllowed(redirect_uri, cfg)) {
      log.warn("authorize rejected redirect_uri (allowlist)", { redirect_uri });
      res.status(400).send("redirect_uri not allowed");
      return;
    }
    const ticket = makeTicket({ client_id, redirect_uri, code_challenge, resource: resParam || resource, state: state || "" });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(consentPage(ticket, client.client_name || client_id, redirect_uri));
  });

  app.post("/authorize", (req: Request, res: Response) => {
    const body = req.body as { ticket?: string; passphrase?: string };
    const data = verifyTicket(body.ticket || "");
    if (!data) {
      res.status(400).send("invalid or expired ticket");
      return;
    }
    const input = (body.passphrase || "").trim();
    const expected = cfg.passphrase;
    const ok =
      input.length >= 1 &&
      expected.length >= 16 &&
      input.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(input), Buffer.from(expected));
    if (!ok) {
      log.warn("authorize bad passphrase", { client_id: data.client_id });
      res.status(401).send("wrong passphrase");
      return;
    }
    const code = oauthStore.issueCode(data.client_id, data.redirect_uri, data.code_challenge, data.resource);
    const url = new URL(data.redirect_uri);
    url.searchParams.set("code", code);
    if (data.state) url.searchParams.set("state", data.state);
    url.searchParams.set("iss", cfg.publicUrl);
    log.info("authorize granted", { client_id: data.client_id });
    res.redirect(302, url.toString());
  });

  // Token: authorization_code (with PKCE) and refresh_token.
  app.post("/token", (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;
    const grant = body.grant_type;
    try {
      if (grant === "authorization_code") {
        const { code, client_id, redirect_uri, code_verifier, resource: resParam } = body;
        if (!code || !client_id || !redirect_uri || !code_verifier) {
          res.status(400).json({ error: "invalid_request" });
          return;
        }
        oauthStore.consumeCode(code, client_id, redirect_uri, code_verifier, resParam || resource);
        const tokens = oauthStore.issueTokens(client_id, resParam || resource);
        res.json({ ...tokens, token_type: "Bearer", scope: "tools" });
        return;
      }
      if (grant === "refresh_token") {
        const { refresh_token, client_id, resource: resParam } = body;
        if (!refresh_token || !client_id) {
          res.status(400).json({ error: "invalid_request" });
          return;
        }
        const tokens = oauthStore.refreshTokens(refresh_token, client_id, resParam || resource);
        res.json({ ...tokens, token_type: "Bearer", scope: "tools" });
        return;
      }
      res.status(400).json({ error: "unsupported_grant_type" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "token failed";
      // RFC6749: expired/invalid refresh must be invalid_grant.
      const code = /refresh|code/.test(msg) ? "invalid_grant" : "invalid_request";
      log.warn("token failed", { reason: msg });
      res.status(400).json({ error: code, error_description: msg });
    }
  });

  app.post("/revoke", (req: Request, res: Response) => {
    const body = req.body as { token?: string };
    if (body.token) oauthStore.revoke(body.token);
    res.json({});
  });
}

function ticketSecret(): string {
  // Per-process HMAC key + passphrase binding; tickets expire in 10 min anyway.
  const cfg = loadConfig();
  return `bridge-ticket:${cfg.passphrase}`;
}

function makeTicket(data: { client_id: string; redirect_uri: string; code_challenge: string; resource: string; state: string }): string {
  const payload = JSON.stringify({ ...data, exp: Date.now() + 10 * 60_000 });
  const sig = crypto.createHmac("sha256", ticketSecret()).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + sig;
}

function verifyTicket(ticket: string): { client_id: string; redirect_uri: string; code_challenge: string; resource: string; state: string } | null {
  try {
    const [b64, sig] = ticket.split(".");
    const payload = Buffer.from(b64, "base64url").toString("utf8");
    const expected = crypto.createHmac("sha256", ticketSecret()).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(payload) as { exp: number; client_id: string; redirect_uri: string; code_challenge: string; resource: string; state: string };
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function consentPage(ticket: string, clientName: string, redirectUri: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Local Code Bridge — Authorize</title></head>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h1>Authorize local code access?</h1>
<p>Client <b>${escapeHtml(clientName)}</b> wants to access your local project via this bridge.</p>
<p>It will redirect to <code>${escapeHtml(redirectUri)}</code> after approval.</p>
<p>This grants read tools (milestone a) and later write tools only in edit/exec modes. The server never calls any LLM API.</p>
<form method="post" action="/authorize">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<label>Bridge passphrase:<br><input type="password" name="passphrase" autocomplete="off" style="width:100%;padding:8px"></label><br><br>
<button type="submit">Approve</button>
</form>
</body></html>`;
}
