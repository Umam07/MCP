import fs from "node:fs";
import path from "node:path";
import { resolvePath, shouldSkipDir } from "../security/paths.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 1000;

export interface ListOptions {
  path?: string;
  depth?: number;
  limit?: number;
  includeHidden?: boolean;
}

export interface ListEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
}

export function listDir(root: string, opts: ListOptions): { entries: ListEntry[]; truncated: boolean } {
  const rel = opts.path || ".";
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), 5);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), MAX_LIST_ENTRIES);
  const includeHidden = opts.includeHidden ?? false;

  const { absolute: absBase, relativePosix: baseRel } = resolvePath(root, rel);
  const stat = fs.statSync(absBase);
  if (!stat.isDirectory()) throw new Error("not a directory");

  const entries: ListEntry[] = [];
  let truncated = false;

  function walk(dirAbs: string, dirRel: string, currentDepth: number): boolean {
    if (entries.length >= limit) {
      truncated = true;
      return false;
    }
    const names = fs.readdirSync(dirAbs);
    for (const name of names) {
      if (entries.length >= limit) {
        truncated = true;
        return false;
      }
      if (!includeHidden && name.startsWith(".")) continue;
      if (shouldSkipDir(name)) continue;
      const childAbs = path.join(dirAbs, name);
      const childRel = dirRel === "." ? name : `${dirRel}/${name}`;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        entries.push({ path: childRel, type: "dir" });
        if (currentDepth < depth) {
          if (!walk(childAbs, childRel, currentDepth + 1)) return false;
        }
      } else if (st.isFile()) {
        entries.push({ path: childRel, type: "file", size: st.size });
      }
    }
    return true;
  }

  const startRel = baseRel === "" ? "." : baseRel;
  walk(absBase, startRel, 1);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, truncated };
}

export interface ReadOptions {
  path: string;
  startLine?: number;
  endLine?: number;
  lineNumbers?: boolean;
}

export function readFile(root: string, opts: ReadOptions): { path: string; content: string; totalLines: number; truncated: boolean; bytes: number } {
  const { absolute, relativePosix } = resolvePath(root, opts.path);
  const st = fs.statSync(absolute);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > MAX_FILE_BYTES && (opts.startLine === undefined && opts.endLine === undefined)) {
    throw new Error(`file too large (${st.size} bytes); use start_line/end_line to page`);
  }

  const buf = fs.readFileSync(absolute);
  // Binary guard: NUL byte in first 8KB.
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) throw new Error("binary file refused");

  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // A trailing newline terminates the last line; it is not an extra empty line.
  // ("a\n".split("\n") === ["a",""], but the file has 1 line, not 2.)
  let totalLines = lines.length;
  if (text.endsWith("\n")) totalLines -= 1;
  if (text === "") totalLines = 0;
  if (totalLines === 0) {
    return { path: relativePosix, content: "", totalLines: 0, truncated: false, bytes: st.size };
  }
  const start = opts.startLine ? Math.max(opts.startLine, 1) : 1;
  const end = opts.endLine ? Math.min(opts.endLine, totalLines) : totalLines;
  if (start > end) throw new Error("start_line is after end_line");

  const slice = lines.slice(start - 1, end);
  const lineNumbers = opts.lineNumbers ?? true;
  const content = lineNumbers
    ? slice.map((l, i) => `${start + i}:${l}`).join("\n")
    : slice.join("\n");
  const truncated = start > 1 || end < totalLines;
  return { path: relativePosix, content, totalLines, truncated, bytes: st.size };
}
