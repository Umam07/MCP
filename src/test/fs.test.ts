import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "../fs/ops.js";

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fs-"));
}

describe("read_file line counting", () => {
  it("does not count trailing newline as extra line", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "l1\nl2\nl3\n");
    assert.equal(readFile(root, { path: "a.txt" }).totalLines, 3);
  });
  it("counts file without trailing newline correctly", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "b.txt"), "l1\nl2\nl3");
    assert.equal(readFile(root, { path: "b.txt" }).totalLines, 3);
  });
  it("empty file has 0 lines", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "e.txt"), "");
    const r = readFile(root, { path: "e.txt" });
    assert.equal(r.totalLines, 0);
    assert.equal(r.content, "");
  });
});
