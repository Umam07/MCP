import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseScripts, validateScriptArgv, runScript } from "../exec/run.js";

describe("script config validation", () => {
  it("accepts a named npm script", () => {
    const s = parseScripts(JSON.stringify({ check: ["npm", "run", "check"] }));
    assert.deepEqual(s, { check: ["npm", "run", "check"] });
  });
  it("empty/missing means no scripts", () => {
    assert.deepEqual(parseScripts(undefined), {});
    assert.deepEqual(parseScripts("  "), {});
  });
  it("rejects non-JSON and non-object", () => {
    assert.throws(() => parseScripts("{bad"), /JSON/);
    assert.throws(() => parseScripts("[1]"), /object/);
  });
  it("rejects shell binaries", () => {
    assert.throws(() => validateScriptArgv("x", ["cmd", "/c", "dir"]), /shell/);
    assert.throws(() => validateScriptArgv("x", ["bash", "run.sh"]), /shell/);
    assert.throws(() => validateScriptArgv("x", ["powershell", "-File", "a.ps1"]), /shell/);
  });
  it("rejects interpreter one-liners but allows fixed files", () => {
    assert.throws(() => validateScriptArgv("x", ["node", "-e", "1"]), /inline-code/);
    assert.throws(() => validateScriptArgv("x", ["python", "-c", "1"]), /inline-code/);
    validateScriptArgv("ok", ["node", "check.js"]);
    validateScriptArgv("ok", ["npm", "run", "check"]);
  });
  it("rejects shell-script binaries", () => {
    assert.throws(() => validateScriptArgv("x", ["tool.ps1", "a"]), /shell script/);
    assert.throws(() => validateScriptArgv("x", ["run.sh", "a"]), /shell script/);
  });
  it("rejects shell metachars and bad names", () => {
    assert.throws(() => validateScriptArgv("x", ["npm", "run", "a;rm"]), /metacharacters/);
    assert.throws(() => validateScriptArgv("a b", ["npm", "run", "x"]), /bad script name/);
    assert.throws(() => parseScripts(JSON.stringify({ "evil;": ["npm", "run", "x"] })), /bad script name/);
  });
});

describe("runScript", () => {
  it("runs a fixed script file and captures output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-exec-"));
    fs.writeFileSync(path.join(dir, "hello.js"), "console.log('hi-exec');");
    const r = await runScript(dir, { hi: ["node", "hello.js"] }, "hi", ".", 15000);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /hi-exec/);
    assert.equal(r.timedOut, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("rejects unknown script names (no free-form commands)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-exec-"));
    await assert.rejects(() => runScript(dir, { hi: ["node", "hello.js"] }, "rm -rf /", "."), /unknown script/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("rejects bad working dirs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-exec-"));
    await assert.rejects(() => runScript(dir, { hi: ["node", "hello.js"] }, "hi", "../outside"), /escapes|not an existing directory/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
