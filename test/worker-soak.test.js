
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/worker-soak.js", import.meta.url));

function runSoak(args, timeout = 110_000) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

test("RR-03 50-cycle mocked-browser soak recovers worker termination and transport fault with no replayed side effects", {
  timeout: 120_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rr03-report-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report.json");
  const result = runSoak(["--cycles=50", `--report=${reportPath}`]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `Soak failed: ${String(result.stderr).slice(-1200)}`);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed, report, "stdout and report must represent the same result");
  assert.equal(report.schema, 1);
  assert.equal(report.suite, "RR-03-WINDOWS-WORKER-SOAK");
  assert.equal(report.status, "passed");
  assert.equal(report.cyclesRequested, 50);
  assert.equal(report.toolExecutions, 50);
  assert.equal(report.distinctSideEffects, 50);
  assert.equal(report.duplicatedSideEffects, 0);
  assert.ok(report.reusedToolResults >= 2);
  assert.deepEqual(report.faultInjection.stages.map(s => s.stage), [
    "crash", "transport", "finish",
  ]);
  assert.deepEqual(report.faultInjection.stages.map(s => s.exitCode), [73, 74, 0]);
  assert.deepEqual(report.faultInjection.stages.map(s => s.journalCount), [16, 33, 50]);
  assert.equal(report.faultInjection.processCrashAfterCycle, 16);
  assert.equal(report.faultInjection.droppedToolResultAtCycle, 33);
  assert.equal(report.evidence.provider, "mocked-browser");
  assert.equal(report.evidence.runtime, "real-AgentRuntime");
  assert.equal(report.evidence.processExit, "real-node-child-exit");
  assert.equal(report.evidence.liveBrowserSmoke, "NOT_RUN");
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /wtagent-soak-|rr03-report-test-|(?:[A-Za-z]:\\|\/Users\/|\/home\/)/);
  assert.doesNotMatch(serialized, /session-id|conversationUrl|assistantMessageId|token|password|apiKey/);
});

test("RR-03 rejects unbounded soak cycles and invalid options", () => {
  for (const args of [
    ["--cycles=49"], ["--cycles=201"], ["--cycles=Infinity"],
    ["--cycles=20.5"], ["--bogus"],
  ]) {
    const run = runSoak(args, 5_000);
    assert.notEqual(run.status, 0, `Unexpected success for ${args.join(" ")}`);
    assert.equal(run.error, undefined, `Unexpected launch error for ${args.join(" ")}`);
  }
});
