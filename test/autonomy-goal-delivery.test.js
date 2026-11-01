import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { TaskCoordinator, validateTaskPlan } from "../src/autonomy/task-coordinator.js";
import { readEvidenceDeliveryReport } from "../src/autonomy/delivery-report.js";

async function setup(t, { artifact = "ready" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-fv06-"));
  const workspaceRoot = path.join(root, "workspace");
  const stateFile = path.join(root, "checkpoint", "plan.json");
  await fs.mkdir(path.join(workspaceRoot, "test"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "package.json"),
    '{"name":"fv06-goal","private":true,"type":"module"}');
  await fs.writeFile(path.join(workspaceRoot, "test", "accept.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'test("artifact actually works", () => {',
    '  assert.equal(readFileSync("artifact.txt", "utf8"), "ready");',
    '});',
    '',
  ].join("\n"));
  const executions = [];
  let supervisor;
  const initialize = async () => {
    const instance = new TaskSupervisor({
      dataDir: path.join(root, "supervisor"),
      sessionsDir: path.join(root, "sessions"),
      workspaces: [{ id: "main", root: workspaceRoot }],
      execute: async ({ session }) => {
        assert.equal(session.state.task, "build artifact");
        executions.push("build");
        await fs.writeFile(path.join(workspaceRoot, "artifact.txt"), artifact);
        return { message: "artifact created" };
      },
      options: { recovery: { retryBaseMs: 5, retryMaxMs: 10, maxRetries: 1 } },
    });
    await instance.init();
    supervisor = instance;
    return instance;
  };
  await initialize();
  t.after(async () => {
    try {
      await supervisor?.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const plan = (withFinal = true) => ({
    goal: "Deliver a working artifact, not merely a file",
    tasks: [{
      id: "build", instruction: "build artifact", dependsOn: [],
      acceptance: [{ kind: "file", path: "artifact.txt" }],
    }],
    ...(withFinal ? {
      finalAcceptance: [{
        kind: "test", program: "node",
        argv: ["--test", "test/accept.test.js"], cwd: ".",
        timeoutMs: 15000, minTests: 1, maxSkipped: 0,
      }],
    } : {}),
  });
  const create = (withFinal = true) => TaskCoordinator.create({
    stateFile, workspaceRoot, workspaceId: "main", supervisor, plan: plan(withFinal),
  });
  const load = () => TaskCoordinator.load({
    stateFile, workspaceRoot, workspaceId: "main", supervisor,
  });
  return { root, workspaceRoot, stateFile, executions, plan, create, load,
    restart: async () => { await supervisor.close(); await initialize(); } };
}

test("FV-06 rejects malformed or nonbehavioral final goal checks", () => {
  const base = {
    goal: "goal",
    tasks: [{ id: "build", instruction: "build", dependsOn: [],
      acceptance: [{ kind: "file", path: "artifact.txt" }] }],
  };
  for (const finalAcceptance of [
    [], [{ kind: "file", path: "artifact.txt" }],
    [{ kind: "command", program: "node", argv: ["--test", "test/accept.test.js"] }],
    [{ kind: "test", program: "node", argv: ["--test", "../outside.js"] }],
  ]) {
    assert.throws(() => validateTaskPlan({ ...base, finalAcceptance }));
  }
  assert.equal(validateTaskPlan(base).finalAcceptance, undefined);
  assert.deepEqual(validateTaskPlan(validateTaskPlan(base)), validateTaskPlan(base));
});

test("FV-06 file exists but real behavior fails: block goal delivery", async (t) => {
  const ctx = await setup(t, { artifact: "broken" });
  const coordinator = await ctx.create();
  const state = await coordinator.run({ timeoutMs: 20000, pollMs: 5 });
  assert.equal(state.tasks[0].status, "VERIFIED");
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.goalDelivery.status, "BLOCKED");
  assert.equal(state.goalDelivery.receipt, null);
  const report = coordinator.getDeliveryReport();
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.tasks[0].artifactVerified, true);
  assert.equal(report.tasks[0].taskVerified, true);
  assert.equal(report.evidencedFinalChecks, 0);
  assert.equal(report.unverifiedCapabilities.length, 1);
  assert.deepEqual(ctx.executions, ["build"]);
  const resumed = await ctx.load();
  assert.equal((await resumed.run({ timeoutMs: 200, pollMs: 5 })).status, "BLOCKED");
  assert.deepEqual(ctx.executions, ["build"]);
});

test("FV-06 real final test produces DELIVERED receipt and resumes read-only", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create();
  const state = await coordinator.run({ timeoutMs: 20000, pollMs: 5 });
  assert.equal(state.status, "VERIFIED", state.lastError ?? "");
  assert.equal(state.goalDelivery.status, "DELIVERED");
  assert.match(state.goalDelivery.receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(state.goalDelivery.evidence[0].testSummary.passed, 1);
  assert.equal(coordinator.getDeliveryReport().status, "DELIVERED");
  assert.equal(coordinator.getDeliveryReport().unverifiedCapabilities.length, 0);
  const report=await readEvidenceDeliveryReport({
    stateFile:ctx.stateFile,workspaceRoot:ctx.workspaceRoot,
  });
  assert.equal(report.deliveryStatus,"DELIVERED",JSON.stringify(report.unmetRequirements));
  assert.equal(report.coordinatorStatus,"VERIFIED");
  assert.equal(report.unmetRequirements.length,0);
  assert.equal(report.tasks.length,1);
  assert.ok(report.tasks[0].receiptValid);
  assert.ok(report.tasks[0].checks.every(check=>check.satisfied));
  assert.ok(report.finalAcceptance.every(check=>check.satisfied));
  assert.match(report.reportDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(ctx.executions,["build"]);
  const original = structuredClone(state.goalDelivery);
  await ctx.restart();
  const resumed = await ctx.load();
  const again = await resumed.run({ timeoutMs: 5000, pollMs: 5 });
  assert.equal(again.status, "VERIFIED");
  assert.deepEqual(again.goalDelivery, original);
  const reattachedReport=await readEvidenceDeliveryReport({
    stateFile:ctx.stateFile,workspaceRoot:ctx.workspaceRoot,
  });
  assert.deepEqual(reattachedReport,report);
  assert.deepEqual(ctx.executions, ["build"]);
});

test("FV-06 changing behavior after DELIVERED blocks on read-only revalidation", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create();
  assert.equal((await coordinator.run({ timeoutMs: 20000, pollMs: 5 })).goalDelivery.status,
    "DELIVERED");
  await fs.writeFile(path.join(ctx.workspaceRoot, "test", "accept.test.js"),
    'import test from "node:test"; test("tampered", () => {});\n');
  const resumed = await ctx.load();
  const state = await resumed.run({ timeoutMs: 1000, pollMs: 5 });
  assert.equal(state.status, "BLOCKED");
  assert.notEqual(resumed.getDeliveryReport().status, "DELIVERED");
});

test("FV-06 delivered goal revokes receipt after task artifact drift and reloads safely", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create();
  const delivered = await coordinator.run({ timeoutMs: 20000, pollMs: 5 });
  assert.equal(delivered.goalDelivery.status, "DELIVERED");

  await fs.writeFile(path.join(ctx.workspaceRoot, "artifact.txt"), "tampered");
  const invalidated = await coordinator.tick();
  assert.equal(invalidated.status, "BLOCKED");
  assert.equal(invalidated.goalDelivery.status, "BLOCKED");
  assert.equal(invalidated.goalDelivery.receipt, null);
  assert.equal(coordinator.getDeliveryReport().status, "BLOCKED");

  const resumed = await ctx.load();
  const resumedState = await resumed.run({ timeoutMs: 1000, pollMs: 5 });
  assert.equal(resumedState.status, "BLOCKED");
  assert.equal(resumed.getDeliveryReport().status, "BLOCKED");
  assert.deepEqual(ctx.executions, ["build"]);
});

test("FV-06 modified goal receipt cannot claim delivery", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create();
  assert.equal((await coordinator.run({ timeoutMs: 20000, pollMs: 5 })).goalDelivery.status,
    "DELIVERED");
  const persisted = JSON.parse(await fs.readFile(ctx.stateFile, "utf8"));
  persisted.goalDelivery.receipt.evidenceHash = "0".repeat(64);
  await fs.writeFile(ctx.stateFile, JSON.stringify(persisted));
  await assert.rejects(() => ctx.load(), { code: "GOAL_EVIDENCE_INVALID" });
});

