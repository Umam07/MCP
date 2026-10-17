import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { redactSecrets } from "./security/secrets.js";

export function auditLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const cfg = loadConfig();
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...redactSecrets(fields),
    });
    fs.appendFileSync(path.join(cfg.dataDir, "audit.log"), line + "\n");
  } catch {
    // Audit must never crash the server.
  }
}

export const log = {
  info: (msg: string, fields: Record<string, unknown> = {}) => {
    console.log(`[bridge] ${msg}`, Object.keys(fields).length ? JSON.stringify(redactSecrets(fields)) : "");
    auditLog(msg, fields);
  },
  warn: (msg: string, fields: Record<string, unknown> = {}) => {
    console.warn(`[bridge] WARN ${msg}`, Object.keys(fields).length ? JSON.stringify(redactSecrets(fields)) : "");
    auditLog(`WARN ${msg}`, fields);
  },
  error: (msg: string, fields: Record<string, unknown> = {}) => {
    console.error(`[bridge] ERROR ${msg}`, Object.keys(fields).length ? JSON.stringify(redactSecrets(fields)) : "");
    auditLog(`ERROR ${msg}`, fields);
  },
};
