import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { parseTestSummary, assertSavedTestSummary } from "../src/autonomy/test-summary.js";
import { executeCommandCheck } from "../src/autonomy/command-verifier.js";
import {
  validateHttpCheck, executeHttpCheck, assertSavedHttpEvidence,
} from "../src/autonomy/http-verifier.js";
import { validateTaskPlan } from "../src/autonomy/task-coordinator.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-functional-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fv05-test","private":true}');
  return await fs.realpath(root);
}
function tap({ tests = 1, pass = 1, fail = 0, skipped = 0, cancelled = 0, todo = 0 } = {}) {
  return [
    "TAP version 13", "ok 1 - example",
    `# tests ${tests}`, `# pass ${pass}`, `# fail ${fail}`,
    `# cancelled ${cancelled}`, `# skipped ${skipped}`, `# todo ${todo}`,
  ].join("\n") + "\n";
}
const command = () => ({
  kind: "test", program: "node", argv: ["--test", "test/accept.test.js"],
  cwd: ".", timeoutMs: 10000, minTests: 1, maxSkipped: 0,
});
const requirements = { minTests: 1, maxSkipped: 0 };

test("FV-05 rejects zero, failed, skipped, todo, inconsistent, truncated or missing results", () => {
  assert.deepEqual(parseTestSummary(tap()), {
    tests: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0, todo: 0,
    ...requirements,
  });
  for (const [output, config] of [
    [tap({ tests: 0, pass: 0 }), {}],
    [tap({ fail: 1, pass: 0 }), {}],
    [tap({ skipped: 1, pass: 0 }), {}],
    [tap({ todo: 1, pass: 0 }), {}],
    [tap({ cancelled: 1, pass: 0 }), {}],
    [tap({ tests: 2, pass: 1 }), {}],
    ["PASS\n", {}],
    [tap(), { truncated: true }],
    [tap() + "# pass 1\n", {}],
  ]) {
    assert.throws(() => parseTestSummary(output, config));
  }
  assert.equal(parseTestSummary(tap({
    tests: 2, pass: 1, skipped: 1,
  }), { minTests: 1, maxSkipped: 1 }).skipped, 1);
  assert.throws(() => parseTestSummary(tap(), { minTests: 2 }),
    { code: "VERIFIER_TEST_FAILED" });
});

test("FV-05 persists checkable structured test results, rejects forged counts", () => {
  const check = command();
  const proof = {
    testSummary: {
      tests: 2, passed: 2, failed: 0, skipped: 0, cancelled: 0, todo: 0,
      minTests: 1, maxSkipped: 0,
    },
  };
  assert.doesNotThrow(() => assertSavedTestSummary(proof, check));
  assert.throws(() => assertSavedTestSummary({ testSummary: {
    ...proof.testSummary, failed: 1,
  } }, check), { code: "VERIFIER_TEST_RESULTS_INVALID" });
  assert.throws(() => assertSavedTestSummary({
    testSummary: { ...proof.testSummary, minTests: 0 },
  }, check), { code: "VERIFIER_TEST_RESULTS_INVALID" });
});

test("FV-05 real restricted Node test verification rejects skipped and zero tests", async (t) => {
  const root = await workspace(t);
  const file = path.join(root, "test", "accept.test.js");
  await fs.writeFile(file, 'const test = require("node:test"); test("success", () => {});\n');
  const check = command();
  const success = await executeCommandCheck(root, check, { testRequirements: requirements });
  assert.equal(success.testSummary.passed, 1);
  assert.equal(success.testSummary.failed, 0);
  assert.match(success.inputsHash, /^[a-f0-9]{64}$/);

  await fs.writeFile(file, 'const test = require("node:test"); test.skip("not implemented", () => {});\n');
  await assert.rejects(
    executeCommandCheck(root, check, { testRequirements: requirements }),
    { code: "VERIFIER_TEST_FAILED" },
  );
  await fs.writeFile(file, "// no tests registered\n");
  await assert.rejects(
    executeCommandCheck(root, check, { testRequirements: requirements }),
    { code: "VERIFIER_TEST_FAILED" },
  );
});

test("FV-05 validates test and integration plans without arbitrary commands or hosts", () => {
  const plan = (check) => ({
    goal: "verify observable behavior",
    tasks: [{ id: "verify", instruction: "check", dependsOn: [], acceptance: [check] }],
  });
  assert.equal(validateTaskPlan(plan(command())).tasks[0].acceptance[0].kind, "test");
  assert.throws(() => validateTaskPlan(plan({ ...command(), minTests: 0 })));
  assert.throws(() => validateTaskPlan(plan({ ...command(), program: "npm" })));
  assert.throws(() => validateTaskPlan(plan({ ...command(), argv: ["-e", "1"] })));
  assert.equal(validateTaskPlan(plan({
    kind: "integration", port: 18080, path: "/health", expectedStatus: 200,
    expectedContains: "ready",
  })).tasks[0].acceptance[0].kind, "integration");
  for (const extra of [
    { port: 80 }, { port: 65536 }, { path: "http://example.com/" },
    { path: "//example.com/" }, { expectedStatus: 302 },
    { timeoutMs: 100000 }, { method: "POST" },
  ]) {
    assert.throws(() => validateHttpCheck({
      kind: "integration", port: 18080, path: "/health", expectedStatus: 200,
      expectedContains: "ready", ...extra,
    }));
  }
});

async function localhost(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("FV-05 restricted localhost probe verifies real HTTP output and stores only metadata", async (t) => {
  const root = await workspace(t);
  const port = await localhost(t, (_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ready","secret":"do-not-store"}');
  });
  const check = validateHttpCheck({
    kind: "integration", port, path: "/health", expectedStatus: 200,
    expectedContains: '"status":"ready"',
  });
  const proof = await executeHttpCheck(root, check);
  assert.equal(proof.statusCode, 200);
  assert.equal(proof.containsExpected, true);
  assert.match(proof.bodyHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(proof), /do-not-store/);
  assert.doesNotThrow(() => assertSavedHttpEvidence(proof, check));
  assert.throws(() => assertSavedHttpEvidence({ ...proof, statusCode: 500 }, check),
    { code: "VERIFIER_EVIDENCE_INVALID" });
  await assert.rejects(executeHttpCheck(root, {
    ...check, expectedContains: "unavailable",
  }), { code: "VERIFIER_HTTP_FAILED" });
  await assert.rejects(executeHttpCheck(root, {
    ...check, expectedStatus: 201,
  }), { code: "VERIFIER_HTTP_FAILED" });
});

test("FV-05 localhost probe fails closed on oversized output and redirect", async (t) => {
  const root = await workspace(t);
  const port = await localhost(t, (request, response) => {
    if (request.url === "/big") {
      response.writeHead(200);
      response.end("A".repeat(18000) + "ready");
    } else {
      response.writeHead(302, { location: "/big" });
      response.end("ready");
    }
  });
  for (const route of ["/big", "/redirect"]) {
    await assert.rejects(executeHttpCheck(root, {
      kind: "integration", port, path: route,
      expectedStatus: 200, expectedContains: "ready", timeoutMs: 5000,
    }), { code: "VERIFIER_HTTP_FAILED" });
  }
});
