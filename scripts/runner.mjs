import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const projectRoot = process.cwd();

// Load .env
const envFile = path.join(projectRoot, ".env");
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, "utf8");
  for (const line of content.split("\n")) {
    const l = line.trim();
    if (l && !l.startsWith("#") && l.includes("=")) {
      const idx = l.indexOf("=");
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// 1. Spawn cloudflared tunnel
const cfBin = path.join(projectRoot, "bin", "cloudflared.exe");
const cfConfig = path.join(projectRoot, ".bridge", "tunnel", "config.yml");
const cfTunnelId = "c5fce942-a27f-4df4-8f9f-9149b2dba2e7";

console.log("[runner] Starting cloudflared tunnel...");
const cf = spawn(cfBin, ["--config", cfConfig, "tunnel", "run", cfTunnelId], {
  cwd: projectRoot,
  stdio: "inherit",
});

cf.on("error", (err) => console.error("[runner] cloudflared error:", err));
cf.on("exit", (code) => console.log(`[runner] cloudflared exited with code ${code}`));

// Wait 2 seconds then boot server
setTimeout(async () => {
  console.log("[runner] Starting MCP server...");
  // Import server directly in this Node process
  await import("../dist/index.js");
}, 2000);

process.on("SIGINT", () => {
  cf.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cf.kill();
  process.exit(0);
});
