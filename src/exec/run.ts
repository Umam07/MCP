import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolvePath } from "../security/paths.js";

export const RUN_TIMEOUT_MS = (() => {
  const v = Number(process.env.RUN_TIMEOUT_MS || "60000");
  if (!Number.isFinite(v)) return 60_000;
  return Math.min(Math.max(Math.floor(v), 5_000), 600_000); // clamp 5s..10min
})();
const MAX_OUTPUT_BYTES = 256 * 1024;

// Shells can never be a script binary (no shell interpolation, ever).
const SHELL_BASENAMES = new Set(["cmd", "powershell", "pwsh", "sh", "bash", "dash", "zsh", "fish", "wsl"]);
// Inline-code flags turn an interpreter into arbitrary code execution.
const INLINE_CODE_FLAGS = new Set(["-e", "-c", "-Command", "/c"]);

function basenameOf(bin: string): string {
  const b = bin.replace(/\\/g, "/").split("/").pop() || "";
  return b.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function hasShellMeta(arg: string): boolean {
  return /[;&|<>\n\r`$"']/.test(arg) || /\$\(/.test(arg) || /\$\{/.test(arg);
}

export function validateScriptArgv(name: string, argv: string[]): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`bad script name: ${name}`);
  if (!Array.isArray(argv) || argv.length === 0) throw new Error(`script "${name}" has empty argv`);
  if (argv.length > 32) throw new Error(`script "${name}" has too many args`);
  const bin = basenameOf(argv[0]);
  if (!bin) throw new Error(`script "${name}" has empty binary`);
  if (SHELL_BASENAMES.has(bin)) throw new Error(`script "${name}" must not use a shell as its binary`);
  if (/\.(ps1|sh|bash|zsh|fish)$/i.test(argv[0])) {
    throw new Error(`script "${name}" must not use a shell script as its binary`);
  }
  for (const a of argv) {
    if (typeof a !== "string" || a.length === 0 || a.length > 4096) {
      throw new Error(`script "${name}" has a bad argument`);
    }
    if (a.includes("\0")) throw new Error("NUL in script args");
    if (hasShellMeta(a)) throw new Error(`script "${name}" args must not contain shell metacharacters`);
  }
  // No interpreter one-liners: `node -e`, `python -c`, etc. Fixed file args are fine
  // because no user input is ever appended to argv.
  if (["node", "python", "python3", "ruby", "perl", "php", "deno", "bun"].includes(bin)) {
    for (const a of argv.slice(1)) {
      if (INLINE_CODE_FLAGS.has(a)) {
        throw new Error(`script "${name}" must not pass inline-code flags to an interpreter`);
      }
    }
  }
}

export function parseScripts(raw: string | undefined): Record<string, string[]> {
  if (!raw || !raw.trim()) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("SCRIPTS_JSON is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error("SCRIPTS_JSON must be an object of name -> argv[]");
  }
  const out: Record<string, string[]> = {};
  for (const [name, argv] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(argv) || !argv.every((x) => typeof x === "string")) {
      throw new Error(`script "${name}" argv must be a string array`);
    }
    validateScriptArgv(name, argv as string[]);
    out[name] = argv as string[];
  }
  return out;
}

// Resolve a bare binary via PATH. Prefers directly-executable .exe over
// .cmd/.bat shims (`where npm` lists extensionless `npm` first, which
// CreateProcess cannot run). Returns absolute path or null.
function resolveOnPath(bin: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) return null; // bare names only
  try {
    const lines = ((): string[] => {
      if (process.platform === "win32") {
        const r = spawnSync("where", [bin], { encoding: "utf8", windowsHide: true });
        return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      const r = spawnSync("which", ["-a", bin], { encoding: "utf8" });
      return (r.stdout || "").trim().split("\n").map((s) => s.trim()).filter(Boolean);
    })();
    if (!lines.length) return null;
    return (
      lines.find((l) => /\.exe$/i.test(l)) ||
      lines.find((l) => /\.(cmd|bat)$/i.test(l)) ||
      lines[0]
    );
  } catch {
    return null;
  }
}

export interface RunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export function runScript(
  root: string,
  scripts: Record<string, string[]>,
  name: string,
  relPath: string,
  timeoutMs = RUN_TIMEOUT_MS,
): Promise<RunResult> {
  let argv: string[];
  let cwd: string;
  try {
    argv = scripts[name];
    if (!argv) {
      const known = Object.keys(scripts);
      throw new Error(`unknown script "${name}"${known.length ? ` (available: ${known.join(", ")})` : " (no scripts configured)"}`);
    }
    // Re-validate at call time (defense in depth; config is operator-controlled).
    validateScriptArgv(name, argv);
    cwd = resolvePath(root, relPath || ".").absolute;
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`script working dir is not an existing directory: ${relPath || "."}`);
    }
  } catch (e) {
    return Promise.reject(e);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const push = (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT_BYTES * 4) {
        truncated = true;
        return;
      }
      chunks.push(c);
    };
    const finish = (code: number | null) => {
      let out = Buffer.concat(chunks).toString("utf8");
      if (out.length > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES) + `\n[...truncated ${out.length - MAX_OUTPUT_BYTES} chars...]`;
        truncated = true;
      }
      resolve({ output: out, exitCode: code, timedOut, truncated });
    };

    const env = { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
    const bin = argv[0];
    const rest = argv.slice(1);

    // Windows .cmd/.bat shims (npm, etc.) cannot run via CreateProcess directly.
    // Resolve via PATH; if batch, run through ComSpec with fixed, validated,
    // double-quoted args (never a shell string from user input).
    let command = bin;
    let args = rest;
    let useComSpec = false;
    if (process.platform === "win32") {
      const resolved = resolveOnPath(bin);
      if (!resolved) {
        reject(new Error(`script binary not found on PATH: ${bin}`));
        return;
      }
      if (/["$`&|;<>]/.test(resolved)) {
        reject(new Error(`script binary path is not safe: ${bin}`));
        return;
      }
      if (/\.(cmd|bat)$/i.test(resolved)) {
        useComSpec = true;
        const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
        // cmd.exe strips the OUTERMOST quote pair (old /s behavior), so the
        // command must be double-wrapped: ""exe" "args"". After stripping,
        // a valid quoted command remains. Args are fixed + validated upstream.
        const quoted = `"${[resolved, ...rest].map((a) => `"${a}"`).join(" ")}"`;
        command = comspec;
        args = ["/d", "/s", "/c", quoted];
      } else {
        command = resolved;
      }
    }

    let child;
    try {
      // windowsVerbatimArguments: Node must NOT re-quote the /c string for
      // ComSpec — it is already exactly quoted (validated args, no metachars).
      child = spawn(command, args, { cwd, env, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: useComSpec });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    void useComSpec;
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (e) => reject(e));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") timedOut = true;
      finish(code);
    });
    // Node's `timeout` kills on expiry; mark it if close arrives via signal.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* ignore */ }
    }, timeoutMs + 5000).unref?.();
  });
}
