
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

const fileTask = (id, instruction, dependsOn = []) => ({
  id, instruction, dependsOn,
  acceptance: [{ kind: "file", path: `${id}.txt`, minBytes: 1 }],
});

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-dp03-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const stateFile = path.join(base, "checkpoint", "state.json");
  await fs.mkdir(workspaceRoot);
  const byKey = new Map();
  const records = new Map();
  const executions = new Map();
  const attempts = new Map();
  const calls = [];
  let onSubmission = null;
  const supervisor = {
    calls, attempts, executions,
    setSubmissionHook(hook) { onSubmission = hook; },
    async create({ workspaceId, instruction, idempotencyKey }) {
      attempts.set(instruction, (attempts.get(instruction) ?? 0) + 1);
      if (byKey.has(idempotencyKey)) {
        const existing = byKey.get(idempotencyKey);
        assert.equal(existing.instruction, instruction,
          "Stable idempotency key must not change its instruction");
        return { taskId: existing.taskId };
      }
      const taskId = `task_${randomUUID()}`;
      const record = {
        taskId, status: options.running?.has(instruction) ? "running" : "completed",
        workspaceRoot, workspaceId, instruction, idempotencyKey,
      };
      byKey.set(idempotencyKey, record);
      records.set(taskId, record);
      calls.push(instruction);
      executions.set(instruction, (executions.get(instruction) ?? 0) + 1);
      const filename = instruction === "build preflight" ? "preflight.txt"
        : instruction === "build final" ? "final.txt"
        : instruction === "build one" ? "one.txt"
        : instruction === "build two" ? "two.txt"
        : instruction === "build three" ? "three.txt"
        : instruction === "build fourth" ? "fourth.txt" : null;
      if (filename && record.status === "completed") {
        await fs.writeFile(path.join(workspaceRoot, filename), `verified:${instruction}`);
      }
      if (onSubmission) await onSubmission(record);
      return { taskId };
    },
    get(taskId) {
      const record = records.get(taskId);
      if (!record) throw Error("Unknown Supervisor task " + taskId);
      return { ...record };
    },
    async complete(instruction) {
      const record = [...records.values()].find(item => item.instruction === instruction);
      assert.ok(record, "Expected submitted task");
      record.status = "completed";
      const name = instruction.replace("build ", "") + ".txt";
      await fs.writeFile(path.join(workspaceRoot, name), `verified:${instruction}`);
    },
  };
  const plan = {
    goal: "Produce a dependent chain without replaying completed steps",
    tasks: [
      fileTask("one", "build one"),
      fileTask("two", "build two", ["one"]),
      fileTask("three", "build three", ["two"]),
    ],
  };
  const params = { stateFile, workspaceRoot, workspaceId: "main", supervisor };
  const coordinator = await TaskCoordinator.create({ ...params, plan });
  return { base, workspaceRoot, stateFile, supervisor, plan, params, coordinator };
}

function expandedPlan({ keepTwo = false } = {}) {
  if (keepTwo) return [
    fileTask("one", "build one"),
    fileTask("two", "build two", ["one"]),
    fileTask("preflight", "build preflight", ["two"]),
    fileTask("final", "build final", ["preflight"]),
  ];
  return [
    fileTask("one", "build one"),
    fileTask("preflight", "build preflight", ["one"]),
    fileTask("two", "build two", ["preflight"]),
    fileTask("final", "build final", ["two"]),
  ];
}

test("DP-03 revised four-step DAG resumes after multiple process restarts without replay", async t => {
  const f = await fixture(t);
  const first = await f.coordinator.tick();
  assert.equal(first.tasks[0].status, "VERIFIED");
  const evidence = structuredClone(first.tasks[0]);
  const revision = await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: expandedPlan(),
  });
  assert.equal(revision.planRevision, 1);
  assert.deepEqual(revision.tasks[0], evidence);
  assert.deepEqual(revision.tasks.map(task => task.status),
    ["VERIFIED", "TODO", "TODO", "TODO"]);

  // Reconstruct the coordinator between dependent tasks as if the process
  // exited. The Supervisor is durable and retains its exact idempotency keys.
  for (const id of ["preflight", "two", "final"]) {
    const restarted = await TaskCoordinator.load(f.params);
    const before = restarted.getState();
    assert.equal(before.tasks[0].status, "VERIFIED");
    const progressed = await restarted.tick();
    assert.equal(progressed.tasks.find(task => task.id === id).status, "VERIFIED");
  }
  const final = (await TaskCoordinator.load(f.params)).getState();
  assert.equal(final.planRevision, 1);
  assert.deepEqual(final.tasks.map(task => task.status),
    ["VERIFIED", "VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.deepEqual(f.supervisor.calls,
    ["build one", "build preflight", "build two", "build final"]);
  assert.deepEqual([...f.supervisor.executions.values()], [1, 1, 1, 1]);
  assert.deepEqual(final.tasks[0], evidence);
  assert.equal((await (await TaskCoordinator.load(f.params))
    .run({ timeoutMs: 1000, pollMs: 1 })).status, "VERIFIED");
  assert.equal(f.supervisor.calls.length, 4);
});

