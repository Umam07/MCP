import fs from "node:fs";
import crypto from "node:crypto";

let pub = process.env.PUBLIC_URL;
if (!pub) {
  try {
    const envContent = fs.readFileSync(".env", "utf8");
    const m = envContent.match(/^PUBLIC_URL=(.+)$/m);
    if (m) pub = m[1].trim();
  } catch {}
}
if (!pub) {
  const pubBuf = fs.readFileSync("C:\\Users\\umam\\AppData\\Local\\Temp\\opencode\\cf.url");
  pub = (pubBuf[0] === 0xFF && pubBuf[1] === 0xFE ? pubBuf.toString("utf16le") : pubBuf.toString("utf8")).replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
}
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

const pr = await fetch(pub + "/.well-known/oauth-protected-resource").then(r => r.json());
ok("tunnel: protected-resource resource == PUBLIC_URL/mcp", pr.resource === pub + "/mcp");

const as = await fetch(pub + "/.well-known/oauth-authorization-server").then(r => r.json());
ok("tunnel: issuer == PUBLIC_URL", as.issuer === pub);

const reg = await fetch(pub + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "pubtest" }) }).then(async r => ({ s: r.status, j: await r.json() }));
ok("tunnel: DCR 201", reg.s === 201 && !!reg.j.client_id);

const ru = "https://claude.ai/api/mcp/auth_callback";
const v = crypto.randomBytes(32).toString("base64url");
const ch = crypto.createHash("sha256").update(v).digest("base64url");
const html = await fetch(`${pub}/authorize?` + new URLSearchParams({ client_id: reg.j.client_id, redirect_uri: ru, code_challenge: ch, state: "s", response_type: "code" })).then(r => r.text());
const t = (html.match(/name="ticket" value="([^"]+)"/) || [])[1];
ok("tunnel: consent page loads", !!t);

const g = await fetch(pub + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: t, passphrase }), redirect: "manual" });
ok("tunnel: authorize 302", g.status === 302);
const c = new URL(g.headers.get("location")).searchParams.get("code");

const tok = await fetch(pub + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id: reg.j.client_id, redirect_uri: ru, code_verifier: v }) }).then(r => r.json());
ok("tunnel: token issued", !!tok.access_token);

const call = await fetch(pub + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + tok.access_token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
const body = await call.text();
ok("tunnel: tools/list 200 with 5 tools", call.status === 200 && ["list_dir", "read_file", "search", "git_status", "git_diff"].every(n => body.includes(n)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
