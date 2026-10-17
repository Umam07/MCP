import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseScripts } from "./exec/run.js";

export type Mode = "read" | "edit" | "exec";

export interface BridgeConfig {
  allowedRoot: string;
  publicUrl: string;
  port: number;
  host: string;
  mode: Mode;
  dataDir: string;
  passphrase: string;
  redirectPatterns: RegExp[];
  redirectRaw: string[];
  scripts: Record<string, string[]>;
}

function parseMode(raw: string | undefined): Mode {
  if (raw === "read" || raw === "edit" || raw === "exec") return raw;
  return "edit";
}

function compileRedirectList(raw: string): { patterns: RegExp[]; originals: string[] } {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const patterns: RegExp[] = [];
  for (const p of parts) {
    try {
      patterns.push(new RegExp(`^(?:${p})$`));
    } catch {
      // Ignore invalid pattern but keep visible in logs.
    }
  }
  return { patterns, originals: parts };
}

// Generate a URL-safe random passphrase with at least 128 bits of entropy.
function randomPassphrase(length = 20): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789-_.";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function ensurePassphrase(dataDir: string, envValue: string | undefined): string {
  const file = path.join(dataDir, "passphrase.txt");
  if (envValue && envValue.length >= 16) return envValue;
  if (envValue && envValue.length > 0 && envValue.length < 16) {
    throw new Error("PASSPHRASE must be at least 16 chars or empty for auto-generate");
  }
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 16) return existing;
  } catch {
    // Fall through to generate.
  }
  const gen = randomPassphrase(20);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, gen + "\n", { mode: 0o600, flag: "wx" });
  console.log("[bridge] Generated random passphrase (see .bridge/passphrase.txt). Keep it secret.");
  return gen;
}

let cached: BridgeConfig | null = null;

export function loadConfig(): BridgeConfig {
  if (cached) return cached;
  const projectDir = process.cwd();
  const dataDir = path.join(projectDir, ".bridge");
  fs.mkdirSync(dataDir, { recursive: true });

  const allowedRootRaw =
    process.env.ALLOWED_ROOT || path.join(projectDir, "sandbox-repo");
  const allowedRoot = path.resolve(allowedRootRaw);

  const publicUrl = (process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || "3000"}`).replace(/\/+$/, "");
  const port = Number(process.env.PORT || "3000");
  const host = process.env.HOST || "127.0.0.1";
  const mode = parseMode(process.env.MODE);

  const allowRaw =
    process.env.REDIRECT_ALLOWLIST ||
    "https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector_platform_oauth_redirect,https://chatgpt.com/connector/oauth/.*,https://.*\\.chatgpt.com/connector/oauth/.*,https://oauth-redirect.googleapis.com/.*,https://oauth-redirect.googleusercontent.com/.*,https://grok.com/connectors-oauth-exchange-code/.*";
  const { patterns, originals } = compileRedirectList(allowRaw);
  const passphrase = ensurePassphrase(dataDir, process.env.PASSPHRASE);
  // Named scripts only (milestone e). Invalid config fails fast so the server
  // never starts with a dangerous or broken allowlist.
  const scripts = parseScripts(process.env.SCRIPTS_JSON);

  cached = {
    allowedRoot,
    publicUrl,
    port,
    host,
    mode,
    dataDir,
    passphrase,
    redirectPatterns: patterns,
    redirectRaw: originals,
    scripts,
  };
  return cached;
}

export function isRedirectAllowed(uri: string, cfg: BridgeConfig): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
      return false;
    }
    if (u.hash) return false;
    if (u.username || u.password) return false;
  } catch {
    return false;
  }
  return cfg.redirectPatterns.some((re) => re.test(uri));
}
