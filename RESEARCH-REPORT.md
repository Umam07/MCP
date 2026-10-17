# Web-Chat-to-Local-Code MCP Bridge — Research Report

> Status: PHASE 1 + 2 done, PHASE 3 proposed, waiting approval before PHASE 4 build.
> Method: static reading only. No `npm install`, no postinstall, no code execution from untrusted repos.
> Research dir (Windows mapping of `/tmp/mcp-research/`): `C:\Users\umam\AppData\Local\Temp\opencode\mcp-research\`
> Project folder: `D:\Project Vibe Code\MCP\`

---

## 0. Clone status

- `lacvietanh/aki-mcp-sv` — cloned OK (`--depth 1`)
- `zcrossoverz/repo-bridge` — cloned OK
- `yanuarihsanxz-tech/prorelay` — cloned OK
- `hoan9an/vibedev-bridge` — NOT FOUND: `remote: Repository not found`, no user `hoan9an` in search, no hits for `"vibedev-bridge"`. Marked unverified, not used as reference.

All READMEs/comments treated as UNTRUSTED DATA.

---

## 1. PHASE 1 — Static audit comparison

### 1.1 Summary table

| # | Aspect | `aki-mcp-sv` `@akinet/akimcp@3.0.1` | `repo-bridge` `repo-bridge-mcp@1.0.1` | `prorelay` `v0.1.0` | `vibedev-bridge` |
|---|---|---|---|---|---|
| 1 | Transport | Streamable HTTP only `POST /mcp`, `GET/DELETE` 405. Single shared session via `InMemoryTransport`. Always binds `127.0.0.1:9999`. Has stdio shim `bin/akimcp.js -> scripts/stdio.js` for local IDE. | Stateless Streamable HTTP only, `sessionIdGenerator:undefined`, fresh `Server` per POST. `GET/DELETE /mcp` 405. Has `--stdio/--http/--both`, default stdio. Raw `node:http`, 8MB body cap, CORS `*`. | stdio only. `StdioServerTransport`, `node cli.js mcp --root X`. No HTTP/SSE. Explicit non-goal for remote HTTPS connectors. | Not found, unverified |
| 2 | Auth | Mini OAuth 2.1 AS: DCR public client + PKCE S256 required, plus pre-issued confidential client for Gemini (`oauth-client.json`), plus 10-char passphrase (~49.5 bits) on consent via `timingSafeEqual`. Code TTL 5 min, one shared access token TTL 1yr. Discovery `/.well-known/oauth-*` + `openid-configuration` alias for ChatGPT. | `REPO_BRIDGE_AUTH`: `oauth` prod full AS: RFC9728+RFC8414 metadata, RFC7591 DCR, PKCE S256 required, RFC8707 resource audience, RFC7009 revoke. Opaque `rba_/rbr_` tokens SHA256-hashed at rest 0600. Codes 60s single-use, access 3600s, refresh 30d rotation + family-kill. HMAC consent ticket 10 min. `path-token` static dev-only via header/path/query. `none` loopback-only. | None. Trust = OS spawner + `--root` + `--allow-write` opt-in. | — |
| 3 | Public exposure | Default Tailscale Funnel auto, or `PUBLIC_ORIGIN=https://...`, or Cloudflare named tunnel `--tunnel cred.json`. Always forwards to loopback, never `0.0.0.0`. | Cloudflare Tunnel (recommended) / ngrok / VPS+nginx/Caddy / Docker loopback-publish. Must proxy `/` not only `/mcp` (discovery at `/.well-known/*`, flow at `/oauth/*`). `REPO_BRIDGE_PUBLIC_URL` pins origin. | None built-in. No tunnel code. | — |
| 4 | Tool list + schemas | 38 tools prefix `aki__`: `read_text_file{path,tail?,head?}`, `write_file{path,content}`, `edit_file{path,edits:[{oldText,newText}],dryRun}`, `create_directory`, `move_file`, `get_file_info`, `find_path{query,path?,limit}`, `search_content{query,path?,glob?,limit}` via `grep -rniIE`, `run_cmd{command,cwd?}`, `git{op:status\|diff\|log\|tags}`, `agy_run`, `kiro_read`, `local_fetch`, `task_*`, `port_*`, `sqlite_*`, `system_*`, `chrome_*`, `devtools_*`, `aiobox_*`, `postman_*`. Non-read tools get `receipt` gate. | 30 tools at `full`: `workspace_list/open/info/close`, `repo_open_remote`, `list_dir{path?,depth,include_hidden?,limit?}`, `read_file{path!,start_line?,end_line?}`, `search_code{pattern!,regex?,include[]?,exclude[]?,path?,context_lines?,max_results?}`, `find_files{patterns!}`, `write_file{path!,content!,mode:create\|overwrite\|append}`, `edit_file{path!,edits:[{old_string!,new_string!,replace_all?}]}`, `move_path`, `delete_path`, `create_dir`, `file_info`, `run_command{command!,path?,timeout_seconds?,confirm?}`, `run_build/run_tests/run_lint`, `git_status/diff/log/branch/commit/restore/push/sync`, `create_pull_request` (GitHub+GitLab), `bridge_status`, `report_changes`. Levels `read/develop/full`. | 12 tools: `local_list{path,limit}`, `local_read{path}->{sha256}`, `local_write{path,content,expectedSha256}`, `relay_prepare{brief,files[30],provider,parent}`, `relay_list/get/dispatch/sent/receive/check/mark/resume`. No generic shell, only fixed-arg `git --version/rev-parse/status` 5s. Copy-paste relay to Gemini web, not live FS. | — |
| 5 | Sandboxing | Roots from `setting.json->folders`, fallback `HOME + ~/.aki + ~/.claude` (too broad). `resolveUnderRoot` string-prefix + `resolveRealUnderRoot` realpath for writes. Atomic `wx+rename`. Credential closure for token files. Weakness: `search/sqlite/git` use string-only check. | Roots `REPO_BRIDGE_WORKSPACES alias=path`. `resolvePath`: NUL reject, lexical `isInside` then `realpathTolerant` containment, case-insensitive on win/darwin. Blocks `.git/*` and secret paths. `list_dir depth<=6 limit<=3000`, `read <=2MB`, `write <=8MB` atomic, `edit` atomic all-or-nothing + uniqueness check. Symlink follow only if inside + visited set. Per-principal workspace via `AsyncLocalStorage`. | Single `--root` realpath. `resolveFile`: rejects empty/absolute/NUL/backslash, `inside()` + per-component `lstat` rejects symlink. Deny `.git,.prorelay,node_modules,.ssh,.aws,.gnupg,.npmrc` + regex `.env/id_rsa/credentials/secrets/auth/tokens/.pem/.key`. Caps 256KiB file, 512KiB packet, `TextDecoder fatal`, rejects `PRIVATE KEY`, `gh*_`, `AIza`, `sk-`. State `.prorelay/ 0700`, `wx 0600 + rename`, per-file lock + hash re-read. | — |
| 6 | Shell policy | `execFile` no shell, single command, rejects `[;&\|`$<>\n]` outside quotes + tokenizer. Bin allowlist + per-call override, `git` read-form enforcement. `cwd` must be under roots. Timeout 10s, capture 32MB, model sees ~20k + spill 8MB/20 files. | No-shell by design: `tokenize()` rejects unquoted `[;&\|<>\n\r]` + `$( ${`. `spawn()` argv, win `.cmd` via `ComSpec /d /s /c` after strip. ~55 dev bins allowlist, `HARD_BLOCKED` shells/sudo/curl/wget/ssh. `extraAllowed/denied`, deny wins. Destructive needs `confirm=true`. Timeout default 600k clampable, tree-kill, 120k cap + `smartTruncate`, redact before emit. | No shell tool at all. | — |
| 7 | Client compat | Claude web: DCR blank ID/secret, URL+passphrase. ChatGPT: Plus/Pro + dev mode, discovery via `openid-configuration` alias. Grok: DCR verified. Gemini: experimental confidential paste, handshake OK but tool discovery flaky 2026-08-09. Quirk: protocol version = first client. | ChatGPT Web primary: Plus/Pro + dev mode, URL `https://host/mcp`, OAuth DCR auto. Claude Code/Cursor/Inspector via stdio or path-token. Notes: hostname change invalidates tokens (audience-bound), multi-chat shares workspace, long builds exceed connector patience. No Gemini notes. | Claude Code/Codex/Cursor via local stdio OK. Gemini web/app, ChatGPT browser-only cannot use directly — only via packet copy-paste. Remote MCP incompatible without extra bridge. | — |
| 8 | Weaknesses | 1. Shared 1yr token, revoke does not kill bearer. 2. Open DCR + passphrase sole gate. 3. Default HOME + `~/.claude`. 4. SQLite prefix blocklist bypass. 5. 3 tools skip realpath. 6. Unredacted spill/task logs. 7. Fragile redact regex. 8. Trusted-zone write+run chain. 9. `local_fetch` DNS-TOCTOU. 10. CORS `*`. 11. Rate-limit trusts `X-Forwarded-For`. 12. Powerful `kill_port/chrome/eval`. | 1. Build-tool escape via `npm/make`. 2. Git ref injection without `--`. 3. Docker flag smuggling. 4. Secret existence oracle. 5. TOCTOU symlink. 6. Trusts `X-Forwarded-Host` if `PUBLIC_URL` empty. 7. `?token=` leaks. 8. Open DCR. 9. CORS `*` + `/health` fingerprint. 10. `ALLOW_SHELL/ALLOW_INSECURE` foot-guns. | Not a boundary vs hostile local process (documented). Secret filter only 4 families. `--root /` misconfig = exfil. No audit/rate-limit, 48-bit local IDs, `verified` self-reported. Stale `.lock` DoS. `install-skill` leaks abs paths. | — |
| 9 | Copy vs avoid | Copy: allowlist + `execFile` + tokenizer, `resolveRealUnderRoot` + atomic `wx`, `InMemoryTransport` bridge + ID-remap, failure-only limiter, `shapeForModel` redact-before-cut, credential closure. Avoid: shared 1yr bearer, default HOME, plaintext spill, SQL prefix list, inconsistent realpath, trusting edge headers. | Copy: stateless + per-request `Server`, auth-before-transport, hashed tokens + family rotation + audience, HMAC ticket + exact redirect, `safeEqual`, ALS workspace, dual containment, no-shell + `confirm`, atomic edit + diagnostics, `smartTruncate`, audit log. Avoid: token in URL, trusting `X-Forwarded-*`, `*` CORS, secret bypass in `file_info`, docker flag ignore, git ref without `--`, unbounded DCR. | Copy: per-component `lstat` + deny + `inside()`, `0600/0700 + wx + rename + lock + sha256`, enforced `.gitignore *`, state machine + single dispatch + exact markers, caps + fatal UTF-8 + suspicious gate, stdio-only no-net. Avoid: reuse as-is for remote without adding HTTP/OAuth/multi-user isolation. | — |

### 1.2 Special audit: `prorelay` (extra suspicious)

Verdict: **CLEAN — no malware/telemetry/exfil found.**

- `package.json`: scripts only `test/check/demo`, no `postinstall/preinstall/install/prepare`. Deps only `@modelcontextprotocol/sdk@1.32.1 + zod`. `bin:{prorelay:src/cli.js}`, `private:true`.
- Outbound `fetch/axios/http.request/WebSocket` in `src/`: none. Only doc URLs (`github.com/.../prorelay`, `gemini.google`, `antigravity.google`, `code.claude.com`, shields badges).
- Hardcoded endpoints/IPs/tunnels in `src/`: none.
- `eval/new Function/atob/base64` obfuscation: none. Only `TextDecoder`, `randomBytes(6).hex`, `sha256`.
- `child_process`: only `execFile git --version/rev-parse/status --porcelain` fixed argv, `timeout:5000`, `cwd:root`.
- Credential access `~/.ssh/~/.claude/.env`: not accessed, instead blocked in `allowedName`.
- Telemetry: no `telemetry/track/sentry/posthog` hits.

Reproduce safely (not executed): `npm ci --ignore-scripts; npm run check`.

### 1.3 Best practices to copy

1. Stateless Streamable HTTP, auth gate before MCP transport.
2. OAuth 2.1 + PKCE S256 required + DCR, discovery via `401 + WWW-Authenticate: resource_metadata=...`, exact `redirect_uri` match, `https` except loopback.
3. Opaque tokens, hashed at rest 0600, short access TTL + rotating refresh + family-kill, audience `resource` check.
4. Single allowed root, `realpath` both sides + lexical + real containment, reject NUL/backslash/absolute escape, block symlink per component, block `.git/config`, `.env`, `.ssh`, `*.pem/*.key`.
5. Atomic writes `tmp wx 0600 + rename`, `edit` all-or-nothing + uniqueness check + whitespace diagnostics.
6. No `shell:true`, `execFile/spawn` argv only, tokenizer rejects `;&|<>\n $()`, strict allowlist + denylist wins, `cwd` inside root, timeout + tree-kill + output cap + `smartTruncate`, redact before emit/persist.
7. `confirm=true` for destructive + correct `readOnlyHint/destructiveHint`.
8. Audit log every tool call, redacted.
9. Bind `127.0.0.1`, TLS at Cloudflare Tunnel, pin `PUBLIC_URL`, never trust `X-Forwarded-*` by default, never put tokens in URL/query.
10. Diff in write results + optional git checkpoint.

### 1.4 Mistakes to avoid

- Shared 1-year bearer, revoke does not kill it.
- Default root `HOME` / `~/.claude`.
- Unredacted spill/log readable via `read_file`.
- Prefix SQL blocklist instead of `SELECT`-only allowlist.
- Check-then-use without `O_NOFOLLOW`.
- CORS `*` with `Authorization` allowed.
- Treating `npm/make` as safe though they run repo scripts.
- Git ref interpolation without `--` or leading-`-` guard.
- Tokens in `?token=` or `/mcp/<token>`.

---

## 2. PHASE 2 — Client requirements (official docs first)

Sources: `support.google.com/gemini/answer/17209137`, `developers.openai.com/apps-sdk/deploy/connect-chatgpt`, `claude.com/docs/connectors/building/*`, `support.anthropic.com`, `modelcontextprotocol.io/spec`.

| Aspect | Gemini (Connected Apps > custom app, web only to connect) | ChatGPT (developer mode custom connector) | Claude web (custom connector) |
|---|---|---|---|
| Required transport | Standard MCP, URL entered at `gemini.google.com > Settings > Connected Apps > Custom apps`. Unverified if SSE also works or Streamable HTTP only — design for Streamable HTTP `/mcp`. | SSE and Streaming HTTP supported. Public URL `/mcp`, e.g. `https://abc123.ngrok.app/mcp`. Secure MCP Tunnel allowed for dev. | Streamable HTTP recommended, legacy HTTP+SSE still supported (deprecated). Advanced setting: SSE or Streamable HTTP. |
| Auth flow | DCR supported. If no DCR: `Show more > Advanced features` then enter credentials manually. OAuth via Google Connected Apps link, unlink/revoke supported. | OAuth, No Auth, Mixed Auth. Static creds if provided, else CIMD (`none`, `private_key_jwt`) or DCR if configured. Discovery via metadata. | OAuth 2.0 DCR (`oauth_dcr`) default, CIMD (`oauth_cimd`) if AS advertises `client_id_metadata_document_supported:true + none`, Anthropic-held creds via email, `static_headers` beta, `none`. Must return `401 + WWW-Authenticate: Bearer resource_metadata=...`, `resource` exact match, first `authorization_servers` entry only. PKCE S256 required. Callback `https://claude.ai/api/mcp/auth_callback` + loopback `http://localhost\|127.0.0.1/callback` port-agnostic. |
| URL rules | Connect only in web app, then usable in mobile + web. Invoke via `@` + app. Unverified trailing `/mcp` requirement — provide `/mcp`. | Must be public HTTPS including `/mcp` path. Manual Refresh in `Settings > Plugins` after tool changes. | Must be public HTTPS reachable from `160.79.104.0/21`. Name lowercase-digit-hyphen. Supports Universal / Multiple / URL-pattern anchored regex. |
| Tool-count / response-size limits | Unverified. No numbers in docs. Practice: keep <30 tools, action-oriented names/descriptions, server instructions first 512 chars self-contained. | Unverified official numbers. Docs stress: action-oriented names + `Use this when…`, enums, 512-char self-contained instructions, per-app tool toggle + refresh. Deep Research read/fetch only, no writes. | Verified: ~150k chars per tool result on claude.ai/Desktop, 240s timeout per call. Claude Code 25k tokens via `MAX_MCP_OUTPUT_TOKENS`. All tools must declare `readOnlyHint + destructiveHint`. |
| Plan requirements | 18+, US, personal Google account (no Workspace/school), Keep Activity ON, English only. | Changing, partly unverified: dev docs say Pro/Plus/Business/Enterprise/Education web can use dev mode; newer help says full MCP only Business/Enterprise/Edu, Pro read/fetch only. Workspace admin must enable dev mode. | Free/Pro/Max/Team/Enterprise on Claude/Cowork/Desktop. Free limited to 1 custom connector. Team/Enterprise only if org allows, Owner enables in Admin settings. |
| Write / destructive confirmation | Documented: “Currently, Gemini requires manual confirmation for any write actions, but Gemini can make mistakes.” Do not rely on this alone. | All tools incl. writes available “subject to confirmation settings”. Per-app toggle on/off. Writes need auth/confirmation in eval. | Every tool starts `Not set`, Claude asks before use. Per-tool `Always allow / Ask each time / Block`, or per-connector `Skip approvals` (only for trusted servers). |

---

## 3. PHASE 3 — Design proposal (STOP, needs approval before build)

### 3.1 Architecture

```text
[Gemini web / ChatGPT web / Claude web]
  --HTTPS--> [Cloudflare Tunnel (cloudflared) --url http://127.0.0.1:3000]
    --> [127.0.0.1:3000 Express]
      --> [Auth gate: 401 + resource_metadata, OAuth 2.1 + DCR + PKCE + passphrase consent]
      --> [MCP gate: StreamableHTTPServerTransport stateless, per-request Server]
        --> [Tools: list_dir, read_file, search, edit_file, write_file, run_command, git_status, git_diff]
        --> [Sandbox: single ROOT realpath, block symlink escape, block .env/.ssh/.git/config]
        --> [Audit log append-only redacted]
```

- `TypeScript + @modelcontextprotocol/sdk + Express`, Node 22+.
- Stateless Streamable HTTP `POST /mcp`, `GET/DELETE` 405. New `Server` per request (like `repo-bridge`, not shared session like `aki-mcp-sv`).
- Bind only `127.0.0.1`. TLS + public URL at Cloudflare Tunnel. Pin `PUBLIC_URL`, do not derive from `X-Forwarded-*` by default.
- Single `ALLOWED_ROOT` absolute from env/flag, `realpath` at startup. Every user path resolved via `realpathTolerant` + dual containment per call.
- Server never calls any LLM API. Chat app model does reasoning.

### 3.2 Tool list with JSON schemas

```typescript
// list_dir
{
  name: "list_dir",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path inside root, default '.'" },
      depth: { type: "integer", minimum: 1, maximum: 5, default: 2 },
      limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      include_hidden: { type: "boolean", default: false }
    }
  }
}

// read_file with line ranges
{
  name: "read_file",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
      line_numbers: { type: "boolean", default: true }
    }
  }
}

// search via ripgrep, not grep shell
{
  name: "search",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      path: { type: "string", default: "." },
      glob: { type: "string" },
      regex: { type: "boolean", default: false },
      case_sensitive: { type: "boolean", default: false },
      context_lines: { type: "integer", minimum: 0, maximum: 5, default: 0 },
      max_results: { type: "integer", minimum: 1, maximum: 100, default: 50 }
    }
  }
}

// edit_file exact str_replace, fail on non-unique
{
  name: "edit_file",
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: "object",
    required: ["path", "old_string", "new_string"],
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean", default: false }
    }
  }
}

// write_file create/overwrite/append with diff + checkpoint
{
  name: "write_file",
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: ["create", "overwrite", "append"], default: "create" }
    }
  }
}

// run_command strict allowlist, no shell string
{
  name: "run_command",
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "Binary name only, must be in allowlist" },
      args: { type: "array", items: { type: "string" }, default: [] },
      path: { type: "string", default: "." },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 120, default: 30 }
    }
  }
}

// git_status, git_diff read-only
{
  name: "git_status",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: "object", properties: { path: { type: "string", default: "." } } }
}
{
  name: "git_diff",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", default: "." },
      staged: { type: "boolean", default: false },
      stat_only: { type: "boolean", default: false },
      context_lines: { type: "integer", minimum: 0, maximum: 10, default: 3 }
    }
  }
}
```

Write behavior:

- `edit_file`: count `old_string`, 0 -> fail, >1 with `replace_all=false` -> fail + diagnostics. Atomic write, return unified diff.
- `write_file`: `create` fails if exists, `overwrite` requires exists, return diff. Optional `AUTO_CHECKPOINT=true` -> `git stash push -m checkpoint-<ts>` before write if inside git repo (best-effort, checkpoint failure = write failure).
- `run_command`: default allowlist `["node","npm","npx","python","pip","pytest","git","rg","ls","cat"]` via config, reject `;&|<>\n $() ${}` in each arg, `spawn` without shell, `cwd` inside root, timeout + tree-kill, 64KB cap + head/tail truncate, secret redact.

### 3.3 Auth design

- Self-contained OAuth 2.1 Authorization Server:
  - `GET /.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` (+ `/mcp` suffix variants).
  - `POST /register` DCR RFC7591, public client `none` + PKCE S256 required, exact `redirect_uri` match + allowlist regex: `https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, `https://*.chatgpt.com/connector/oauth/*`, `https://oauth-redirect.googleusercontent.com/r/*`, `https://grok.com/connectors-oauth-exchange-code/*`.
  - `GET/POST /authorize` renders consent + passphrase input (hash `scrypt`, `timingSafeEqual`). HMAC ticket 10 min bound to `client_id+redirect_uri+PKCE+resource`.
  - `POST /token` `application/x-www-form-urlencoded`, single-use code 60s, opaque access 1h, refresh 30d rotation + reuse-detection family-kill, audience = `PUBLIC_URL/mcp`, SHA256 hash at rest 0600.
  - `POST /revoke` RFC7009, `401` with `WWW-Authenticate: Bearer resource_metadata=...`.
- No 1-year shared token like `aki-mcp-sv`. No tokens in URL/query.
- Rate-limit 10 fails/IP/15 min on `/authorize|/token|/register`, key = socket IP (not `X-Forwarded-For`), plus global bucket behind local tunnel.

### 3.4 Threat model

- Actors: random internet (knows tunnel URL), jailbroken model via prompt injection in repo, owner misconfig.
- Assets: code in `ALLOWED_ROOT`, credentials (`~/.ssh`, `.env`, `.git/config`), OS exec.
- Note: internet-exposed = RCE-capable if allowlist loose. Mitigations: single root, realpath per call, sensitive dotfile deny, narrow allowlist, no reliance on client-side `confirm`, audit log, git checkpoint.
- Non-goals: hostile local process (same as `prorelay`), DNS rebinding beyond `Origin` + `Host` allowlist.

### 3.5 Folder structure (in `D:\Project Vibe Code\MCP`)

```text
D:\Project Vibe Code\MCP\
  package.json (type:module, @modelcontextprotocol/sdk, express, zod)
  tsconfig.json
  src/
    config.ts
    logger.ts
    security/paths.ts
    security/commands.ts
    security/secrets.ts
    auth/oauth-store.ts
    auth/oauth-server.ts
    fs/ops.ts
    fs/search.ts
    exec/runner.ts
    git/git.ts
    tools/index.ts
    tools/file-tools.ts
    tools/exec-tools.ts
    tools/git-tools.ts
    server/http.ts
    server/mcp.ts
  test/
    paths.test.ts
    allowlist.test.ts
  README.md // Cloudflare Tunnel + 3 clients setup
```

---

## 4. Approval gate

PHASE 4 build (TypeScript + Express + OAuth + tools + tests + README + Inspector steps) starts only after your approval.
