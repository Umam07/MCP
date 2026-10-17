import fs from "node:fs";
import path from "node:path";

// Windows-safe path sandbox for a single allowed root.
// Defends against: traversal, absolute escape, symlink/junction escape,
// ADS (colon), reserved names, trailing dot/space, case-insensitivity,
// 8.3 short names (via realpath), and secret file access.

const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const ALWAYS_SKIP_DIRS = new Set([".git", ".bridge", ".bridge-backup", "node_modules", ".next", "dist", "build", ".turbo", "coverage", ".vercel", ".expo", "vendor", "target"]);

const SECRET_FILE_RE = /(\.env(\.|$)|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|\.key$|credentials|secrets?|auth|tokens?)/i;

export function isReservedName(component: string): boolean {
  const base = component.split(".")[0].toLowerCase();
  return RESERVED_NAMES.has(base);
}

export function hasAdsSyntax(p: string): boolean {
  // Allow drive-letter colon at index 1 (e.g. C:\... or C:/...).
  // Any other colon means ADS (file:stream) or NTFS weirdness -> reject.
  const withoutDrive = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  return withoutDrive.includes(":");
}

export function isSecretPath(relativePosix: string): boolean {
  const lower = relativePosix.toLowerCase();
  if (lower.startsWith(".bridge/") || lower === ".bridge") return true;
  if (lower.startsWith(".bridge-backup/") || lower === ".bridge-backup") return true;
  if (/(^|\/)\.git(\/|$)/.test(lower)) return true;
  const base = lower.split("/").pop() || "";
  if (SECRET_FILE_RE.test(base)) return true;
  return false;
}

function insideRoot(root: string, candidate: string): boolean {
  const normRoot = path.resolve(root);
  const normCand = path.resolve(candidate);
  if (normCand === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  if (process.platform === "win32") {
    return normCand.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return normCand.startsWith(prefix);
}

// Best-effort realpath: resolve deepest existing ancestor, then append rest.
export function realpathTolerant(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let cur = p;
    const rest: string[] = [];
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...rest);
      } catch {
        cur = parent;
      }
    }
    return path.resolve(p);
  }
}

export interface ResolvedPath {
  absolute: string;
  relativePosix: string;
}

export function resolvePath(root: string, userPath: string): ResolvedPath {
  const trimmed = (userPath || "").trim().replace(/^["']+|["']+$/g, "");
  if (!trimmed) throw new Error("path must not be empty");
  if (trimmed.includes("\0")) throw new Error("NUL byte in path");
  if (hasAdsSyntax(trimmed)) throw new Error("alternate data streams are not allowed");

  // Reject absolute paths, UNC, device paths.
  if (
    path.isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("\\??\\") ||
    trimmed.startsWith("\\\\?\\")
  ) {
    throw new Error("absolute paths are not allowed (use root-relative paths)");
  }

  const normalized = path.normalize(trimmed);
  const parts = normalized.split(path.sep).filter((s) => s.length > 0);
  for (const part of parts) {
    if (part === ".." || part === ".") continue; // resolved via insideRoot check below
    if (isReservedName(part)) throw new Error(`reserved Windows name: ${part}`);
    if (/[. ]$/.test(part)) throw new Error(`trailing dot/space not allowed: ${part}`);
  }

  const candidate = path.resolve(root, normalized);
  if (!insideRoot(root, candidate)) {
    throw new Error("path escapes allowed root");
  }

  // Symlink/junction defense: lstat every existing component, then realpath containment.
  let cursor = path.resolve(root);
  const rel = path.relative(path.resolve(root), candidate);
  const relParts = rel.split(path.sep).filter(Boolean);
  for (const part of relParts) {
    cursor = path.join(cursor, part);
    try {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`symlink component not allowed: ${part}`);
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        // Missing tail is OK for create flows; stop lstat walk.
        break;
      }
      throw e;
    }
  }

  const realRoot = realpathTolerant(path.resolve(root));
  const realCandidate = realpathTolerant(candidate);
  if (!insideRoot(realRoot, realCandidate)) {
    throw new Error("symlink/junction escapes allowed root");
  }

  // Case-insensitivity + 8.3: realpath already canonicalizes on Windows.
  const relativePosix = path.relative(path.resolve(root), candidate).split(path.sep).join("/") || ".";
  if (isSecretPath(relativePosix)) {
    throw new Error("access to secret/internal path is blocked");
  }
  return { absolute: candidate, relativePosix };
}

export function shouldSkipDir(name: string): boolean {
  return ALWAYS_SKIP_DIRS.has(name);
}
