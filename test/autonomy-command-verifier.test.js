import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeCommandCheck, commandCheckHash } from "../src/autonomy/command-verifier.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-verifier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"verifier-test","scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, "test", "sample.test.js"), 'import test from "node:test";test("ok",()=>{});');
  return await fs.realpath(root);
}

const npmCheck = () => ({ kind: "command", program: "npm", argv: ["test"], cwd: ".", timeoutMs: 5000 });
const nodeCheck = () => ({ kind: "command", program: "node", argv: ["--test", "test/sample.test.js"], cwd: ".", timeoutMs: 5000 });

function success(result = {}) {
  return { ok: true, exitCode: 0, signal: null, timedOut: false,
    durationMs: 15, stdout: "PASS", stderr: "", stdoutBytes: 4, stderrBytes: 0, ...result };
}

test("FV-02 records only bounded structured success evidence, not raw output", async (t) => {
  const root = await workspace(t);
  let invocation;
  const check = npmCheck();
  const proof = await executeCommandCheck(root, check, {
    run: async (args) => { invocation = args; return success({ stdout: "private test output" }); },
  });
  assert.deepEqual([invocation.program, invocation.argv, invocation.cwd],
    ["npm", ["test"], root]);
  assert.equal(invocation.inheritSensitiveEnv, false);
  assert.equal(invocation.maxOutputBytes, 4096);
  assert.equal(invocation.timeoutMs, 5000);
  assert.equal(proof.kind, "command");
  assert.equal(proof.checkHash, commandCheckHash(check));
  assert.equal(proof.exitCode, 0);
  assert.equal(proof.timedOut, false);
  assert.equal(proof.signal, null);
  assert.equal(proof.outputHash.length, 64);
  assert.doesNotMatch(JSON.stringify(proof), /private test output/);
});

test("FV-02 rejects nonzero exits, timeouts, signals, unknown completion and spawn errors", async (t) => {
  const root = await workspace(t);
  for (const [result, code] of [
    [success({ ok: false, exitCode: 1 }), "VERIFIER_COMMAND_FAILED"],
    [success({ ok: true, exitCode: 1 }), "VERIFIER_COMMAND_FAILED"],
    [success({ timedOut: true, ok: false }), "VERIFIER_TIMEOUT"],
    [success({ completionUnknown: true }), "VERIFIER_COMPLETION_UNKNOWN"],
    [success({ signal: "SIGKILL", ok: false }), "VERIFIER_COMMAND_FAILED"],
    [success({ error: new Error("sensitive failure"), ok: false }), "VERIFIER_SPAWN_FAILED"],
    [success({ exitCode: null, ok: false }), "VERIFIER_SPAWN_FAILED"],
    [undefined, "VERIFIER_COMPLETION_UNKNOWN"],
  ]) {
    await assert.rejects(executeCommandCheck(root, npmCheck(), { run: async () => result }),
      { code }, code);
  }
  await assert.rejects(executeCommandCheck(root, npmCheck(), {
    run: async () => { throw Error("secret path"); },
  }), { code: "VERIFIER_SPAWN_FAILED" });
});

test("FV-02 rejects unapproved executable, arguments, cwd and test paths at the execution boundary", async (t) => {
  const root = await workspace(t);
  let executed = 0;
  const run = async () => { executed++; return success(); };
  for (const check of [
    { ...npmCheck(), program: "powershell" },
    { ...npmCheck(), argv: ["run", "prepack"] },
    { ...npmCheck(), argv: ["install"] },
    { ...npmCheck(), cwd: "../" },
    { ...npmCheck(), timeoutMs: 500000 },
    { ...nodeCheck(), argv: ["-e", "console.log('bad')"] },
    { ...nodeCheck(), argv: ["--test", "../outside.test.js"] },
    { ...nodeCheck(), argv: ["--test", "test/../outside.test.js"] },
    { ...nodeCheck(), argv: ["--test", "test/missing.test.js"] },
  ]) {
    await assert.rejects(executeCommandCheck(root, check, { run }), { code: "VERIFIER_UNSAFE" });
  }
  assert.equal(executed, 0);
});

test("FV-02 requires real regular test files and rejects symlinked test paths", async (t) => {
  const root = await workspace(t);
  const outside = path.join(path.dirname(root), "outside.test.js");
  await fs.writeFile(outside, "test code");
  t.after(() => fs.rm(outside, { force: true }));
  await fs.rm(path.join(root, "test", "sample.test.js"));
  try {
    await fs.symlink(outside, path.join(root, "test", "sample.test.js"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Symlink creation not supported in this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(executeCommandCheck(root, nodeCheck(), { run: async () => success() }),
    { code: "VERIFIER_UNSAFE" });
});

test("FV-02 accepts node --test checks with real fixture and a successful injected process", async (t) => {
  const root = await workspace(t);
  const check = nodeCheck();
  const proof = await executeCommandCheck(root, check, { run: async () => success() });
  assert.equal(proof.checkHash, commandCheckHash(check));
  assert.equal(proof.exitCode, 0);
});