test("DP-03 crash after revised Worker submission recovers stable key without duplicate side effect", async t => {
  const f = await fixture(t);
  await f.coordinator.tick();
  await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: expandedPlan(),
  });
  const directory = path.dirname(f.stateFile);
  const displaced = directory + "-unavailable";
  let displacedOnce = false;
  f.supervisor.setSubmissionHook(async record => {
    if (record.instruction === "build preflight" && !displacedOnce) {
      displacedOnce = true;
      await fs.rename(directory, displaced);
    }
  });
  try {
    await assert.rejects(f.coordinator.tick(), { code: "ENOENT" });
  } finally {
    if (displacedOnce) await fs.rename(displaced, directory);
  }
  assert.equal(f.supervisor.executions.get("build preflight"), 1);
  const checkpoint = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(checkpoint.planRevision, 1);
  assert.equal(checkpoint.tasks[1].status, "RUNNING");
  assert.equal(checkpoint.tasks[1].supervisorTaskId, null);
  assert.equal(checkpoint.tasks[1].verificationReceipt, null);

  // A new Coordinator process may reissue create, but Supervisor deduplicates
  // this exact instruction and operation key instead of replaying side effects.
  const restored = await TaskCoordinator.load(f.params);
  const final = await restored.run({ timeoutMs: 3000, pollMs: 1 });
  assert.equal(final.status, "VERIFIED");
  assert.equal(f.supervisor.executions.get("build preflight"), 1);
  assert.equal(f.supervisor.attempts.get("build preflight"), 2);
  assert.deepEqual(f.supervisor.calls,
    ["build one", "build preflight", "build two", "build final"]);
  assert.ok(final.tasks.every(task => task.verificationReceipt));
});

test("DP-03 revision during active Worker preserves its identity and completes revised descendants", async t => {
  const f = await fixture(t, { running: new Set(["build two"]) });
  await f.coordinator.tick();
  const running = await f.coordinator.tick();
  assert.equal(running.tasks[0].status, "VERIFIED");
  assert.equal(running.tasks[1].status, "RUNNING");
  const runningTask = structuredClone(running.tasks[1]);
  const revised = await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: expandedPlan({ keepTwo: true }),
  });
  assert.deepEqual(revised.tasks[1], runningTask);
  const loaded = await TaskCoordinator.load(f.params);
  const unchanged = await loaded.tick();
  assert.equal(unchanged.tasks[1].status, "RUNNING");
  assert.equal(unchanged.tasks[1].supervisorTaskId, runningTask.supervisorTaskId);
  assert.equal(unchanged.tasks[2].status, "TODO");
  assert.deepEqual(f.supervisor.calls, ["build one", "build two"]);

  await f.supervisor.complete("build two");
  const resumed = await TaskCoordinator.load(f.params);
  const final = await resumed.run({ timeoutMs: 3000, pollMs: 1 });
  assert.equal(final.status, "VERIFIED");
  assert.deepEqual(final.tasks.map(task => task.status),
    ["VERIFIED", "VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.equal(final.tasks[1].supervisorTaskId, runningTask.supervisorTaskId);
  assert.deepEqual(f.supervisor.calls,
    ["build one", "build two", "build preflight", "build final"]);
});

test("DP-03 revised checkpoint after crash never skips independent artifact drift verification", async t => {
  const f = await fixture(t);
  await f.coordinator.tick();
  await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: expandedPlan(),
  });
  await fs.writeFile(path.join(f.workspaceRoot, "one.txt"), "tampered artifact");
  const restarted = await TaskCoordinator.load(f.params);
  const failed = await restarted.tick();
  assert.equal(failed.status, "BLOCKED");
  assert.equal(failed.lastError, "ARTIFACT_DRIFT");
  assert.deepEqual(f.supervisor.calls, ["build one"]);
  assert.ok(failed.tasks.every(task => task.status !== "VERIFIED" || task.id === "one"));
});
