import fs from "node:fs";
import crypto from "node:crypto";
const base = "http://127.0.0.1:3000";
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

const reg = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "w" }) }).then(r => r.json());
const ru = "https://claude.ai/api/mcp/auth_callback";
const v = crypto.randomBytes(32).toString("base64url");
const ch = crypto.createHash("sha256").update(v).digest("base64url");
const html = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri: ru, code_challenge: ch, state: "s", response_type: "code" })).then(r => r.text());
const t = html.match(/name="ticket" value="([^"]+)"/)[1];
const g = await fetch(base + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: t, passphrase }), redirect: "manual" });
const c = new URL(g.headers.get("location")).searchParams.get("code");
const tok = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id: reg.client_id, redirect_uri: ru, code_verifier: v }) }).then(r => r.json());
const A = "Bearer " + tok.access_token;

// Start clean (stale scratch from an interrupted run must not affect results).
try { fs.rmSync("sandbox-repo/scratch-d.txt", { force: true }); } catch { /* ignore */ }

async function call(name, args) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: A }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return r.text();
}

const tl = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: A }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) }).then(r => r.text());
ok("tools/list includes edit_file + write_file", tl.includes("edit_file") && tl.includes("write_file"));

// write new scratch file
const w = await call("write_file", { path: "scratch-d.txt", content: "alpha one\nalpha two\nbeta\n" });
ok("write_file creates + reports", w.includes("created") && w.includes("scratch-d.txt"));

// edit it
const e = await call("edit_file", { path: "scratch-d.txt", old_string: "alpha two", new_string: "alpha 2" });
ok("edit_file returns diff + backup", e.includes("-alpha two") && e.includes("+alpha 2") && e.includes("backup"));

// verify via read
const rd = await call("read_file", { path: "scratch-d.txt" });
ok("edited content visible", rd.includes("alpha 2"));

// ambiguous edit must fail safely (no write)
const amb = await call("edit_file", { path: "scratch-d.txt", old_string: "alpha", new_string: "X" });
ok("ambiguous edit rejected", amb.toLowerCase().includes("error") && amb.includes("multiple"));

// .env blocked
const sec = await call("write_file", { path: ".env", content: "x=1" });
ok("write_file blocks secrets", sec.toLowerCase().includes("error") || sec.includes("blocked"));

// traversal blocked
const tr = await call("edit_file", { path: "../package.json", old_string: "a", new_string: "b" });
ok("edit_file blocks traversal", tr.toLowerCase().includes("error") || tr.includes("blocked"));

// git sees the scratch as untracked
const gs = await call("git_status", { path: "." });
ok("git_status shows scratch untracked", gs.includes("scratch-d.txt"));

// Leave the sandbox pristine for repeatable runs.
try { fs.rmSync("sandbox-repo/scratch-d.txt", { force: true }); } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
