import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePath } from "../security/paths.js";

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "hi");
  return dir;
}

describe("path traversal defense", () => {
  it("blocks .. escape", () => {
    const root = makeRoot();
    assert.throws(() => resolvePath(root, "../outside"));
    assert.throws(() => resolvePath(root, "sub/../../outside"));
  });
  it("blocks absolute and UNC", () => {
    const root = makeRoot();
    assert.throws(() => resolvePath(root, "C:\\Windows\\x"));
    assert.throws(() => resolvePath(root, "\\\\server\\share"));
    assert.throws(() => resolvePath(root, "/etc/passwd"));
  });
  it("blocks ADS colon and reserved names", () => {
    const root = makeRoot();
    assert.throws(() => resolvePath(root, "file.txt:secret"));
    assert.throws(() => resolvePath(root, "CON"));
    assert.throws(() => resolvePath(root, "sub/COM1.txt"));
    assert.throws(() => resolvePath(root, "trailingdot."));
  });
  it("blocks secret paths", () => {
    const root = makeRoot();
    assert.throws(() => resolvePath(root, ".env"));
    assert.throws(() => resolvePath(root, ".git/config"));
    assert.throws(() => resolvePath(root, ".bridge/oauth.json"));
    assert.throws(() => resolvePath(root, "key.pem"));
  });
  it("allows normal relative file", () => {
    const root = makeRoot();
    const r = resolvePath(root, "sub/a.txt");
    assert.equal(r.relativePosix, "sub/a.txt");
  });
  it("allows root-relative '.'", () => {
    const root = makeRoot();
    assert.equal(resolvePath(root, ".").relativePosix, ".");
    assert.equal(resolvePath(root, "./").relativePosix, ".");
  });
  it("blocks symlink component", () => {
    const root = makeRoot();
    const link = path.join(root, "evil");
    try {
      fs.symlinkSync(path.join(root, "sub"), link, "junction");
    } catch {
      return; // symlink privilege missing on CI; skip
    }
    assert.throws(() => resolvePath(root, "evil/a.txt"));
  });
});
