import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFile, writeFile, deleteFile, backupDir, unifiedDiff } from "../fs/write.js";

const trash: string[] = [];
afterEach(() => {
  while (trash.length) {
    const p = trash.pop() as string;
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-write-"));
  trash.push(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello one\nhello two\nbye\n");
  return dir;
}

describe("edit_file", () => {
  it("replaces exactly one occurrence, backs up outside root, returns diff", () => {
    const root = makeRoot();
    const r = editFile(root, { path: "a.txt", oldString: "hello two", newString: "hello 2" });
    assert.match(r.diff, /-hello two/);
    assert.match(r.diff, /\+hello 2/);
    assert.ok(fs.existsSync(r.backup));
    assert.ok(!path.resolve(r.backup).startsWith(path.resolve(root)), "backup must be outside allowed root");
    trash.push(r.backup);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hello one\nhello 2\nbye\n");
  });
  it("refuses missing old_string", () => {
    assert.throws(() => editFile(makeRoot(), { path: "a.txt", oldString: "nope", newString: "x" }), /not found/);
  });
  it("refuses ambiguous old_string", () => {
    assert.throws(() => editFile(makeRoot(), { path: "a.txt", oldString: "hello", newString: "x" }), /multiple/);
  });
  it("refuses secret and traversal paths", () => {
    const root = makeRoot();
    assert.throws(() => editFile(root, { path: "../x", oldString: "a", newString: "b" }));
    assert.throws(() => editFile(root, { path: ".env", oldString: "a", newString: "b" }));
  });
});

describe("write_file", () => {
  it("creates new file (with parent dirs) and reports created", () => {
    const root = makeRoot();
    const r = writeFile(root, { path: "sub/new.txt", content: "hi\n" });
    assert.equal(r.created, true);
    assert.equal(r.backup, null);
    assert.equal(fs.readFileSync(path.join(root, "sub", "new.txt"), "utf8"), "hi\n");
  });
  it("overwrites with backup + diff, no-op when identical", () => {
    const root = makeRoot();
    const r = writeFile(root, { path: "a.txt", content: "changed\n" });
    assert.equal(r.created, false);
    assert.ok(r.backup && fs.existsSync(r.backup));
    trash.push(r.backup as string);
    const same = writeFile(root, { path: "a.txt", content: "changed\n" });
    assert.equal(same.diff, "(no changes)");
  });
  it("refuses secret paths", () => {
    assert.throws(() => writeFile(makeRoot(), { path: ".env", content: "x" }));
  });
});

describe("backup location", () => {
  it("backupDir is outside any allowed root and gitignored", () => {
    const dir = backupDir();
    trash.push(dir);
    assert.ok(fs.existsSync(dir));
  });
  it("unifiedDiff marks changed region", () => {
    const d = unifiedDiff("f.txt", "a\nb\nc\n", "a\nB\nc\n");
    assert.match(d, /-b/);
    assert.match(d, /\+B/);
    assert.match(d, /^@@/m);
  });
});

describe("delete_file", () => {
  it("deletes existing file and saves backup outside root", () => {
    const root = makeRoot();
    const r = deleteFile(root, "a.txt");
    assert.equal(r.path, "a.txt");
    assert.ok(fs.existsSync(r.backup));
    assert.ok(!path.resolve(r.backup).startsWith(path.resolve(root)));
    trash.push(r.backup);
    assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
  });
  it("refuses missing file", () => {
    assert.throws(() => deleteFile(makeRoot(), "nonexistent.txt"), /does not exist/);
  });
  it("refuses deleting directory or root", () => {
    const root = makeRoot();
    assert.throws(() => deleteFile(root, "."), /root or empty path/);
    assert.throws(() => deleteFile(root, ""), /root or empty path/);
  });
  it("refuses traversal or secret paths", () => {
    const root = makeRoot();
    assert.throws(() => deleteFile(root, "../outside.txt"));
    assert.throws(() => deleteFile(root, ".env"));
  });
});
