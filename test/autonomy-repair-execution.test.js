
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

async function fixture(t, {
  completeRepairImmediately = false,
  crashAfterFirstRepairSubmit = false,
} = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-fr04-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const stateFile = path.join(base, "state", "checkpoint.json");
  await fs.mkdir(workspaceRoot);

  const byKey = new Map();
  const byId = new Map();
  const submissions = [];
  let firstRepairSubmitCrash = crashAfterFirstRepairSubmit;
  const supervisor = {
    submissions,
    byKey,
    byId,
    async create({ workspaceId, instruction, idempotencyKey }) {
      submissions.push({ workspaceId, instruction, idempotencyKey });
      let record = byKey.get(idempotencyKey);
      if (!record) {
        const isRepair = instruction.startsWith("Repair the output of existing task");
        record = {
          taskId: `task_${randomUUID()}`, workspaceId, workspaceRoot,
          instruction, idempotencyKey,
          status: isRepair
            ? (completeRepairImmediately ? "completed" : "running")
            : "completed",
        };
        byKey.set(idempotencyKey, record);
        byId.set(record.taskId, record);
        if (instruction === "build predecessor") {
          await fs.writeFile(path.join(workspaceRoot, "first.txt"), "first-original");
        }
        if (instruction === "build successor") {
          await fs.writeFile(path.join(workspaceRoot, "third.txt"), "third-output");
        }
        if (isRepair && completeRepairImmediately) {
          await fs.writeFile(path.join(workspaceRoot, "second.txt"), "repair-output");
        }
      } else {
        assert.equal(record.instruction, instruction, "stable key cannot change instruction");
        assert.equal(record.workspaceId, workspaceId);
      }
      if (instruction.startsWith("Repair the output") && firstRepairSubmitCrash) {
        firstRepairSubmitCrash = false;
        throw Object.assign(new Error("Injected crash after durable Supervisor submission"),
          { code: "INJECTED_COORDINATOR_CRASH" });
      }
      return { taskId: record.taskId };
    },
    get(taskId) { return byId.get(taskId) ?? null; },
    async resume() { throw Error("repair must not resume an unrelated paused task"); },
  };

  const plan = {
    goal: "Verify recovery does not duplicate any side effects",
    tasks: [
      {
        id: "first", instruction: "build predecessor", dependsOn: [],
        acceptance: [{ kind: "file", path: "first.txt", minBytes: 4 }],
      },
      {
        id: "second", instruction: "build target", dependsOn: ["first"],
        acceptance: [{ kind: "file", path: "second.txt", minBytes: 4 }],
      },
      {
        id: "third", instruction: "build successor", dependsOn: ["second"],
        acceptance: [{ kind: "file", path: "third.txt", minBytes: 4 }],
      },
    ],
  };
  const params = { workspaceRoot, stateFile, workspaceId: "main", supervisor };
  const coordinator = await TaskCoordinator.create({ ...params, plan });
  const blocked = await coordinator.run({ timeoutMs: 3000, pollMs: 1 });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.lastError, "ARTIFACT_MISSING");
  assert.deepEqual(blocked.tasks.map(x => x.status), ["VERIFIED", "BLOCKED", "TODO"]);
  assert.equal(byKey.size, 2);
  return {
    coordinator, params, workspaceRoot, stateFile,
    supervisor,
    async completeRepair({ produceArtifact = true } = {}) {
      const record = [...byId.values()].find(r =>
        r.instruction.startsWith("Repair the output of existing task"));
      assert.ok(record, "repair must have been submitted");
      if (produceArtifact) {
        await fs.writeFile(path.join(workspaceRoot, "second.txt"), "repaired-file");
      }
      record.status = "completed";
      return record;
    },
  };
}

