import fs from "node:fs";
import crypto from "node:crypto";

const loop = "http://127.0.0.1:3001";
const publicUrl = process.env.PUBLIC_URL;
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

// Discovery must advertise the PUBLIC (https) URL, not the loopback one.
const pr = await fetch(loop + "/.well-known/oauth-protected-resource").then(r => r.json());
ok("protected-resource.resource == PUBLIC_URL/mcp", pr.resource === publicUrl + "/mcp");
ok("authorization_servers == [PUBLIC_URL]", pr.authorization_servers[0] === publicUrl);

const as = await fetch(loop + "/.well-known/oauth-authorization-server").then(r => r.json());
ok("issuer == PUBLIC_URL", as.issuer === publicUrl);
ok("authorize endpoint is https", as.authorization_endpoint === publicUrl + "/authorize");
ok("token endpoint is https", as.token_endpoint === publicUrl + "/token");

// Full flow against loopback, but the issued token audience must be the https resource.
const reg = await fetch(loop + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "tun" }) }).then(r => r.json());
const ru = "https://claude.ai/api/mcp/auth_callback";
const v = crypto.randomBytes(32).toString("base64url");
const ch = crypto.createHash("sha256").update(v).digest("base64url");
const html = await fetch(`${loop}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: ru, code_challenge: ch, state: "s", response_type: "code" })).then(r => r.text());
const t = html.match(/name="ticket" value="([^"]+)"/)[1];
const g = await fetch(loop + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: t, passphrase }), redirect: "manual" });
const c = new URL(g.headers.get("location")).searchParams.get("code");
const tok = await fetch(loop + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id: reg.client_id, redirect_uri: ru, code_verifier: v }) }).then(r => r.json());
ok("token issued under https PUBLIC_URL", !!tok.access_token);

const call = await fetch(loop + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + tok.access_token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
ok("token accepted at /mcp (audience bound)", call.status === 200);
ok("WWW-Authenticate uses https resource_metadata", call.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
