
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  emptyRepairBudget,
  validateRepairBudget,
  reserveRepairAttempt,
  failRepairAttempt,
  repairStopReason,
  REPAIR_LIMITS,
} from "../src/autonomy/repair-budget.js";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

function reserveAndFail(budget, triggerCode, resultCode) {
  const reserved = reserveRepairAttempt(budget, triggerCode);
  return failRepairAttempt(reserved.budget, {
    sequence: reserved.attempt.sequence,
    errorCode: resultCode,
  });
}

test("FR-02 repair attempts have fixed budgets and consecutive identical failures stop", () => {
  assert.deepEqual(REPAIR_LIMITS, { maxAttempts: 3, maxIdenticalFailures: 2 });
  const first = reserveAndFail(emptyRepairBudget(), "ARTIFACT_CHECK_FAILED",
    "ARTIFACT_CHECK_FAILED");
  assert.equal(first.stopCode, null);
  const second = reserveAndFail(first.budget, "ARTIFACT_CHECK_FAILED",
    "ARTIFACT_CHECK_FAILED");
  assert.equal(second.stopCode, "REPAIR_SAME_ERROR_LOOP");
  assert.equal(second.budget.attempts.length, 2);
  assert.throws(() => reserveRepairAttempt(second.budget, "ARTIFACT_CHECK_FAILED"),
    { code: "REPAIR_SAME_ERROR_LOOP" });
});

test("FR-02 differing failures exhaust a durable total budget", () => {
  let budget = emptyRepairBudget();
  const outcomes = ["ARTIFACT_MISSING", "GOAL_VERIFICATION_FAILED",
    "VERIFIER_COMPLETION_FAILED"];
  for (let index = 0; index < outcomes.length; index++) {
    const result = reserveAndFail(budget, "ARTIFACT_CHECK_FAILED", outcomes[index]);
    budget = result.budget;
    assert.equal(result.stopCode,
      index === outcomes.length - 1 ? "REPAIR_ATTEMPTS_EXHAUSTED" : null);
  }
  assert.throws(() => reserveRepairAttempt(budget, "ARTIFACT_CHECK_FAILED"),
    { code: "REPAIR_ATTEMPTS_EXHAUSTED" });
});

test("FR-02 pending attempts never replay, and nonrepairable codes never gain authority", () => {
  const reservation = reserveRepairAttempt(emptyRepairBudget(),
    "ARTIFACT_CHECK_FAILED");
  assert.equal(reservation.attempt.status, "RESERVED");
  assert.equal(repairStopReason(reservation.budget), "REPAIR_ATTEMPT_OUTCOME_UNKNOWN");
  assert.throws(() => reserveRepairAttempt(reservation.budget, "ARTIFACT_CHECK_FAILED"),
    { code: "REPAIR_ATTEMPT_OUTCOME_UNKNOWN" });
  assert.throws(() => failRepairAttempt(reservation.budget, {
    sequence: 9, errorCode: "ARTIFACT_MISSING",
  }), { code: "REPAIR_ATTEMPT_NOT_RESERVED" });
  for (const code of ["SUPERVISOR_BLOCKED_UNCERTAIN", "SUPERVISOR_PAUSED",
    "SUPERVISOR_FAILED", "STATE_UNSAFE", "ARTIFACT_UNSAFE", "RETRY_MAYBE", "VERIFIER_UNSAFE"]) {
    assert.throws(() => reserveRepairAttempt(emptyRepairBudget(), code),
      { code: "REPAIR_FAILURE_NOT_REPAIRABLE" });
  }
  const unknown = failRepairAttempt(reservation.budget, {
    sequence: 1, errorCode: "OUTBOUND_COMMIT_UNCERTAIN",
  });
  assert.equal(unknown.stopCode, "REPAIR_FAILURE_NOT_REPAIRABLE");
});

test("FR-02 rejects altered attempt counts, status and unsafe diagnostic records", () => {
  const cases = [
    { ...emptyRepairBudget(), maxAttempts: 999 },
    { ...emptyRepairBudget(), attempts: Array.from({ length: 4 },
      (_, i) => ({ sequence: i + 1, triggerCode: "ARTIFACT_MISSING",
        resultCode: "ARTIFACT_MISSING", status: "FAILED" })) },
    { ...emptyRepairBudget(), attempts: [
      { sequence: 2, triggerCode: "ARTIFACT_MISSING",
        resultCode: null, status: "RESERVED" }] },
    { ...emptyRepairBudget(), attempts: [
      { sequence: 1, triggerCode: "ARTIFACT_MISSING",
        resultCode: null, status: "FAILED" }] },
    { ...emptyRepairBudget(), attempts: [
      { sequence: 1, triggerCode: "ARTIFACT_MISSING",
        resultCode: "token=secret", status: "FAILED" }] },
  ];
  for (const value of cases) {
    assert.throws(() => validateRepairBudget(value), { code: "REPAIR_BUDGET_UNSAFE" });
  }
});

