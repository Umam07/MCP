import fs from "node:fs";
import crypto from "node:crypto";
const base = "http://127.0.0.1:3000";
const passphrase = fs.readFileSync(".bridge/passphrase.txt", "utf8").trim();
let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? "PASS " : "FAIL ") + n); c ? pass++ : fail++; };

// fresh client + token
const reg = await fetch(base + "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "smoke2" }) }).then(r => r.json());
const redirect_uri = "https://claude.ai/api/mcp/auth_callback";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const html = await fetch(`${base}/authorize?` + new URLSearchParams({ client_id: reg.client_id, redirect_uri, code_challenge: challenge, state: "s", response_type: "code" })).then(r => r.text());
const ticket = html.match(/name="ticket" value="([^"]+)"/)[1];
const grant = await fetch(base + "/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket, passphrase }), redirect: "manual" });
const code = new URL(grant.headers.get("location")).searchParams.get("code");
const tok = await fetch(base + "/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri, code_verifier: verifier }) }).then(r => r.json());
const access = tok.access_token;

async function call(name, args) {
  const r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + access }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  return r.text();
}

// search
const s = await call("search", { pattern: "SANDOX_NEEDLE_123", glob: "*.txt" });
ok("search finds needle in notes.txt", s.includes("notes.txt:3"));

// list_dir
const l = await call("list_dir", { path: ".", depth: 2 });
ok("list_dir lists src dir", l.includes("DIR") && l.includes("src"));

// git_status via MCP
const gs = await call("git_status", { path: "." });
ok("git_status returns branch line", gs.includes("##"));

// git diff assertions need a dirty tree; make one deterministically, then restore.
const notesPath = "sandbox-repo/notes.txt";
const notesOrig = fs.readFileSync(notesPath, "utf8");
fs.appendFileSync(notesPath, "tmp-smoke2-marker\n");
const gd = await call("git_diff", { path: ".", stat_only: true });
ok("git_diff stat_only has no patch body", gd.includes("file changed") && !gd.includes("@@"));
ok("git_diff full shows patch body", (await call("git_diff", { path: "." })).includes("@@"));
fs.writeFileSync(notesPath, notesOrig);
const gdClean = await call("git_diff", { path: "." });
ok("git_diff clean after restore", gdClean.includes("no diff"));

// git arg injection through tool must be blocked by fixed argv (path only)
const inj = await call("git_status", { path: ".; rm -rf" });
ok("git_status rejects metachar path", inj.toLowerCase().includes("error") || inj.includes("not allowed"));

// method guards
const g = await fetch(base + "/mcp", { headers: { Authorization: "Bearer " + access } });
ok("GET /mcp -> 405", g.status === 405);
const d = await fetch(base + "/mcp", { method: "DELETE", headers: { Authorization: "Bearer " + access } });
ok("DELETE /mcp -> 405", d.status === 405);

// bad token
const bt = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer garbage" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
ok("bad token -> 401", bt.status === 401);

// origin validation
const badOrigin = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + access, Origin: "https://evil.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
ok("cross-origin -> 403", badOrigin.status === 403);

// audit log: secrets must be redacted
const audit = fs.existsSync(".bridge/audit.log") ? fs.readFileSync(".bridge/audit.log", "utf8") : "";
ok("audit log exists", audit.length > 0);
ok("audit log never contains passphrase", !audit.includes(passphrase));
ok("audit log never contains access token", !audit.includes(access));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