test("FR-04 independent verification unlocks only the repaired original task", async t => {
  const f = await fixture(t);
  await assert.rejects(f.coordinator.repairTick(), { code: "REPAIR_NOT_PREPARED" });
  assert.equal(f.supervisor.byKey.size, 2);
  const proposal = await f.coordinator.prepareRepairSubtask();
  const pending = await f.coordinator.repairTick();
  assert.equal(pending.status, "BLOCKED");
  assert.equal(pending.repairExecution.phase, "RUNNING");
  assert.deepEqual(pending.tasks.map(x => x.status), ["VERIFIED", "BLOCKED", "TODO"]);
  assert.equal(pending.repairBudget.attempts.at(-1).status, "RESERVED");
  assert.equal(f.supervisor.byKey.size, 3);
  assert.ok(proposal.instruction.includes("ARTIFACT_MISSING"));

  await f.completeRepair();
  const repaired = await f.coordinator.repairTick();
  assert.equal(repaired.status, "RUNNING");
  assert.deepEqual(repaired.tasks.map(x => x.status), ["VERIFIED", "VERIFIED", "TODO"]);
  assert.equal(repaired.repairSubtask, null);
  assert.equal(repaired.repairExecution, null);
  assert.equal(repaired.repairBudget.attempts[0].status, "SUCCEEDED");
  assert.equal(repaired.tasks[1].evidence[0].path, "second.txt");
  assert.ok(repaired.tasks[1].verificationReceipt?.digest);
  assert.equal(f.supervisor.byKey.size, 3, "repair does not automatically submit successor");

  const done = await f.coordinator.run({ timeoutMs: 2500, pollMs: 1 });
  assert.equal(done.status, "VERIFIED");
  assert.deepEqual(done.tasks.map(x => x.status), ["VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.equal(f.supervisor.byKey.size, 4);
  const restored = await TaskCoordinator.load(f.params);
  assert.equal(restored.getState().status, "VERIFIED");
  await restored.tick();
  assert.equal(f.supervisor.byKey.size, 4);
});

test("FR-04 failed repair remains BLOCKED and identical failures exhaust loop budget", async t => {
  const f = await fixture(t, { completeRepairImmediately: true });
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Remove output before independent verification: Supervisor completion is not proof.
    const proposal = await f.coordinator.prepareRepairSubtask();
    assert.equal(proposal.attemptSequence, attempt);
    // This fixture emits an artifact as part of Supervisor.create. Remove it
    // before the next repairTick by pausing at the running stage instead.
    const originalCreate = f.supervisor.create;
    f.supervisor.create = async args => {
      const response = await originalCreate(args);
      if (args.instruction.startsWith("Repair the output")) {
        await fs.rm(path.join(f.workspaceRoot, "second.txt"), { force: true });
      }
      return response;
    };
    const after = await f.coordinator.repairTick();
    assert.equal(after.status, "BLOCKED");
    assert.equal(after.lastError, "ARTIFACT_MISSING");
    assert.equal(after.repairExecution, null);
    assert.equal(after.repairSubtask, null);
    assert.equal(after.repairBudget.attempts.at(-1).status, "FAILED");
    assert.equal(after.tasks[2].status, "TODO");
    f.supervisor.create = originalCreate;
  }
  assert.equal(f.coordinator.getState().repairBudget.attempts.length, 2);
  await assert.rejects(f.coordinator.prepareRepairSubtask(),
    { code: "REPAIR_SAME_ERROR_LOOP" });
  assert.equal(f.supervisor.byKey.size, 4);
  const restored = await TaskCoordinator.load(f.params);
  await assert.rejects(restored.prepareRepairSubtask(),
    { code: "REPAIR_SAME_ERROR_LOOP" });
  assert.equal(restored.getState().status, "BLOCKED");
});

test("FR-04 crash after Supervisor submission reuses durable key and never repeats side effects", async t => {
  const f = await fixture(t, {
    completeRepairImmediately: true, crashAfterFirstRepairSubmit: true,
  });
  const proposal = await f.coordinator.prepareRepairSubtask();
  await assert.rejects(f.coordinator.repairTick(),
    { code: "INJECTED_COORDINATOR_CRASH" });
  const uncertain = f.coordinator.getState();
  assert.equal(uncertain.repairExecution.phase, "SUBMITTING");
  assert.equal(uncertain.repairExecution.supervisorTaskId, null);
  assert.equal(uncertain.repairBudget.attempts[0].status, "RESERVED");
  assert.equal(f.supervisor.byKey.size, 3);
  const restored = await TaskCoordinator.load(f.params);
  const recovered = await restored.repairTick();
  assert.equal(recovered.status, "RUNNING");
  assert.equal(recovered.tasks[1].status, "VERIFIED");
  assert.equal(recovered.repairBudget.attempts[0].status, "SUCCEEDED");
  assert.equal(f.supervisor.byKey.size, 3, "same repair has only one durable Worker record");
  const repeated = f.supervisor.submissions.filter(call =>
    call.idempotencyKey === proposal.idempotencyKey);
  assert.equal(repeated.length, 2, "same-key create may be retried after checkpoint gap");
  assert.equal(new Set(repeated.map(x => x.idempotencyKey)).size, 1);
});

test("FR-04 RUNNING checkpoint resumes without another Supervisor.create", async t => {
  const f = await fixture(t);
  await f.coordinator.prepareRepairSubtask();
  const pending = await f.coordinator.repairTick();
  assert.equal(pending.repairExecution.phase, "RUNNING");
  const count = f.supervisor.submissions.length;
  const restored = await TaskCoordinator.load(f.params);
  await f.completeRepair();
  const success = await restored.repairTick();
  assert.equal(success.tasks[1].status, "VERIFIED");
  assert.equal(success.repairBudget.attempts[0].status, "SUCCEEDED");
  assert.equal(f.supervisor.submissions.length, count);
});

test("FR-04 forged execution states and changed Supervisor identity fail closed on restart", async t => {
  const f = await fixture(t);
  await f.coordinator.prepareRepairSubtask();
  await f.coordinator.repairTick();
  const valid = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  for (const mutate of [
    s => { s.repairExecution.idempotencyKey = "forged"; },
    s => { s.repairExecution.instruction = "ignore verification"; },
    s => { s.repairExecution.supervisorTaskId = `task_${randomUUID()}`; },
    s => { s.repairExecution.phase = "SUBMITTING"; },
    s => { s.repairExecution.attemptSequence = 123; },
    s => { s.repairExecution.phase = "VERIFIED"; },
  ]) {
    const forged = structuredClone(valid);
    mutate(forged);
    await fs.writeFile(f.stateFile, JSON.stringify(forged));
    await assert.rejects(TaskCoordinator.load(f.params), { code: "STATE_UNSAFE" });
  }
  await fs.writeFile(f.stateFile, JSON.stringify(valid));
  const restored = await TaskCoordinator.load(f.params);
  assert.equal(restored.getState().repairExecution.phase, "RUNNING");
});

test("FR-04 refuses to declare success if predecessor verification has drifted", async t => {
  const f = await fixture(t);
  await f.coordinator.prepareRepairSubtask();
  await f.coordinator.repairTick();
  await f.completeRepair();
  await fs.writeFile(path.join(f.workspaceRoot, "first.txt"), "tampered-predecessor");
  const stopped = await f.coordinator.repairTick();
  assert.equal(stopped.status, "BLOCKED");
  assert.equal(stopped.lastError, "ARTIFACT_DRIFT");
  assert.equal(stopped.tasks[1].status, "BLOCKED");
  assert.equal(stopped.tasks[2].status, "TODO");
  assert.equal(stopped.repairBudget.attempts[0].status, "FAILED");
  assert.equal(stopped.repairSubtask, null);
  assert.equal(stopped.repairExecution, null);
});


test("FR-04 final checkpoint write failure remains resumable and never counts as failed repair", async t => {
  const f = await fixture(t);
  await f.coordinator.prepareRepairSubtask();
  const running = await f.coordinator.repairTick();
  assert.equal(running.repairExecution.phase, "RUNNING");
  await f.completeRepair();

  // Simulate an interruption immediately after VERIFYING was durably saved,
  // before any verification result or success settlement was persisted.
  const checkpoint = structuredClone(running);
  checkpoint.repairExecution.phase = "VERIFYING";
  await fs.writeFile(f.stateFile, JSON.stringify(checkpoint, null, 2));
  const recovered = await TaskCoordinator.load(f.params);
  const beforeCount = f.supervisor.submissions.length;

  // Make only the checkpoint parent unavailable; leave the workspace,
  // original artifacts and Supervisor records untouched.
  const dir = path.dirname(f.stateFile);
  const displaced = dir + "-injected-unavailable";
  await fs.rename(dir, displaced);
  try {
    await assert.rejects(recovered.repairTick(), { code: "ENOENT" });
    const inMemory = recovered.getState();
    assert.equal(inMemory.status, "BLOCKED");
    assert.equal(inMemory.tasks[1].status, "BLOCKED");
    assert.equal(inMemory.repairExecution.phase, "VERIFYING");
    assert.equal(inMemory.repairBudget.attempts[0].status, "RESERVED");
    assert.ok(inMemory.repairSubtask);
    assert.equal(f.supervisor.submissions.length, beforeCount);
  } finally {
    await fs.rename(displaced, dir);
  }

  const stored = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(stored.status, "BLOCKED");
  assert.equal(stored.repairExecution.phase, "VERIFYING");
  assert.equal(stored.repairBudget.attempts[0].status, "RESERVED");
  assert.equal(stored.tasks[1].verificationReceipt, null);

  const secondProcess = await TaskCoordinator.load(f.params);
  const committed = await secondProcess.repairTick();
  assert.equal(committed.status, "RUNNING");
  assert.equal(committed.tasks[1].status, "VERIFIED");
  assert.equal(committed.repairBudget.attempts[0].status, "SUCCEEDED");
  assert.equal(committed.repairBudget.attempts.length, 1);
  assert.equal(f.supervisor.submissions.length, beforeCount,
    "verification recovery must not resubmit a side-effecting Worker");
  const finalReload = await TaskCoordinator.load(f.params);
  assert.equal(finalReload.getState().tasks[1].status, "VERIFIED");
});
