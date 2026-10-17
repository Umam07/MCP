import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "../config.js";

export interface DcrClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

export interface AuthCode {
  code: string; // plaintext only in memory; stored hashed
  codeHash: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  expiresAt: number;
  used: boolean;
}

export interface Token {
  raw: string;
  hash: string;
  clientId: string;
  resource: string;
  expiresAt: number;
  refreshHash?: string;
}

interface Persisted {
  clients: DcrClient[];
  codes: { codeHash: string; clientId: string; redirectUri: string; challenge: string; resource: string; expiresAt: number; used: boolean }[];
  access: { hash: string; clientId: string; resource: string; expiresAt: number }[];
  refresh: { hash: string; clientId: string; resource: string; expiresAt: number; accessHash: string }[];
}

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function randomId(prefix: string, bytes = 16): string {
  return `${prefix}${crypto.randomBytes(bytes).toString("hex")}`;
}

export class OAuthStore {
  private file: string;
  private clients = new Map<string, DcrClient>();
  // codeHash -> record (keeps challenge, never stores raw code)
  private codes = new Map<string, AuthCode>();
  private access = new Map<string, Token>();
  private refresh = new Map<string, Token & { accessHash: string }>();

  constructor() {
    const cfg = loadConfig();
    this.file = path.join(cfg.dataDir, "oauth.json");
    this.load();
    setInterval(() => this.prune(), 60_000).unref?.();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw) as Persisted;
      for (const c of data.clients || []) this.clients.set(c.client_id, c);
      for (const c of data.codes || []) {
        this.codes.set(c.codeHash, {
          code: "",
          codeHash: c.codeHash,
          clientId: c.clientId,
          redirectUri: c.redirectUri,
          challenge: c.challenge,
          resource: c.resource,
          expiresAt: c.expiresAt,
          used: c.used,
        });
      }
      for (const t of data.access || []) {
        this.access.set(t.hash, { raw: "", hash: t.hash, clientId: t.clientId, resource: t.resource, expiresAt: t.expiresAt });
      }
      for (const t of data.refresh || []) {
        this.refresh.set(t.hash, { raw: "", hash: t.hash, clientId: t.clientId, resource: t.resource, expiresAt: t.expiresAt, accessHash: t.accessHash });
      }
    } catch {
      // No file yet.
    }
  }

  private save(): void {
    const data: Persisted = {
      clients: [...this.clients.values()],
      codes: [...this.codes.values()].map((c) => ({
        codeHash: c.codeHash,
        clientId: c.clientId,
        redirectUri: c.redirectUri,
        challenge: c.challenge,
        resource: c.resource,
        expiresAt: c.expiresAt,
        used: c.used,
      })),
      access: [...this.access.values()].map((t) => ({ hash: t.hash, clientId: t.clientId, resource: t.resource, expiresAt: t.expiresAt })),
      refresh: [...this.refresh.values()].map((t) => ({ hash: t.hash, clientId: t.clientId, resource: t.resource, expiresAt: t.expiresAt, accessHash: t.accessHash })),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // Best effort.
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    for (const [k, v] of this.access) if (v.expiresAt < now) this.access.delete(k);
    for (const [k, v] of this.refresh) if (v.expiresAt < now) this.refresh.delete(k);
    this.save();
  }

  registerClient(name: string | undefined, redirectUris: string[]): DcrClient {
    const client_id = randomId("client_");
    const client: DcrClient = { client_id, client_name: name, redirect_uris: redirectUris, created_at: Date.now() };
    this.clients.set(client_id, client);
    this.save();
    return client;
  }

  getClient(id: string): DcrClient | undefined {
    return this.clients.get(id);
  }

  issueCode(clientId: string, redirectUri: string, challenge: string, resource: string): string {
    const code = randomId("code_", 24);
    const rec: AuthCode = {
      code: "",
      codeHash: sha256Hex(code),
      clientId,
      redirectUri,
      challenge,
      resource,
      expiresAt: Date.now() + 60_000,
      used: false,
    };
    this.codes.set(rec.codeHash, rec);
    this.save();
    return code;
  }

  consumeCode(code: string, clientId: string, redirectUri: string, verifier: string, resource: string): AuthCode {
    const h = sha256Hex(code);
    const rec = this.codes.get(h);
    if (!rec) throw new Error("invalid code");
    if (rec.used) throw new Error("code already used");
    if (rec.expiresAt < Date.now()) throw new Error("code expired");
    if (rec.clientId !== clientId) throw new Error("client mismatch");
    if (rec.redirectUri !== redirectUri) throw new Error("redirect mismatch");
    if (rec.resource !== resource) throw new Error("resource mismatch");
    const expected = rec.challenge;
    const actual = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
      throw new Error("PKCE verification failed");
    }
    rec.used = true;
    this.save();
    return rec;
  }

  issueTokens(clientId: string, resource: string): { access_token: string; refresh_token: string; expires_in: number } {
    const accessRaw = randomId("rba_", 32);
    const refreshRaw = randomId("rbr_", 32);
    const access: Token = {
      raw: "",
      hash: sha256Hex(accessRaw),
      clientId,
      resource,
      expiresAt: Date.now() + 3600_000,
    };
    const refresh: Token & { accessHash: string } = {
      raw: "",
      hash: sha256Hex(refreshRaw),
      clientId,
      resource,
      expiresAt: Date.now() + 30 * 24 * 3600_000,
      accessHash: access.hash,
    };
    this.access.set(access.hash, access);
    this.refresh.set(refresh.hash, refresh);
    this.save();
    return { access_token: accessRaw, refresh_token: refreshRaw, expires_in: 3600 };
  }

  refreshTokens(refreshRaw: string, clientId: string, resource: string): { access_token: string; refresh_token: string; expires_in: number } {
    const h = sha256Hex(refreshRaw);
    const rec = this.refresh.get(h);
    if (!rec) throw new Error("invalid refresh token");
    if (rec.expiresAt < Date.now()) throw new Error("refresh expired");
    if (rec.clientId !== clientId) throw new Error("client mismatch");
    if (rec.resource !== resource) throw new Error("resource mismatch");
    // Rotation + family-kill on replay: delete old refresh and its access.
    this.refresh.delete(h);
    if (rec.accessHash) this.access.delete(rec.accessHash);
    return this.issueTokens(clientId, resource);
  }

  verifyAccess(bearer: string, expectedResource: string): boolean {
    const h = sha256Hex(bearer);
    const rec = this.access.get(h);
    if (!rec) return false;
    if (rec.expiresAt < Date.now()) return false;
    if (rec.resource !== expectedResource) return false;
    return true;
  }

  revoke(raw: string): void {
    const h = sha256Hex(raw);
    this.access.delete(h);
    const r = this.refresh.get(h);
    if (r) {
      if (r.accessHash) this.access.delete(r.accessHash);
      this.refresh.delete(h);
    }
    this.save();
  }
}

export const oauthStore = new OAuthStore();