test("FV-06 interrupted final test must not run again on recovery", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create();
  const state = await coordinator.run({ timeoutMs: 20000, pollMs: 5 });
  assert.equal(state.goalDelivery.status, "DELIVERED");
  const persisted = JSON.parse(await fs.readFile(ctx.stateFile, "utf8"));
  persisted.status = "RUNNING";
  persisted.goalDelivery = {
    ...persisted.goalDelivery, status: "PENDING", verificationStarted: true,
    evidence: null, receipt: null, error: null,
  };
  await fs.writeFile(ctx.stateFile, JSON.stringify(persisted));
  const resumed = await ctx.load();
  const recovery = await resumed.run({ timeoutMs: 1000, pollMs: 5 });
  assert.equal(recovery.status, "BLOCKED");
  assert.equal(recovery.lastError, "GOAL_COMPLETION_UNKNOWN");
  assert.deepEqual(ctx.executions, ["build"]);
});

test("FV-06 plans without whole-goal checks report UNVERIFIED, not DELIVERED", async (t) => {
  const ctx = await setup(t);
  const coordinator = await ctx.create(false);
  const state = await coordinator.run({ timeoutMs: 20000, pollMs: 5 });
  assert.equal(state.status, "VERIFIED");
  assert.equal(coordinator.getDeliveryReport().status, "UNVERIFIED");
  assert.equal(coordinator.getDeliveryReport().unverifiedCapabilities.length, 1);
});
