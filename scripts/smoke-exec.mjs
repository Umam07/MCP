import fs from "node:fs";
import crypto from "node:crypto";
const base = "http://127.0.0.1:3000";
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

const reg = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "e" }) }).then(r => r.json());
const ru = "https://claude.ai/api/mcp/auth_callback";
const v = crypto.randomBytes(32).toString("base64url");
const ch = crypto.createHash("sha256").update(v).digest("base64url");
const html = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: ru, code_challenge: ch, state: "s", response_type: "code" })).then(r => r.text());
const t = html.match(/name="ticket" value="([^"]+)"/)[1];
const g = await fetch(base + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: t, passphrase }), redirect: "manual" });
const c = new URL(g.headers.get("location")).searchParams.get("code");
const tok = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id: reg.client_id, redirect_uri: ru, code_verifier: v }) }).then(r => r.json());
const A = "Bearer " + tok.access_token;

async function call(name, args) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: A }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return r.text();
}

const tl = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: A }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) }).then(r => r.text());
ok("tools/list includes run_script (exec mode)", tl.includes("run_script"));

const run = await call("run_script", { name: "check" });
ok("run_script check exits 0 with sandbox-ok", run.includes("exit=0") && run.includes("sandbox-ok"));

const unk = await call("run_script", { name: "rm -rf /" });
ok("free-form command rejected", unk.toLowerCase().includes("error") && unk.includes("unknown script"));

const bad = await call("run_script", { name: "check", path: "../.." });
ok("escape cwd blocked", bad.toLowerCase().includes("error"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
