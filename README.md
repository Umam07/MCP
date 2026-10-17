# Local Code Bridge (MCP)

Secure local-code MCP bridge that lets Gemini / ChatGPT / Claude **web** read, search and
edit code inside **one** allowed project folder and run allowlisted scripts.

- Transport: **Streamable HTTP** (stateless `POST /mcp`)
- Auth: **OAuth 2.1** — Dynamic Client Registration (RFC 7591) + PKCE (S256) + a local passphrase
- **No LLM API is ever called.** The server only exposes local file/git tools.
- Binds `127.0.0.1` by default. Expose it to the internet only through a tunnel you control.

> Status: **Milestone (a)** — OAuth + read-only tools. Write tools (d), `run_script` (e) and
> Gemini (f) are planned. Do not point this at a folder you don't want read.

## Layout

```
src/
  index.ts              entrypoint
  config.ts             env parsing, passphrase bootstrap, redirect allowlist
  server/http.ts        Express app: OAuth mount + guarded POST /mcp
  server/mcp.ts         per-request McpServer factory
  tools/index.ts        tool manifest (read-only in milestone a)
  security/paths.ts     Windows-safe sandbox (traversal, ADS, reserved names, junctions)
  security/secrets.ts   secret redaction
  fs/ops.ts             list_dir, read_file
  fs/search.ts          pure-Node search (no shell)
  git/git.ts            read-only git status/diff (fixed argv)
  auth/oauth-store.ts   DCR clients, hashed codes/tokens, PKCE, refresh rotation
  auth/oauth-server.ts  metadata, /register /authorize /token /revoke
  logger.ts             redacted audit log
scripts/                end-to-end smoke tests
sandbox-repo/           dummy ALLOWED_ROOT for development
```

## Setup

```powershell
npm install
npm run build
copy .env.example .env    # then edit ALLOWED_ROOT (and PUBLIC_URL when tunneling)
```

`PASSPHRASE` may be empty: on first run a random >=16-char passphrase is generated and written
to `.bridge/passphrase.txt` (gitignored). Read it there to approve a client.

## Run

```powershell
npm start
# [bridge] listening on http://127.0.0.1:3000/mcp
# [bridge] root=... mode=edit public=...
```

Health/`discovery`:

```powershell
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/.well-known/oauth-protected-resource
```

## Test

```powershell
npm test        # unit: path traversal, ADS/reserved names, git arg validation
npm run smoke   # end-to-end: full OAuth flow + tool calls over HTTP (server must be running)
```

## Manual test with MCP Inspector

```powershell
npm start
npm run inspector
# In the Inspector UI:
#   Transport: Streamable HTTP
#   URL:       http://127.0.0.1:3000/mcp
#   Auth:      OAuth (the Inspector discovers /register, /authorize, /token automatically)
# Click Connect -> a consent page opens -> paste .bridge/passphrase.txt -> Approve.
# Then list tools: list_dir, read_file, search, git_status, git_diff.
```

## Tools (milestone a: read-only; milestone d: +write in edit/exec modes)

| tool | purpose |
|------|---------|
| `list_dir` | list files/dirs under the root (depth/limit/hidden) |
| `read_file` | read a file with line ranges + line numbers (2 MB cap, paged) |
| `search` | recursive pure-Node search (glob, regex, context, 512 KB/file scan cap) |
| `git_status` | read-only `git status --porcelain=v1 -b` |
| `git_diff` | read-only `git diff` (staged / stat / context lines) |
| `edit_file` | (edit/exec only) replace ONE exact string; backup + diff; rejects missing/ambiguous matches |
| `write_file` | (edit/exec only) create/overwrite whole file; backup + diff; creates parent dirs |
| `run_script` | (exec only) run a NAMED script from `SCRIPTS_JSON` (e.g. check, test); fixed argv, no custom commands/args, 60 s timeout, capped output |

Read tools carry `readOnlyHint: true`. Write tools carry `readOnlyHint: false`,
`destructiveHint: true`, are **not registered at all in `read` mode**, back up every
overwritten file to `.bridge-backup/` (outside the root, gitignored), and refuse
secret paths (`.env`, `.git`, keys), traversal, ADS, and reserved Windows names.

## Security notes

- Single `ALLOWED_ROOT`, realpath-canonicalized at startup; every path is re-checked
  (traversal, absolute/UNC, NTFS ADS `:`, reserved names, trailing dot/space, junction/symlink).
- `git` runs with a **fixed argv** (no shell) and validated flags; `cwd` must be an existing dir.
- Search is pure Node — no `rg`/shell, so no argument-injection surface.
- Tokens/codes stored **SHA256-hashed**; access tokens are audience-bound to `PUBLIC_URL/mcp`;
  `POST /mcp` requires a valid bearer token and rejects cross-origin requests.
- Audit log redacts secrets; never logs the passphrase or tokens.
- CORS is permissive for local dev but auth is always required; tighten for production tunnels.

## Connecting the web clients (next milestones)

- **Claude web** (b): add the tunnel URL as a custom connector; callback
  `https://claude.ai/api/mcp/auth_callback` is already allowlisted.
- **ChatGPT** (c): connector / developer mode; callback
  `https://chatgpt.com/connector_platform_oauth_redirect` is allowlisted.
- **Gemini** (f, last): web-only, requires 18+/US/personal Google account; treat as unverified.
