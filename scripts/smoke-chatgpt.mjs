import fs from "node:fs";
import crypto from "node:crypto";
const base = "http://127.0.0.1:3000";
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

// ChatGPT's known callback shapes (the bare-domain /connector/oauth/<id> is what it actually sends).
const callbacks = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/FyLoH2Z3BsfH",
  "https://example-123.chatgpt.com/connector/oauth/callback",
];

for (const ru of callbacks) {
  const reg = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [ru], client_name: "chatgpt-test" }) }).then(async r => ({ s: r.status, j: await r.json() }));
  ok(`DCR accepts ${ru}`, reg.s === 201 && !!reg.j.client_id);
  if (!reg.j.client_id) continue;
  const v = crypto.randomBytes(32).toString("base64url");
  const ch = crypto.createHash("sha256").update(v).digest("base64url");
  const html = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: reg.j.client_id, redirect_uri: ru, code_challenge: ch, state: "s", response_type: "code" })).then(r => r.text());
  const t = (html.match(/name="ticket" value="([^"]+)"/) || [])[1];
  ok(`consent for ${ru}`, !!t);
  const g = await fetch(base + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: t, passphrase }), redirect: "manual" });
  const loc = g.headers.get("location") || "";
  ok(`authorize redirects to ChatGPT callback`, g.status === 302 && loc.startsWith(ru) && loc.includes("code="));
  const c = new URL(loc).searchParams.get("code");
  const tok = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id: reg.j.client_id, redirect_uri: ru, code_verifier: v }) }).then(r => r.json());
  ok(`token issued for ChatGPT client`, !!tok.access_token);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
