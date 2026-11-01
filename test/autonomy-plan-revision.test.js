
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

async function fixture(t, { secondStatus = "completed" } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-dp01-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const stateFile = path.join(base, "state", "plan.json");
  await fs.mkdir(workspaceRoot);
  const keys = new Map();
  const records = new Map();
  const calls = [];
  const outputs = {
    "build one": ["one.txt", "original-one"],
    "build two": ["two.txt", "original-two"],
    "build split": ["split.txt", "split-artifact"],
    "build three": ["three.txt", "original-three"],
    "build fourth": ["fourth.txt", "fourth-artifact"],
  };
  const supervisor = {
    calls,
    async create({ workspaceId, instruction, idempotencyKey }) {
      if (keys.has(idempotencyKey)) {
        const old = keys.get(idempotencyKey);
        assert.equal(old.instruction, instruction);
        return { taskId: old.taskId };
      }
      const taskId = `task_${randomUUID()}`;
      const status = instruction === "build two" ? secondStatus : "completed";
      const record = {
        taskId, status, workspaceId, workspaceRoot, instruction, idempotencyKey,
      };
      keys.set(idempotencyKey, record);
      records.set(taskId, record);
      calls.push(instruction);
      const result = outputs[instruction];
      if (result && status === "completed") {
        await fs.writeFile(path.join(workspaceRoot, result[0]), result[1]);
      }
      return { taskId };
    },
    get(id) { return records.get(id) ?? null; },
  };
  const plan = {
    goal: "Test revisioned task DAG and original evidence",
    tasks: [
      { id: "one", instruction: "build one", dependsOn: [],
        acceptance: [{ kind: "file", path: "one.txt", minBytes: 1 }] },
      { id: "two", instruction: "build two", dependsOn: ["one"],
        acceptance: [{ kind: "file", path: "two.txt", minBytes: 1 }] },
      { id: "three", instruction: "build three", dependsOn: ["two"],
        acceptance: [{ kind: "file", path: "three.txt", minBytes: 1 }] },
    ],
  };
  const params = { stateFile, workspaceRoot, workspaceId: "main", supervisor };
  const coordinator = await TaskCoordinator.create({ ...params, plan });
  assert.equal(coordinator.getState().planRevision, 0);
  await coordinator.tick();
  const checkpoint = coordinator.getState();
  assert.equal(checkpoint.tasks[0].status, "VERIFIED");
  assert.equal(checkpoint.tasks[1].status, "TODO");
  return { coordinator, params, supervisor, plan, stateFile, workspaceRoot, base };
}

function splitPlan(original) {
  return [
    structuredClone(original.tasks[0]),
    { id: "split", instruction: "build split", dependsOn: ["one"],
      acceptance: [{ kind: "file", path: "split.txt", minBytes: 1 }] },
    { ...structuredClone(original.tasks[2]), dependsOn: ["split"] },
  ];
}

test("DP-01 revisions split unfinished DAG and preserve predecessor receipt through restart", async t => {
  const f = await fixture(t);
  const predecessor = structuredClone(f.coordinator.getState().tasks[0]);
  const revised = await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: splitPlan(f.plan),
  });
  assert.equal(revised.planRevision, 1);
  assert.deepEqual(revised.tasks.map(x => x.id), ["one", "split", "three"]);
  assert.deepEqual(revised.tasks[0], predecessor);
  assert.equal(revised.tasks[1].status, "TODO");
  assert.deepEqual(revised.tasks[2].dependsOn, ["split"]);
  const restored = await TaskCoordinator.load(f.params);
  assert.equal(restored.getState().planRevision, 1);
  assert.deepEqual(restored.getState().tasks[0], predecessor);
  const final = await restored.run({ timeoutMs: 2000, pollMs: 1 });
  assert.equal(final.status, "VERIFIED");
  assert.deepEqual(f.supervisor.calls, ["build one", "build split", "build three"]);
  assert.deepEqual(final.tasks.map(t => t.status),
    ["VERIFIED", "VERIFIED", "VERIFIED"]);
});

test("DP-01 rejects mutation, removal, or reordering of started and verified task definitions", async t => {
  const f = await fixture(t);
  const snapshot = f.coordinator.getState();
  const variations = [
    tasks => { tasks[0].instruction = "replace verified task"; },
    tasks => { tasks[0].dependsOn = ["two"]; },
    tasks => { tasks[0].acceptance[0].path = "forged.txt"; },
    tasks => { tasks.shift(); },
  ];
  for (const modify of variations) {
    const tasks = structuredClone(f.plan.tasks);
    modify(tasks);
    await assert.rejects(f.coordinator.revisePlan({
      expectedRevision: 0, tasks,
    }));
    assert.deepEqual(f.coordinator.getState(), snapshot);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(f.stateFile, "utf8")).tasks[0],
    snapshot.tasks[0]);
});

