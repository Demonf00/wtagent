
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FAILURE_KIND,
  classifyFailure,
  annotateCheckpointFailures,
} from "../src/autonomy/failure-classifier.js";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";

test("FR-01 categorizes five failure classes with stable diagnostic codes", () => {
  const samples = [
    ["PROVEN_NOT_SUBMITTED", FAILURE_KIND.RETRYABLE],
    ["WORKER_PRESTART_FAILURE", FAILURE_KIND.RETRYABLE],
    ["ARTIFACT_CHECK_FAILED", FAILURE_KIND.VERIFICATION_FAILURE],
    ["VERIFIER_COMPLETION_FAILED", FAILURE_KIND.VERIFICATION_FAILURE],
    ["GOAL_VERIFICATION_FAILED", FAILURE_KIND.VERIFICATION_FAILURE],
    ["SUPERVISOR_PAUSED", FAILURE_KIND.EXTERNAL_BLOCKER],
    ["AUTHENTICATION_REQUIRED", FAILURE_KIND.EXTERNAL_BLOCKER],
    ["SUPERVISOR_BLOCKED_UNCERTAIN", FAILURE_KIND.UNCERTAIN_SIDE_EFFECT],
    ["VERIFIER_COMPLETION_UNKNOWN", FAILURE_KIND.UNCERTAIN_SIDE_EFFECT],
    ["OUTBOUND_COMMIT_UNCERTAIN", FAILURE_KIND.UNCERTAIN_SIDE_EFFECT],
    ["SUPERVISOR_FAILED", FAILURE_KIND.PERMANENT_FAILURE],
    ["STATE_UNSAFE", FAILURE_KIND.PERMANENT_FAILURE],
    ["SUPERVISOR_IDENTITY_MISMATCH", FAILURE_KIND.PERMANENT_FAILURE],
  ];
  for (const [code, kind] of samples) {
    assert.deepEqual(classifyFailure(code), { kind, code });
    assert.deepEqual(classifyFailure({ code, message: "password=must-not-save" }),
      { kind, code });
  }
});

test("FR-01 unknown, unsafe and raw exception text never become retryable or stored diagnostics", () => {
  for (const value of [
    undefined,
    null,
    "I/O failure password=leak",
    { code: "SECRET=/workspace/private" },
    { code: "UNKNOWN_TRANSIENT_NETWORK_ERROR", message: "Bearer top-secret" },
    new Error("Bearer top-secret"),
    { code: "VERIFIER_INPUT_UNSAFE" },
    { code: "VERIFIER_UNSAFE" },
  ]) {
    const result = classifyFailure(value);
    assert.equal(result.kind, FAILURE_KIND.PERMANENT_FAILURE);
    assert.match(result.code, /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.doesNotMatch(JSON.stringify(result), /top-secret|Bearer|password|workspace|private/);
  }
  assert.deepEqual(classifyFailure({ code: "UNKNOWN_TRANSIENT_NETWORK_ERROR" }), {
    kind: FAILURE_KIND.PERMANENT_FAILURE,
    code: "UNKNOWN_TRANSIENT_NETWORK_ERROR",
  });
});

test("FR-01 checkpoint classification follows authoritative blocked fields, not forged metadata", () => {
  const state = {
    status: "BLOCKED",
    lastError: "OUTBOUND_COMMIT_UNCERTAIN",
    failure: { kind: "RETRYABLE", code: "PROVEN_NOT_SUBMITTED" },
    tasks: [
      { status: "BLOCKED", error: "ARTIFACT_CHECK_FAILED",
        failure: { kind: "RETRYABLE", code: "PROVEN_NOT_SUBMITTED" } },
      { status: "VERIFIED", error: null,
        failure: { kind: "RETRYABLE", code: "PROVEN_NOT_SUBMITTED" } },
    ],
    goalDelivery: {
      status: "BLOCKED", error: "AUTHENTICATION_REQUIRED",
      failure: { kind: "RETRYABLE", code: "PROVEN_NOT_SUBMITTED" },
    },
  };
  annotateCheckpointFailures(state);
  assert.deepEqual(state.failure, {
    kind: FAILURE_KIND.UNCERTAIN_SIDE_EFFECT,
    code: "OUTBOUND_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(state.tasks[0].failure, {
    kind: FAILURE_KIND.VERIFICATION_FAILURE,
    code: "ARTIFACT_CHECK_FAILED",
  });
  assert.equal(state.tasks[1].failure, null);
  assert.deepEqual(state.goalDelivery.failure, {
    kind: FAILURE_KIND.EXTERNAL_BLOCKER,
    code: "AUTHENTICATION_REQUIRED",
  });
  state.status = "VERIFIED";
  state.goalDelivery.status = "DELIVERED";
  state.tasks[0].status = "VERIFIED";
  annotateCheckpointFailures(state);
  assert.equal(state.failure, null);
  assert.equal(state.tasks[0].failure, null);
  assert.equal(state.goalDelivery.failure, null);
});

test("FR-01 legacy BLOCKED checkpoint loads without diagnosis fields and never starts another task", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-fr01-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  const stateFile = path.join(root, "state", "checkpoint.json");
  await fs.mkdir(workspaceRoot);
  const records = new Map();
  let launches = 0;
  const supervisor = {
    async create({ workspaceId, instruction, idempotencyKey }) {
      launches++;
      const taskId = `task_${randomUUID()}`;
      records.set(taskId, {
        taskId, workspaceId, workspaceRoot, instruction,
        idempotencyKey, status: "blocked_uncertain",
      });
      return { taskId };
    },
    get(taskId) {
      return records.get(taskId) ?? null;
    },
  };
  const plan = {
    goal: "Old blocked checkpoint compatibility",
    tasks: [
      {
        id: "first", instruction: "write first", dependsOn: [],
        acceptance: [{ kind: "file", path: "first.txt", minBytes: 1 }],
      },
      {
        id: "second", instruction: "write second", dependsOn: ["first"],
        acceptance: [{ kind: "file", path: "second.txt", minBytes: 1 }],
      },
    ],
  };
  const initial = await TaskCoordinator.create({
    stateFile, workspaceRoot, supervisor, workspaceId: "main", plan,
  });
  const blocked = await initial.run({ timeoutMs: 2000, pollMs: 1 });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(launches, 1);
  assert.deepEqual(blocked.failure, {
    kind: FAILURE_KIND.UNCERTAIN_SIDE_EFFECT,
    code: "SUPERVISOR_BLOCKED_UNCERTAIN",
  });

  const legacy = JSON.parse(await fs.readFile(stateFile, "utf8"));
  delete legacy.failure;
  for (const task of legacy.tasks) delete task.failure;
  if (legacy.goalDelivery) delete legacy.goalDelivery.failure;
  await fs.writeFile(stateFile, `${JSON.stringify(legacy, null, 2)}\n`);

  const restored = await TaskCoordinator.load({
    stateFile, workspaceRoot, workspaceId: "main", supervisor,
  });
  const loaded = restored.getState();
  assert.equal(loaded.status, "BLOCKED");
  assert.deepEqual(loaded.failure, {
    kind: FAILURE_KIND.UNCERTAIN_SIDE_EFFECT,
    code: "SUPERVISOR_BLOCKED_UNCERTAIN",
  });
  const resumed = await restored.run({ timeoutMs: 2000, pollMs: 1 });
  assert.equal(resumed.status, "BLOCKED");
  assert.equal(launches, 1, "legacy blocked state must not relaunch or advance");
  assert.equal(resumed.tasks[1].status, "TODO");
});
