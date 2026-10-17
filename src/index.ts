import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { buildApp } from "./server/http.js";

function main(): void {
  const cfg = loadConfig();
  if (!fs.existsSync(cfg.allowedRoot)) {
    fs.mkdirSync(cfg.allowedRoot, { recursive: true });
  }
  // Fail fast if ALLOWED_ROOT is not a directory.
  const st = fs.statSync(cfg.allowedRoot);
  if (!st.isDirectory()) throw new Error(`ALLOWED_ROOT is not a directory: ${cfg.allowedRoot}`);

  const app = buildApp();
  app.listen(cfg.port, cfg.host, () => {
    console.log(`[bridge] listening on http://${cfg.host}:${cfg.port}/mcp`);
    console.log(`[bridge] root=${cfg.allowedRoot} mode=${cfg.mode} public=${cfg.publicUrl}`);
    console.log(`[bridge] passphrase file: ${path.join(cfg.dataDir, "passphrase.txt")} (auto-generated if empty)`);
  });
}

main();
