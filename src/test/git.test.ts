import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGitArgs } from "../git/git.js";

describe("git allowlist bypasses", () => {
  it("rejects shell metachars", () => {
    assert.throws(() => validateGitArgs(["status;rm -rf"]));
    assert.throws(() => validateGitArgs(["status|cat"]));
    assert.throws(() => validateGitArgs(["$(whoami)"]));
    assert.throws(() => validateGitArgs(["${x}"]));
  });
  it("rejects colon exfil tricks", () => {
    assert.throws(() => validateGitArgs(["diff", "--upload-pack=x"]));
  });
  it("accepts known safe argv", () => {
    validateGitArgs(["status", "--porcelain=v1", "-b"]);
    validateGitArgs(["diff", "--no-color", "--", "."]);
  });
});
