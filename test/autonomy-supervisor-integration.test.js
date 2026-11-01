
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

test("P2 three-step coordinator persists and resumes with a real TaskSupervisor", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-autonomy-real-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "supervisor");
  const sessionsDir = path.join(root, "sessions");
  const stateFile = path.join(root, "autonomy", "plan.json");
  await fs.mkdir(workspaceRoot);
  let supervisor;
  t.after(async () => {
    try {
      await supervisor?.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const executions = [];
  const execute = async ({ session }) => {
    const instruction = session.state.task;
    const match = /^produce (one|two|three)$/.exec(instruction);
    assert.ok(match, `Unexpected Supervisor instruction: ${instruction}`);
    executions.push(match[1]);
    await fs.writeFile(path.join(workspaceRoot, `${match[1]}.txt`), `artifact-${match[1]}`);
    return { message: `completed ${match[1]}` };
  };

  const newSupervisor = async () => {
    const instance = new TaskSupervisor({
      dataDir, sessionsDir,
      workspaces: [{ id: "main", root: workspaceRoot }],
      execute,
      options: { recovery: { retryBaseMs: 5, retryMaxMs: 10, maxRetries: 1 } },
    });
    await instance.init();
    return instance;
  };
  supervisor = await newSupervisor();

  const plan = {
    goal: "Generate three verifiable files using real Supervisor tasks",
    tasks: [
      { id: "one", instruction: "produce one", dependsOn: [],
        acceptance: [{ kind: "file", path: "one.txt" }] },
      { id: "two", instruction: "produce two", dependsOn: ["one"],
        acceptance: [{ kind: "file", path: "two.txt" }] },
      { id: "three", instruction: "produce three", dependsOn: ["two"],
        acceptance: [{ kind: "file", path: "three.txt" }] },
    ],
  };

  const coordinator = await TaskCoordinator.create({
    stateFile, workspaceRoot, workspaceId: "main", supervisor, plan,
  });
  const completed = await coordinator.run({ timeoutMs: 10000, pollMs: 5 });
  assert.equal(completed.status, "VERIFIED", completed.lastError ?? "No failure detail");
  assert.deepEqual(executions, ["one", "two", "three"]);
  assert.equal(supervisor.list().length, 3);
  for (const task of completed.tasks) {
    const recorded = supervisor.get(task.supervisorTaskId);
    assert.equal(recorded.status, "completed");
    assert.equal(recorded.idempotencyKey, task.idempotencyKey);
    assert.equal(recorded.instruction, task.instruction);
    assert.equal(recorded.workspaceRoot, workspaceRoot);
    assert.equal(task.evidence.length, 1);
    assert.match(task.evidence[0].sha256, /^[a-f0-9]{64}$/);
  }

  await supervisor.close();
  supervisor = await newSupervisor();
  const resumed = await TaskCoordinator.load({
    stateFile, workspaceRoot, workspaceId: "main", supervisor,
  });
  const verifiedAgain = await resumed.run({ timeoutMs: 1000, pollMs: 5 });
  assert.equal(verifiedAgain.status, "VERIFIED");
  assert.deepEqual(executions, ["one", "two", "three"]);
  assert.equal(supervisor.list().length, 3);
});


test("DP-03 real Supervisor resumes a revised four-stage DAG across restarts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-dp03-real-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "supervisor");
  const sessionsDir = path.join(root, "sessions");
  const stateFile = path.join(root, "autonomy", "plan.json");
  await fs.mkdir(workspaceRoot);
  let supervisor;
  t.after(async () => {
    try { await supervisor?.close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  const executions = [];
  const execute = async ({ session }) => {
    const instruction = session.state.task;
    const match = /^produce (one|preflight|two|three)$/.exec(instruction);
    assert.ok(match, "Unexpected Supervisor task instruction: " + instruction);
    executions.push(match[1]);
    await fs.writeFile(path.join(workspaceRoot, match[1] + ".txt"),
      "artifact-" + match[1]);
    return { message: "completed " + match[1] };
  };
  const newSupervisor = async () => {
    const instance = new TaskSupervisor({
      dataDir, sessionsDir,
      workspaces: [{ id: "main", root: workspaceRoot }],
      execute,
      options: { recovery: { retryBaseMs: 5, retryMaxMs: 10, maxRetries: 1 } },
    });
    await instance.init();
    return instance;
  };
  const task = (id, dependency = []) => ({
    id, instruction: "produce " + id, dependsOn: dependency,
    acceptance: [{ kind: "file", path: id + ".txt" }],
  });
  const originalPlan = {
    goal: "Deliver four dependent artifacts in revision order",
    tasks: [task("one"), task("two", ["one"]), task("three", ["two"])],
  };
  const params = () => ({
    stateFile, workspaceRoot, workspaceId: "main", supervisor,
  });
  const untilVerified = async (coordinator, taskId) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const state = await coordinator.tick();
      if (state.status === "BLOCKED") {
        assert.fail("Unexpected Coordinator block: " + state.lastError);
      }
      if (state.tasks.find(item => item.id === taskId)?.status === "VERIFIED") {
        return state;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("Timed out waiting for independently verified " + taskId);
  };

  supervisor = await newSupervisor();
  const firstCoordinator = await TaskCoordinator.create({
    ...params(), plan: originalPlan,
  });
  const first = await untilVerified(firstCoordinator, "one");
  const originalProof = structuredClone(first.tasks[0]);
  assert.deepEqual(executions, ["one"]);

  const replacement = [
    task("one"), task("preflight", ["one"]),
    task("two", ["preflight"]), task("three", ["two"]),
  ];
  const revised = await firstCoordinator.revisePlan({
    expectedRevision: 0, tasks: replacement,
  });
  assert.equal(revised.planRevision, 1);
  assert.deepEqual(revised.tasks[0], originalProof);
  assert.deepEqual(revised.tasks.map(item => item.status),
    ["VERIFIED", "TODO", "TODO", "TODO"]);

  for (const [index, expected] of ["preflight", "two", "three"].entries()) {
    await supervisor.close();
    supervisor = await newSupervisor();
    const recovered = await TaskCoordinator.load(params());
    const before = recovered.getState();
    assert.equal(before.planRevision, 1);
    assert.deepEqual(before.tasks[0], originalProof);
    const done = await untilVerified(recovered, expected);
    assert.equal(done.tasks.find(item => item.id === expected).status, "VERIFIED");
    assert.deepEqual(executions,
      ["one", "preflight", "two", "three"].slice(0, index + 2));
    assert.equal(supervisor.list().length, index + 2);
    for (const item of done.tasks.filter(item => item.status === "VERIFIED")) {
      const persisted = supervisor.get(item.supervisorTaskId);
      assert.equal(persisted.status, "completed");
      assert.equal(persisted.idempotencyKey, item.idempotencyKey);
      assert.equal(persisted.instruction, item.instruction);
      assert.ok(item.verificationReceipt);
    }
  }

  await supervisor.close();
  supervisor = await newSupervisor();
  const finalCoordinator = await TaskCoordinator.load(params());
  const completed = await finalCoordinator.run({ timeoutMs: 3000, pollMs: 5 });
  assert.equal(completed.status, "VERIFIED", completed.lastError);
  assert.equal(completed.planRevision, 1);
  assert.deepEqual(completed.tasks[0], originalProof);
  assert.deepEqual(executions, ["one", "preflight", "two", "three"]);
  assert.equal(supervisor.list().length, 4);
});
