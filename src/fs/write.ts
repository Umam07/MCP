import fs from "node:fs";
import path from "node:path";
import { resolvePath } from "../security/paths.js";
import { loadConfig } from "../config.js";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CHARS = 64 * 1024;

// Backups live in <project>/.bridge-backup/ — OUTSIDE the allowed root, so they
// never pollute the repo, never appear in git status, and can't be read via tools
// (resolvePath blocks .bridge-backup/ and confines everything to the root).
export function backupDir(): string {
  const cfg = loadConfig();
  const dir = path.join(path.dirname(cfg.dataDir), ".bridge-backup");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupOriginal(absolute: string, relativePosix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = relativePosix.replace(/\//g, "__");
  const dest = path.join(backupDir(), `${stamp}__${safe}`);
  fs.copyFileSync(absolute, dest);
  return dest;
}

function binaryGuard(buf: Buffer): void {
  if (buf.subarray(0, 8192).includes(0)) throw new Error("binary file refused");
}

// Minimal unified diff for a single changed region with context lines.
// Finds common prefix/suffix; exact for single replacements/appends.
export function unifiedDiff(relPath: string, oldText: string, newText: string, context = 3): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const ctxS = Math.max(0, s - context);
  const ctxEa = Math.min(a.length - 1, ea + context);
  const ctxEb = Math.min(b.length - 1, eb + context);
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  out.push(`@@ -${ctxS + 1},${ctxEa - ctxS + 1} +${ctxS + 1},${ctxEb - ctxS + 1} @@`);
  for (let i = ctxS; i < s; i++) out.push(" " + a[i]);
  for (let i = s; i <= ea; i++) out.push("-" + a[i]);
  for (let i = s; i <= eb; i++) out.push("+" + b[i]);
  for (let i = Math.max(eb + 1, s); i <= ctxEa; i++) out.push(" " + a[i]);
  let diff = out.join("\n");
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS) + "\n[...diff truncated...]";
  }
  return diff;
}

export interface EditOptions {
  path: string;
  oldString: string;
  newString: string;
}

export function editFile(root: string, opts: EditOptions): { diff: string; backup: string } {
  if (!opts.oldString) throw new Error("old_string must not be empty");
  if (opts.oldString === opts.newString) throw new Error("old_string and new_string are identical; nothing to do");
  const { absolute, relativePosix } = resolvePath(root, opts.path);
  let st: fs.Stats;
  try {
    st = fs.statSync(absolute);
  } catch {
    throw new Error(`file does not exist: ${opts.path} (use write_file to create)`);
  }
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_WRITE_BYTES) throw new Error(`file too large (${st.size} bytes) to edit safely`);

  const buf = fs.readFileSync(absolute);
  binaryGuard(buf);
  const text = buf.toString("utf8");

  // Count occurrences without regex (literal string).
  let count = 0;
  let idx = text.indexOf(opts.oldString);
  while (idx !== -1) {
    count++;
    if (count > 1) break;
    idx = text.indexOf(opts.oldString, idx + opts.oldString.length);
  }
  if (count === 0) throw new Error("old_string not found in file");
  if (count > 1) throw new Error("old_string matches multiple times; provide more surrounding context to make it unique");

  const next = text.replace(opts.oldString, opts.newString);
  if (Buffer.byteLength(next, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("result would exceed size cap");
  }
  const backup = backupOriginal(absolute, relativePosix);
  fs.writeFileSync(absolute, next, "utf8");
  return { diff: unifiedDiff(relativePosix, text, next), backup };
}

export interface WriteOptions {
  path: string;
  content: string;
}

export function writeFile(root: string, opts: WriteOptions): { diff: string; backup: string | null; created: boolean } {
  if (Buffer.byteLength(opts.content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("content exceeds size cap (2 MB); write in smaller pieces");
  }
  const { absolute, relativePosix } = resolvePath(root, opts.path);
  let existing: string | null = null;
  let backup: string | null = null;
  try {
    const st = fs.statSync(absolute);
    if (!st.isFile()) throw new Error("target is not a file (refusing to overwrite directory/special)");
    if (st.size > MAX_WRITE_BYTES) throw new Error(`existing file too large (${st.size} bytes) to overwrite safely`);
    const buf = fs.readFileSync(absolute);
    binaryGuard(buf);
    existing = buf.toString("utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code !== "ENOENT") throw e;
    // ENOENT (or missing tail) -> create flow.
  }

  if (existing !== null && existing === opts.content) {
    return { diff: "(no changes)", backup: null, created: false };
  }
  if (existing !== null) {
    backup = backupOriginal(absolute, relativePosix);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, opts.content, "utf8");
  const diff = existing === null ? `(created ${relativePosix}, ${opts.content.length} chars)` : unifiedDiff(relativePosix, existing, opts.content);
  return { diff, backup, created: existing === null };
}

export function deleteFile(root: string, relPath: string): { backup: string; path: string } {
  if (!relPath || relPath.trim() === "" || relPath === ".") {
    throw new Error("refusing to delete root or empty path");
  }
  const { absolute, relativePosix } = resolvePath(root, relPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(absolute);
  } catch {
    throw new Error(`file does not exist: ${relPath}`);
  }
  if (!st.isFile()) throw new Error("target is not a file (refusing to delete directory)");

  const backup = backupOriginal(absolute, relativePosix);
  fs.unlinkSync(absolute);
  return { backup, path: relativePosix };
}