test("DP-01 rejects cycles, unknown dependencies and oversized replacement plans", async t => {
  const f = await fixture(t);
  const candidates = [
    [{ ...f.plan.tasks[0] }, { ...f.plan.tasks[1], dependsOn: ["three"] },
      { ...f.plan.tasks[2], dependsOn: ["two"] }],
    [{ ...f.plan.tasks[0] }, { ...f.plan.tasks[1], dependsOn: ["missing"] },
      { ...f.plan.tasks[2] }],
    Array.from({ length: 33 }, (_, i) => ({
      id: `new${i}`, instruction: "test bounded plan", dependsOn: [],
      acceptance: [{ kind: "file", path: `artifact${i}.txt`, minBytes: 1 }],
    })),
  ];
  for (const tasks of candidates) {
    await assert.rejects(f.coordinator.revisePlan({
      expectedRevision: 0, tasks,
    }));
  }
  assert.equal(f.coordinator.getState().planRevision, 0);
  assert.equal(f.supervisor.calls.length, 1);
});

test("DP-01 serializes simultaneous revisions and rejects stale in-memory revisions", async t => {
  const f = await fixture(t);
  const tasks = splitPlan(f.plan);
  const [a, b] = await Promise.allSettled([
    f.coordinator.revisePlan({ expectedRevision: 0, tasks }),
    f.coordinator.revisePlan({ expectedRevision: 0, tasks }),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.code, "PLAN_REVISION_CONFLICT");
  assert.equal(f.coordinator.getState().planRevision, 1);
  await assert.rejects(f.coordinator.revisePlan({
    expectedRevision: 0, tasks,
  }), { code: "PLAN_REVISION_CONFLICT" });
});

test("DP-01 rejects revision from stale independent Coordinator instance", async t => {
  const f = await fixture(t);
  const stale = await TaskCoordinator.load(f.params);
  const tasks = splitPlan(f.plan);
  await f.coordinator.revisePlan({ expectedRevision: 0, tasks });
  await assert.rejects(stale.revisePlan({
    expectedRevision: 0, tasks,
  }), { code: "PLAN_REVISION_CONFLICT" });
  const persisted = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(persisted.planRevision, 1);
  assert.equal(persisted.tasks[1].id, "split");
});

test("DP-01 rejects stale replica when another instance advances Supervisor work", async t => {
  const f = await fixture(t, { secondStatus: "running" });
  const stale = await TaskCoordinator.load(f.params);
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().tasks[1].status, "RUNNING");
  const original = structuredClone(f.plan.tasks);
  original[2].instruction = "revised unstarted task";
  await assert.rejects(stale.revisePlan({
    expectedRevision: 0, tasks: original,
  }), { code: "PLAN_REVISION_CONFLICT" });
});

test("DP-01 revision lock rejects concurrent writers without touching checkpoint", async t => {
  const f = await fixture(t);
  const lockFile = f.stateFile + ".revision.lock";
  await fs.writeFile(lockFile, "held by another process");
  try {
    await assert.rejects(f.coordinator.revisePlan({
      expectedRevision: 0, tasks: splitPlan(f.plan),
    }), { code: "PLAN_REVISION_LOCKED" });
    assert.equal(f.coordinator.getState().planRevision, 0);
  } finally {
    await fs.rm(lockFile, { force: true });
  }
});

test("DP-01 refuses to change a task already submitted to Supervisor", async t => {
  const f = await fixture(t, { secondStatus: "running" });
  await f.coordinator.tick();
  assert.equal(f.coordinator.getState().tasks[1].status, "RUNNING");
  const tasks = structuredClone(f.plan.tasks);
  tasks[1].instruction = "replay dangerous side effect";
  await assert.rejects(f.coordinator.revisePlan({
    expectedRevision: 0, tasks,
  }), { code: "PLAN_REVISION_IMMUTABLE" });
  tasks[1].instruction = f.plan.tasks[1].instruction;
  tasks[2].instruction = "build fourth";
  const updated = await f.coordinator.revisePlan({
    expectedRevision: 0, tasks,
  });
  assert.equal(updated.tasks[1].status, "RUNNING");
  assert.equal(updated.tasks[1].supervisorTaskId,
    f.coordinator.getState().tasks[1].supervisorTaskId);
  assert.equal(updated.tasks[2].status, "TODO");
});

test("DP-01 legacy checkpoint without revision is treated as revision zero", async t => {
  const f = await fixture(t);
  const saved = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  delete saved.planRevision;
  await fs.writeFile(f.stateFile, JSON.stringify(saved));
  const legacy = await TaskCoordinator.load(f.params);
  assert.equal(legacy.getState().planRevision, 0);
  const revised = await legacy.revisePlan({
    expectedRevision: 0, tasks: splitPlan(f.plan),
  });
  assert.equal(revised.planRevision, 1);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).planRevision, 1);
});

test("DP-01 rejects malformed revision values on checkpoint reload", async t => {
  const f = await fixture(t);
  const saved = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  for (const invalidValue of [-1, "1", 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const altered = { ...saved, planRevision: invalidValue };
    await fs.writeFile(f.stateFile, JSON.stringify(altered));
    await assert.rejects(TaskCoordinator.load(f.params), { code: "STATE_UNSAFE" });
  }
});
