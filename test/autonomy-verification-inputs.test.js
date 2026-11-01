import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fingerprintVerificationInputs,
  assertVerificationInputsUnchanged,
} from "../src/autonomy/verification-inputs.js";
import { executeCommandCheck } from "../src/autonomy/command-verifier.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-inputs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, "test", "sample.test.js"),
    'const test = require("node:test");test("ok",()=>{});');
  await fs.writeFile(path.join(root, "src", "app.js"), "export const value = 1;\n");
  return await fs.realpath(root);
}

const command = () => ({
  kind: "command", program: "node", argv: ["--test", "test/sample.test.js"],
  cwd: ".", timeoutMs: 5000,
});

const success = () => ({
  ok: true, exitCode: 0, signal: null, timedOut: false,
  stdout: "pass", stderr: "", stdoutBytes: 4, stderrBytes: 0, durationMs: 10,
});

test("FV-04 fingerprints verification source, tests, npm configuration and file membership", async (t) => {
  const root = await fixture(t);
  const initial = await fingerprintVerificationInputs(root);
  assert.equal(initial.inputsSchema, 1);
  assert.equal(initial.inputFileCount, 3);
  assert.match(initial.inputsHash, /^[a-f0-9]{64}$/);
  assert.equal(await assertVerificationInputsUnchanged(root, initial), true);
  await fs.writeFile(path.join(root, "src", "app.js"), "export const value = 2;\n");
  await assert.rejects(assertVerificationInputsUnchanged(root, initial),
    { code: "VERIFIER_INPUT_DRIFT" });
  const changed = await fingerprintVerificationInputs(root);
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"exit 0"}}');
  await assert.rejects(assertVerificationInputsUnchanged(root, changed),
    { code: "VERIFIER_INPUT_DRIFT" });
  const third = await fingerprintVerificationInputs(root);
  await fs.writeFile(path.join(root, "test", "additional.test.js"), "// new test\n");
  await assert.rejects(assertVerificationInputsUnchanged(root, third),
    { code: "VERIFIER_INPUT_DRIFT" });
});

test("FV-04 input scan excludes generated root artifacts while limiting scope", async (t) => {
  const root = await fixture(t);
  const initial = await fingerprintVerificationInputs(root);
  await fs.writeFile(path.join(root, "test-output.txt"), "generated");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "pkg.js"), "ignored");
  assert.equal(await assertVerificationInputsUnchanged(root, initial), true);
  await fs.writeFile(path.join(root, "test", "large.test.js"),
    Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(fingerprintVerificationInputs(root),
    { code: "VERIFIER_INPUT_LIMIT" });
});

test("FV-04 rejects symlinked source inputs and missing fingerprints", async (t) => {
  const root = await fixture(t);
  const snapshot = await fingerprintVerificationInputs(root);
  await assert.rejects(assertVerificationInputsUnchanged(root, {}),
    { code: "VERIFIER_EVIDENCE_INVALID" });
  const link = path.join(root, "src", "link.js");
  try {
    await fs.symlink(path.join(root, "src", "app.js"), link);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Symlink creation not supported by this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(fingerprintVerificationInputs(root),
    { code: "VERIFIER_INPUT_UNSAFE" });
  await assert.rejects(assertVerificationInputsUnchanged(root, snapshot),
    { code: "VERIFIER_INPUT_UNSAFE" });
});

test("FV-04 blocks verification if project-controlled inputs change during the command", async (t) => {
  const root = await fixture(t);
  await assert.rejects(executeCommandCheck(root, command(), {
    run: async () => {
      await fs.writeFile(path.join(root, "test", "sample.test.js"),
        'const test = require("node:test");test("changed",()=>{});');
      return success();
    },
  }), { code: "VERIFIER_INPUT_DRIFT" });
});

test("FV-04 successful command proofs bind inputs without storing their contents", async (t) => {
  const root = await fixture(t);
  const proof = await executeCommandCheck(root, command(), {
    run: async () => success(),
  });
  assert.equal(proof.inputsSchema, 1);
  assert.equal(proof.inputFileCount, 3);
  assert.match(proof.inputsHash, /^[a-f0-9]{64}$/);
  assert.equal(await assertVerificationInputsUnchanged(root, proof), true);
  assert.doesNotMatch(JSON.stringify(proof), /export const value/);
});
