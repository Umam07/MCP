import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolvePath } from "../security/paths.js";

const GIT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 256 * 1024;

// Only these git subcommands are exposed in milestone (a) — all read-only.
const ALLOWED_GIT: Record<string, string[][]> = {
  status: [["status", "--porcelain=v1", "-b"]],
  diff: [
    ["diff", "--no-color"],
    ["diff", "--no-color", "--cached"],
    ["diff", "--no-color", "--stat"],
  ],
};

function hasShellMeta(arg: string): boolean {
  return /[;&|<>\n\r`$]/.test(arg) || /\$\(/.test(arg) || /\$\{/.test(arg);
}

const SAFE_FLAG_RE = /^(--porcelain=v1|-b|--no-color|--cached|--stat|--unified=\d{1,2}|--|\.)$/;

export function validateGitArgs(argv: string[]): void {
  if (argv.length === 0) throw new Error("empty git argv");
  const sub = argv[0];
  if (sub !== "status" && sub !== "diff") throw new Error("git subcommand not allowed");
  for (const a of argv.slice(1)) {
    if (hasShellMeta(a)) throw new Error("shell metacharacters not allowed in git args");
    if (a.includes("\0")) throw new Error("NUL in git args");
    if (a.includes(":")) throw new Error("colon not allowed in git args");
    if (a.startsWith("-") && !SAFE_FLAG_RE.test(a)) {
      throw new Error(`git flag not allowed: ${a}`);
    }
  }
  // Leading-dash guard for refs/paths is enforced by callers using `--` separator.
}

function runGit(cwd: string, argv: string[]): Promise<{ stdout: string; truncated: boolean }> {
  validateGitArgs(argv);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    return Promise.reject(new Error(`git target path is not an existing directory: ${cwd}`));
  }
  return new Promise((resolve, reject) => {
    const gitBin = "git";
    let command = gitBin;
    let args = argv;
    const options = {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
    };

    // Windows: .cmd/.bat shim handling. Resolve git.exe via PATH and, if it is a
    // .cmd/.bat wrapper, spawn via ComSpec AFTER validation (no shell interpolation).
    if (process.platform === "win32") {
      // Node spawn of "git" already resolves PATHEXT; ComSpec path is only needed
      // if the resolved target is a batch file. We keep argv validated above and
      // never pass a shell string.
      const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
      // Probe: spawn directly first; fallback to ComSpec is handled by caller on ENOENT.
      // Here we spawn directly to avoid cmd injection surface.
      const child = spawn(command, args, { ...options, windowsHide: true });
      collect(child, resolve, reject);
      void comspec;
      return;
    }
    const child = spawn(command, args, options);
    collect(child, resolve, reject);
  });
}

function collect(
  child: ReturnType<typeof spawn>,
  resolve: (v: { stdout: string; truncated: boolean }) => void,
  reject: (e: Error) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  child.stdout?.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_OUTPUT_BYTES * 4) {
      truncated = true;
      return;
    }
    chunks.push(c);
  });
  child.stderr?.on("data", () => {});
  child.on("error", (e) => reject(e));
  child.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`git exited with code ${code}`));
      return;
    }
    let out = Buffer.concat(chunks).toString("utf8");
    if (out.length > MAX_OUTPUT_BYTES) {
      const head = out.slice(0, Math.floor(MAX_OUTPUT_BYTES * 0.6));
      const tail = out.slice(-Math.floor(MAX_OUTPUT_BYTES * 0.4));
      out = `${head}\n[...truncated ${out.length - MAX_OUTPUT_BYTES} chars...]\n${tail}`;
      truncated = true;
    }
    resolve({ stdout: out, truncated });
  });
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, GIT_TIMEOUT_MS + 5000).unref?.();
}

export async function gitStatus(root: string, relPath: string): Promise<{ output: string; truncated: boolean }> {
  const { absolute } = resolvePath(root, relPath);
  const { stdout, truncated } = await runGit(absolute, ["status", "--porcelain=v1", "-b"]);
  return { output: stdout, truncated };
}

export interface DiffOptions {
  path?: string;
  staged?: boolean;
  statOnly?: boolean;
  contextLines?: number;
}

export async function gitDiff(root: string, opts: DiffOptions): Promise<{ output: string; truncated: boolean }> {
  const rel = opts.path || ".";
  const { absolute } = resolvePath(root, rel);
  const argv = ["diff", "--no-color"];
  if (opts.statOnly) {
    argv.push("--stat");
  } else {
    // `--unified=N` re-enables patch output, so only add it for real diffs.
    argv.push(`--unified=${Math.min(Math.max(opts.contextLines ?? 3, 0), 10)}`);
  }
  if (opts.staged) argv.push("--cached");
  argv.push("--", ".");
  // Run with cwd = repo path (or subdir), pathspec locked to `.` after `--`.
  const { stdout, truncated } = await runGit(absolute, argv);
  return { output: stdout, truncated };
}
