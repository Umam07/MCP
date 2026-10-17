import fs from "node:fs";
import path from "node:path";
import { resolvePath, shouldSkipDir } from "../security/paths.js";

export interface SearchOptions {
  pattern: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
  maxResults?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

const MAX_RESULTS_CAP = 100;
const MAX_FILE_SCAN_BYTES = 512 * 1024;

function globToRegExp(glob: string): RegExp {
  // Minimal glob: *, ?, **. Case-insensitive on Windows.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const flags = process.platform === "win32" ? "i" : "";
  return new RegExp(`^(?:${re})$`, flags);
}

export function searchCode(root: string, opts: SearchOptions): { hits: SearchHit[]; truncated: boolean; scanned: number } {
  if (!opts.pattern) throw new Error("pattern is required");
  const rel = opts.path || ".";
  const { absolute: absBase } = resolvePath(root, rel);
  const maxResults = Math.min(Math.max(opts.maxResults ?? 50, 1), MAX_RESULTS_CAP);
  const context = Math.min(Math.max(opts.contextLines ?? 0, 0), 5);

  const matcher: (line: string) => boolean = opts.regex
    ? (() => {
        const flags = opts.caseSensitive ? "" : "i";
        let re: RegExp;
        try {
          re = new RegExp(opts.pattern, flags);
        } catch {
          throw new Error("invalid regex pattern");
        }
        return (line: string) => re.test(line);
      })()
    : (() => {
        const needle = opts.caseSensitive ? opts.pattern : opts.pattern.toLowerCase();
        return (line: string) => {
          const hay = opts.caseSensitive ? line : line.toLowerCase();
          return hay.includes(needle);
        };
      })();

  const globRe = opts.glob ? globToRegExp(opts.glob) : null;
  const hits: SearchHit[] = [];
  let scanned = 0;
  let truncated = false;
  const visited = new Set<string>();

  function walk(dirAbs: string): boolean {
    let names: string[];
    try {
      names = fs.readdirSync(dirAbs);
    } catch {
      return true;
    }
    for (const name of names) {
      if (hits.length >= maxResults) {
        truncated = true;
        return false;
      }
      if (name.startsWith(".") && name !== ".") {
        // Skip hidden files/dirs unless explicitly rooted inside them.
      }
      if (shouldSkipDir(name)) continue;
      const childAbs = path.join(dirAbs, name);
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      let real: string;
      try {
        real = fs.realpathSync(childAbs);
      } catch {
        real = childAbs;
      }
      if (visited.has(real.toLowerCase())) continue;
      visited.add(real.toLowerCase());
      if (lst.isDirectory()) {
        if (!walk(childAbs)) return false;
      } else if (lst.isFile()) {
        if (lst.size > MAX_FILE_SCAN_BYTES) continue;
        const relPosix = path.relative(path.resolve(root), childAbs).split(path.sep).join("/");
        if (globRe && !globRe.test(relPosix) && !globRe.test(name)) continue;
        const buf = fs.readFileSync(childAbs);
        if (buf.subarray(0, 8192).includes(0)) continue;
        scanned += 1;
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxResults) {
            truncated = true;
            return false;
          }
          if (matcher(lines[i])) {
            hits.push({
              path: relPosix,
              line: i + 1,
              text: lines[i].slice(0, 500),
              contextBefore: context ? lines.slice(Math.max(0, i - context), i) : undefined,
              contextAfter: context ? lines.slice(i + 1, i + 1 + context) : undefined,
            });
          }
        }
      }
    }
    return true;
  }

  const st = fs.statSync(absBase);
  if (st.isFile()) {
    // Single-file search.
    const buf = fs.readFileSync(absBase);
    if (!buf.subarray(0, 8192).includes(0)) {
      scanned += 1;
      const lines = buf.toString("utf8").split("\n");
      const relPosix = path.relative(path.resolve(root), absBase).split(path.sep).join("/");
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        if (matcher(lines[i])) {
          hits.push({ path: relPosix, line: i + 1, text: lines[i].slice(0, 500) });
        }
      }
      truncated = hits.length >= maxResults;
    }
  } else {
    walk(absBase);
  }
  return { hits, truncated, scanned };
}
