import fs from "node:fs";
import crypto from "node:crypto";

const base = "http://127.0.0.1:3000";
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

// 1. DCR
const reg = await fetch(base + "/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "smoke" }),
}).then(r => r.json());
ok("DCR returns client_id", !!reg.client_id);
const redirect_uri = "https://claude.ai/api/mcp/auth_callback";

// 2. PKCE
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

// 3. GET /authorize -> parse ticket from consent HTML
const consentHtml = await fetch(`${base}/authorize?` + new URLSearchParams({
  client_id: reg.client_id, redirect_uri, code_challenge: challenge,
  code_challenge_method: "S256", state: "xyz", response_type: "code",
})).then(r => r.text());
const ticket = (consentHtml.match(/name="ticket" value="([^"]+)"/) || [])[1];
ok("consent page yields ticket", !!ticket);

// 4. wrong passphrase -> 401
const wrong = await fetch(base + "/authorize", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ticket, passphrase: "definitely-wrong" }),
});
ok("wrong passphrase rejected (401)", wrong.status === 401);

// 5. correct passphrase -> 302 with code
const grant = await fetch(base + "/authorize", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ticket, passphrase }), redirect: "manual",
});
const loc = new URL(grant.headers.get("location"));
const code = loc.searchParams.get("code");
ok("authorize redirects with code", grant.status === 302 && !!code);
ok("state echoed", loc.searchParams.get("state") === "xyz");

// 6. token exchange with PKCE
const tok = await fetch(base + "/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri, code_verifier: verifier }),
}).then(r => r.json());
ok("token issued", !!tok.access_token);
const access = tok.access_token;

// 7. code reuse must fail
const reuse = await fetch(base + "/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri, code_verifier: verifier }),
}).then(r => r.json());
ok("code single-use enforced", reuse.error === "invalid_grant");

// 8. authenticated MCP: initialize + tools/list + tools/call
async function rpc(body) {
  return fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + access },
    body: JSON.stringify(body),
  });
}
const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
ok("initialize 200", init.status === 200);
const initBody = await init.text();
ok("initialize names server", initBody.includes("local-code-bridge"));

const tlist = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const tlistBody = await tlist.text();
const names = ["list_dir", "read_file", "search", "git_status", "git_diff"].filter(n => tlistBody.includes(n));
ok("tools/list exposes 5 read tools", names.length === 5);

const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "notes.txt", start_line: 1, end_line: 4 } } });
const callBody = await call.text();
ok("read_file returns content", callBody.includes("SANDOX_NEEDLE_123"));

const trav = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "../package.json" } } });
const travBody = await trav.text();
ok("read_file blocks traversal", travBody.toLowerCase().includes("error") || travBody.includes("blocked"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