async function fixture(t, supervisorStatus = "completed") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-fr02-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const stateFile = path.join(root, "state", "plan.json");
  await fs.mkdir(workspaceRoot);
  const records = new Map();
  const calls = [];
  const supervisor = {
    calls,
    async create({ workspaceId, instruction, idempotencyKey }) {
      calls.push(instruction);
      const taskId = `task_${randomUUID()}`;
      records.set(taskId, {
        taskId, workspaceId, workspaceRoot, instruction, idempotencyKey,
        status: supervisorStatus,
      });
      return { taskId };
    },
    get(taskId) { return records.get(taskId) ?? null; },
    async resume() { throw Error("Repair must never resume Supervisor work"); },
  };
  const plan = {
    goal: "Verify repair-budget safety",
    tasks: [
      { id: "first", instruction: "produce missing artifact", dependsOn: [],
        acceptance: [{ kind: "file", path: "first.txt", minBytes: 1 }] },
      { id: "second", instruction: "must remain untouched", dependsOn: ["first"],
        acceptance: [{ kind: "file", path: "second.txt", minBytes: 1 }] },
    ],
  };
  const params = { stateFile, workspaceRoot, workspaceId: "main", supervisor };
  const coordinator = await TaskCoordinator.create({ ...params, plan });
  const state = await coordinator.run({ timeoutMs: 2500, pollMs: 1 });
  assert.equal(state.status, "BLOCKED");
  return { coordinator, params, state, stateFile, supervisor };
}

test("FR-02 reservations persist before work and reloading cannot reset uncertain budget", async (t) => {
  const f = await fixture(t);
  assert.equal(f.state.failure.kind, "VERIFICATION_FAILURE");
  const reserved = await f.coordinator.reserveRepair({ errorCode: f.state.lastError });
  assert.equal(reserved.attempt.sequence, 1);
  assert.equal(reserved.attempt.status, "RESERVED");
  const persisted = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(persisted.repairBudget.attempts[0].status, "RESERVED");

  const restored = await TaskCoordinator.load(f.params);
  assert.equal(restored.getState().repairBudget.attempts.length, 1);
  await assert.rejects(restored.reserveRepair({ errorCode: f.state.lastError }),
    { code: "REPAIR_ATTEMPT_OUTCOME_UNKNOWN" });
  assert.equal(f.supervisor.calls.length, 1);
  assert.equal((await restored.tick()).status, "BLOCKED");
  assert.equal(f.supervisor.calls.length, 1);
});

test("FR-02 repeated errors across restart stop without submitting a second task", async (t) => {
  const f = await fixture(t);
  const initialError = f.state.lastError;
  const a = await f.coordinator.reserveRepair({ errorCode: initialError });
  const firstFailure = await f.coordinator.recordRepairFailure({
    sequence: a.attempt.sequence, errorCode: initialError,
  });
  assert.equal(firstFailure.stopCode, null);
  const restored = await TaskCoordinator.load(f.params);
  const b = await restored.reserveRepair({ errorCode: initialError });
  assert.equal(b.attempt.sequence, 2);
  const secondFailure = await restored.recordRepairFailure({
    sequence: b.attempt.sequence, errorCode: initialError,
  });
  assert.equal(secondFailure.stopCode, "REPAIR_SAME_ERROR_LOOP");
  await assert.rejects(restored.reserveRepair({ errorCode: initialError }),
    { code: "REPAIR_SAME_ERROR_LOOP" });
  assert.equal(f.supervisor.calls.length, 1, "retry budget must not launch Worker");
  assert.equal(restored.getState().status, "BLOCKED");
  assert.equal(restored.getState().tasks[1].status, "TODO");
});

test("FR-02 concurrent reservations serialize and cannot escalate or multiply attempts", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.allSettled([
    f.coordinator.reserveRepair({ errorCode: f.state.lastError }),
    f.coordinator.reserveRepair({ errorCode: f.state.lastError }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "REPAIR_ATTEMPT_OUTCOME_UNKNOWN");
  assert.equal(f.coordinator.getState().repairBudget.attempts.length, 1);
  assert.equal(f.supervisor.calls.length, 1);
  assert.equal(f.coordinator.getState().status, "BLOCKED");
  await assert.rejects(f.coordinator.recordRepairFailure({
    sequence: 1, errorCode: "secret/token=abc",
  }), { code: "REPAIR_INVALID_DIAGNOSTIC" });
  assert.equal(f.coordinator.getState().repairBudget.attempts[0].status, "RESERVED");
});

test("FR-02 external blockers cannot acquire repair budget or bypass approval", async (t) => {
  const f = await fixture(t, "paused");
  assert.equal(f.state.failure.kind, "EXTERNAL_BLOCKER");
  await assert.rejects(f.coordinator.reserveRepair({ errorCode: f.state.lastError }),
    { code: "REPAIR_FAILURE_NOT_REPAIRABLE" });
  assert.equal(f.coordinator.getState().repairBudget.attempts.length, 0);
  assert.equal(f.supervisor.calls.length, 1);
  assert.equal(f.coordinator.getState().status, "BLOCKED");
});
