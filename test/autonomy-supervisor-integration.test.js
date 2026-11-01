
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
