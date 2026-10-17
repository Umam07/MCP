// Runs every smoke script and judges by printed summaries, not by process
// exit code (Node 25 on Windows can abort during teardown AFTER printing
// "N passed", which would falsely fail an && chain).
import { spawnSync } from "node:child_process";

const files = [
  "smoke.mjs",
  "smoke2.mjs",
  "smoke-write.mjs",
  "smoke-chatgpt.mjs",
  "smoke-gemini.mjs",
  "smoke-exec.mjs",
  "smoke-public.mjs",
];

let totalPass = 0;
let totalFail = 0;
const noSummary = [];
for (const f of files) {
  const r = spawnSync("node", [`scripts/${f}`], { encoding: "utf8", timeout: 240000, windowsHide: true });
  const out = String(r.stdout || "") + String(r.stderr || "");
  // Last "X passed, Y failed" line is the script's own totals.
  const matches = [...out.matchAll(/(\d+) passed, (\d+) failed/g)];
  const m = matches.length ? matches[matches.length - 1] : null;
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]);
    console.log(`${Number(m[2]) === 0 ? "PASS" : "FAIL"} ${f}: ${m[1]} passed, ${m[2]} failed`);
  } else {
    noSummary.push(f);
    console.log(`FAIL ${f}: no summary (exit ${r.status})`);
    console.log(out.slice(-800));
  }
}
console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed${noSummary.length ? `; no summary: ${noSummary.join(", ")}` : ""}`);
// Exit nonzero only via explicit code path (no uv-teardown crash here: no fetch used).
process.exitCode = totalFail + noSummary.length > 0 ? 1 : 0;
