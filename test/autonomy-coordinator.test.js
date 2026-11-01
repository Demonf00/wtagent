
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { TaskCoordinator, validateTaskPlan } from "../src/autonomy/task-coordinator.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-autonomy-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspaceRoot, stateFile: path.join(root, "state", "plan.json") };
}

function plan() {
  return {
    goal: "Build three verified artifacts in order",
    tasks: [
      { id: "one", instruction: "build one", dependsOn: [],
        acceptance: [{ kind: "file", path: "one.txt", minBytes: 1 }] },
      { id: "two", instruction: "build two", dependsOn: ["one"],
        acceptance: [{ kind: "file", path: "two.txt", minBytes: 1 }] },
      { id: "three", instruction: "build three", dependsOn: ["two"],
        acceptance: [{ kind: "file", path: "three.txt", minBytes: 1 }] },
    ],
  };
}

function fakeSupervisor({ workspaceRoot, outputs = {}, status = "completed" }) {
  const tasks = new Map();
  const keys = new Map();
  const calls = [];
  return {
    calls, tasks,
    async create({ workspaceId, instruction, idempotencyKey }) {
      if (keys.has(idempotencyKey)) {
        const old = keys.get(idempotencyKey);
        assert.equal(old.instruction, instruction);
        assert.equal(old.workspaceId, workspaceId);
        return { taskId: old.taskId };
      }
      const taskId = `task_${randomUUID()}`;
      keys.set(idempotencyKey, { instruction, workspaceId, taskId });
      calls.push(instruction);
      if (Object.hasOwn(outputs, instruction)) {
        const output = outputs[instruction];
        if (output) {
          const [file, value] = output;
          await fs.writeFile(path.join(workspaceRoot, file), value);
        }
      }
      tasks.set(taskId, {
        taskId, status, workspaceId, workspaceRoot,
        instruction, idempotencyKey,
      });
      return { taskId };
    },
    get(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      return task;
    },
  };
}

test("P2 automatically executes three dependent steps and resumes without redoing verified work", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: {
      "build one": ["one.txt", "first"],
      "build two": ["two.txt", "second"],
      "build three": ["three.txt", "third"],
    },
  });
  const coordinator = await TaskCoordinator.create({ ...f, workspaceId: "main", supervisor, plan: plan() });
  const complete = await coordinator.run({ timeoutMs: 3000, pollMs: 1 });
  assert.equal(complete.status, "VERIFIED");
  assert.deepEqual(complete.tasks.map((task) => task.status), ["VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.deepEqual(supervisor.calls, ["build one", "build two", "build three"]);
  assert.deepEqual(complete.tasks.map((task) => task.evidence[0].sha256), [
    ...["first", "second", "third"].map((value) => createHash("sha256").update(value).digest("hex")),
  ]);
  const resumed = await TaskCoordinator.load({ ...f, workspaceId: "main", supervisor });
  assert.equal((await resumed.run({ timeoutMs: 100 })).status, "VERIFIED");
  assert.deepEqual(supervisor.calls, ["build one", "build two", "build three"]);
});

test("P2 rechecks artifact evidence even after the entire plan was VERIFIED", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: {
      "build one": ["one.txt", "first"],
      "build two": ["two.txt", "second"],
      "build three": ["three.txt", "third"],
    },
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  assert.equal((await coordinator.run({ timeoutMs: 3000, pollMs: 1 })).status, "VERIFIED");
  await fs.writeFile(path.join(f.workspaceRoot, "two.txt"), "modified-after-verification");
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  const result = await resumed.tick();
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "ARTIFACT_DRIFT");
  assert.deepEqual(supervisor.calls, ["build one", "build two", "build three"]);
});

test("P2 rejects a contradictory VERIFIED checkpoint instead of trusting its status", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const persisted = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  persisted.status = "VERIFIED";
  await fs.writeFile(f.stateFile, JSON.stringify(persisted));
  await assert.rejects(
    TaskCoordinator.load({ ...f, supervisor }),
    { code: "STATE_UNSAFE" },
  );
});

test("P2 never verifies a forged VERIFYING checkpoint while Supervisor work is unfinished", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot, status: "queued" });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const first = await coordinator.tick();
  assert.equal(first.tasks[0].status, "RUNNING");
  await fs.writeFile(path.join(f.workspaceRoot, "one.txt"), "old unrelated artifact");
  const persisted = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  persisted.tasks[0].status = "VERIFYING";
  await fs.writeFile(f.stateFile, JSON.stringify(persisted));
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  const result = await resumed.tick();
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "SUPERVISOR_NOT_COMPLETED");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 rejects mismatched Supervisor identity even when work reports completed", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    status: "queued",
    outputs: { "build one": ["one.txt", "stale"] },
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const first = await coordinator.tick();
  assert.equal(first.tasks[0].status, "RUNNING");
  const supervisorTaskId = first.tasks[0].supervisorTaskId;
  const record = supervisor.tasks.get(supervisorTaskId);
  record.idempotencyKey = "wrong-task-owner";
  record.status = "completed";
  const result = await coordinator.tick();
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "SUPERVISOR_IDENTITY_MISMATCH");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 uses durable idempotency after a crash between Supervisor.create and task-ID checkpoint", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: {
      "build one": ["one.txt", "first"],
      "build two": ["two.txt", "second"],
      "build three": ["three.txt", "third"],
    },
  });
  const realCreate = supervisor.create.bind(supervisor);
  let interrupted = false;
  supervisor.create = async (request) => {
    const task = await realCreate(request);
    if (!interrupted) {
      interrupted = true;
      throw new Error("Simulated crash after Supervisor committed the task");
    }
    return task;
  };
  const original = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  await assert.rejects(original.tick(), /Simulated crash/);
  const durable = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(durable.tasks[0].status, "RUNNING");
  assert.equal(durable.tasks[0].supervisorTaskId, null);
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await resumed.run({ timeoutMs: 3000, pollMs: 1 })).status, "VERIFIED");
  assert.deepEqual(supervisor.calls, ["build one", "build two", "build three"]);
});

test("P2 refuses to advance from a completed model turn without the required artifact", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const result = await coordinator.run({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.tasks[0].status, "BLOCKED");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 rejects an unchanged preexisting artifact as a completed task result", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspaceRoot, "one.txt"), "preexisting");
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot, status: "queued" });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const created = await coordinator.tick();
  assert.equal(created.tasks[0].status, "RUNNING");
  supervisor.tasks.get(created.tasks[0].supervisorTaskId).status = "completed";
  const result = await coordinator.tick();
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "ARTIFACT_UNCHANGED");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 accepts an existing artifact only when this task changes its content", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspaceRoot, "one.txt"), "preexisting");
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: {
      "build one": ["one.txt", "new-content"],
      "build two": ["two.txt", "new-two"],
      "build three": ["three.txt", "new-three"],
    },
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const result = await coordinator.run({ timeoutMs: 3000, pollMs: 1 });
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(supervisor.calls, ["build one", "build two", "build three"]);
});

test("P2 stops on uncertain Supervisor work without launching a successor", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot, status: "blocked_uncertain",
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const result = await coordinator.run({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "SUPERVISOR_BLOCKED_UNCERTAIN");
  assert.deepEqual(supervisor.calls, ["build one"]);
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await resumed.tick()).status, "BLOCKED");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 detects artifact drift on restart and prevents further execution", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: {
      "build one": ["one.txt", "first"],
      "build two": ["two.txt", "second"],
      "build three": ["three.txt", "third"],
    },
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  await coordinator.tick(); // one verified
  assert.equal(coordinator.getState().tasks[0].status, "VERIFIED");
  await fs.writeFile(path.join(f.workspaceRoot, "one.txt"), "tampered");
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  const result = await resumed.run({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "ARTIFACT_DRIFT");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 rejects incorrect expected SHA-256 without running dependents", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: { "build one": ["one.txt", "wrong-content"] },
  });
  const badPlan = plan();
  badPlan.tasks[0].acceptance[0].sha256 = createHash("sha256").update("expected").digest("hex");
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: badPlan });
  const result = await coordinator.run({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "ARTIFACT_MISMATCH");
  assert.deepEqual(supervisor.calls, ["build one"]);
});

test("P2 validates DAG cycles, missing prerequisites, duplicate tasks and unsafe paths", () => {
  const cyclic = plan();
  cyclic.tasks[0].dependsOn = ["three"];
  assert.throws(() => validateTaskPlan(cyclic), /cycle/);
  const missing = plan();
  missing.tasks[1].dependsOn = ["absent"];
  assert.throws(() => validateTaskPlan(missing), /Unknown prerequisite/);
  const duplicate = plan();
  duplicate.tasks[1].id = "one";
  assert.throws(() => validateTaskPlan(duplicate), /unique ID/);
  for (const file of ["../escape.txt", "/absolute.txt", "C:/absolute.txt", "folder\\file.txt", "a//b"]) {
    const unsafe = plan();
    unsafe.tasks[0].acceptance[0].path = file;
    assert.throws(() => validateTaskPlan(unsafe), /safe workspace-relative/);
  }
});

test("P2 rejects symlinked artifact paths", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "outside.txt"), "outside");
  const link = path.join(f.workspaceRoot, "one.txt");
  try {
    await fs.symlink(path.join(f.root, "outside.txt"), link, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
      t.skip("Symlink creation is not permitted by this Windows environment.");
      return;
    }
    throw error;
  }
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const result = await coordinator.run({ timeoutMs: 1000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "ARTIFACT_UNSAFE");
  assert.deepEqual(supervisor.calls, [], "Unsafe artifact path must be rejected before Worker submission");
});


test("FV-01 validates bounded command acceptance without executing it", () => {
  const current = plan();
  current.tasks[0].acceptance.push({
    kind: "command", program: "npm", argv: ["run", "check"],
  });
  const validated = validateTaskPlan(current);
  assert.deepEqual(validated.tasks[0].acceptance[1], {
    kind: "command", program: "npm", argv: ["run", "check"],
    cwd: ".", timeoutMs: 60_000,
  });

  current.tasks[0].acceptance[1] = {
    kind: "command", program: "node",
    argv: ["--test", "test/autonomy-coordinator.test.js"],
    cwd: ".", timeoutMs: 20_000,
  };
  assert.deepEqual(validateTaskPlan(current).tasks[0].acceptance[1], current.tasks[0].acceptance[1]);

  // Legacy plans keep their normalized file-check representation.
  assert.deepEqual(validateTaskPlan(plan()).tasks[0].acceptance, [
    { kind: "file", path: "one.txt", minBytes: 1 },
  ]);
});

test("FV-01 rejects executable, shell, unsafe path and unbounded command declarations", () => {
  const invalidChecks = [
    { kind: "command", program: "cmd", argv: ["/c", "echo", "bad"] },
    { kind: "command", program: "powershell", argv: ["-Command", "echo bad"] },
    { kind: "command", program: "npm", argv: ["install"] },
    { kind: "command", program: "npm", argv: ["run", "prepack"] },
    { kind: "command", program: "npm", argv: ["run", "check", "&&", "echo"] },
    { kind: "command", program: "npm", argv: ["run", "check"], cwd: "../outside" },
    { kind: "command", program: "npm", argv: ["run", "check"], env: { SECRET: "x" } },
    { kind: "command", program: "npm", argv: ["run", "check"], timeoutMs: Infinity },
    { kind: "command", program: "npm", argv: ["run", "check"], timeoutMs: 999 },
    { kind: "command", program: "npm", argv: ["run", "check"], timeoutMs: 120001 },
    { kind: "command", program: "node", argv: ["-e", "process.exit(0)"] },
    { kind: "command", program: "node", argv: ["--test", "../escape.test.js"] },
    { kind: "command", program: "node", argv: ["--test", "test/../escape.test.js"] },
    { kind: "command", program: "node", argv: ["--test", "C:/escape.test.js"] },
    { kind: "command", program: "node", argv: ["--test", "test/foo.test.js", "--eval"] },
    { kind: "command", program: "node", argv: ["--test", "test/a\\b.test.js"] },
    { kind: "command", program: "node", argv: ["--test", "test/" + "a".repeat(260) + ".test.js"] },
    { kind: "command", program: "npm", argv: "run check" },
    { kind: "command", program: "npm", argv: [] },
    { kind: "command", program: "npm", argv: [42] },
    { kind: "unknown", path: "one.txt" },
  ];
  for (const check of invalidChecks) {
    const proposed = plan();
    proposed.tasks[0].acceptance.push(check);
    assert.throws(() => validateTaskPlan(proposed),
      { code: "INVALID_PLAN" }, JSON.stringify(check));
  }
});

test("FV-02 accepts command plans but cannot verify before Supervisor completes", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot, status: "queued" });
  const proposed = plan();
  proposed.tasks[0].acceptance.push({
    kind: "command", program: "npm", argv: ["test"],
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const state = await coordinator.tick();
  assert.equal(state.status, "RUNNING");
  assert.equal(state.tasks[0].status, "RUNNING");
  assert.equal(state.tasks[0].baseline[1].kind, "command");
  assert.equal(state.tasks[0].evidence, null);
  assert.equal(state.tasks[0].verificationStarted, undefined);
  assert.deepEqual(supervisor.calls, ["build one"]);
  const resumed = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await resumed.tick()).tasks[0].status, "RUNNING");
  assert.deepEqual(supervisor.calls, ["build one"]);
});


test("FV-02 only real command completion allows VERIFIED and persists resumable evidence", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"),
    'const test = require("node:test"); test("real pass", () => {});');
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: { "build verified output": ["output.txt", "content"] },
  });
  const proposed = { goal: "Verify real command", tasks: [{
    id: "check", instruction: "build verified output", dependsOn: [],
    acceptance: [
      { kind: "file", path: "output.txt", minBytes: 1 },
      { kind: "command", program: "node",
        argv: ["--test", "test/accept.test.js"], cwd: ".", timeoutMs: 10000 },
    ],
  }] };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const result = await coordinator.run({ timeoutMs: 15000, pollMs: 1 });
  assert.equal(result.status, "VERIFIED", JSON.stringify(result.lastError));
  assert.equal(result.tasks[0].evidence[1].kind, "command");
  assert.equal(result.tasks[0].evidence[1].exitCode, 0);
  assert.equal(result.tasks[0].verificationStarted, false);
  const evidence = result.tasks[0].evidence[1];
  const loaded = await TaskCoordinator.load({ ...f, supervisor });
  const resumed = await loaded.tick();
  assert.equal(resumed.status, "VERIFIED");
  assert.deepEqual(resumed.tasks[0].evidence[1], evidence);
  assert.deepEqual(supervisor.calls, ["build verified output"]);
});

test("FV-02 a failing real Node test blocks the task instead of reporting success", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"),
    'const test = require("node:test"); test("real failure", () => { throw Error("failure"); });');
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const proposed = { goal: "Reject failing verifier", tasks: [{
    id: "check", instruction: "run failing verifier", dependsOn: [],
    acceptance: [{ kind: "command", program: "node",
      argv: ["--test", "test/accept.test.js"], cwd: ".", timeoutMs: 10000 }],
  }] };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const result = await coordinator.run({ timeoutMs: 15000, pollMs: 1 });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lastError, "VERIFIER_COMMAND_FAILED");
  assert.equal(result.tasks[0].status, "BLOCKED");
  assert.equal(result.tasks[0].evidence, null);
  assert.deepEqual(supervisor.calls, ["run failing verifier"]);
});

test("FV-02 forged or incomplete command evidence fails closed on resume", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"),
    'const test = require("node:test"); test("pass", () => {});');
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const proposed = { goal: "Evidence integrity", tasks: [{
    id: "check", instruction: "evidence check", dependsOn: [],
    acceptance: [{ kind: "command", program: "node",
      argv: ["--test", "test/accept.test.js"], cwd: ".", timeoutMs: 10000 }],
  }] };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  assert.equal((await coordinator.run({ timeoutMs: 15000, pollMs: 1 })).status, "VERIFIED");
  const state = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  state.tasks[0].evidence[0].exitCode = 1;
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(TaskCoordinator.load({ ...f, supervisor }),
    { code: "VERIFIER_EVIDENCE_INVALID" });
});

test("FV-02 interrupted in-flight command verification is not automatically replayed", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot, status: "queued" });
  const proposed = { goal: "No uncertain verification replay", tasks: [{
    id: "check", instruction: "uncertain check", dependsOn: [],
    acceptance: [{ kind: "command", program: "npm", argv: ["test"] }],
  }] };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const running = await coordinator.tick();
  assert.equal(running.tasks[0].status, "RUNNING");
  const state = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  state.tasks[0].status = "VERIFYING";
  state.tasks[0].verificationStarted = true;
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  supervisor.tasks.get(state.tasks[0].supervisorTaskId).status = "completed";
  const loaded = await TaskCoordinator.load({ ...f, supervisor });
  const resumed = await loaded.tick();
  assert.equal(resumed.status, "BLOCKED");
  assert.equal(resumed.lastError, "VERIFIER_COMPLETION_UNKNOWN");
  assert.equal(resumed.tasks[0].evidence, null);
});


test("FV-03 receipts bind completed tasks, workspace identity, evidence, and local environment", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: { "build receipt": ["receipt.txt", "documented output"] },
  });
  const proposed = {
    goal: "Save a versioned verification receipt",
    tasks: [{
      id: "receipt", instruction: "build receipt", dependsOn: [],
      acceptance: [{ kind: "file", path: "receipt.txt", minBytes: 1 }],
    }],
  };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const result = await coordinator.run({ timeoutMs: 5000, pollMs: 1 });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.schema, 2);
  const task = result.tasks[0];
  assert.equal(task.verificationReceipt.schema, 1);
  assert.equal(task.verificationReceipt.planId, result.planId);
  assert.equal(task.verificationReceipt.workspaceId, result.workspaceId);
  assert.equal(task.verificationReceipt.workspaceRoot, result.workspaceRoot);
  assert.equal(task.verificationReceipt.taskId, task.id);
  assert.equal(task.verificationReceipt.supervisorTaskId, task.supervisorTaskId);
  assert.equal(task.verificationReceipt.idempotencyKey, task.idempotencyKey);
  assert.equal(task.verificationReceipt.environment.node, process.version);
  assert.equal(task.verificationReceipt.environment.platform, process.platform);
  assert.match(task.verificationReceipt.digest, /^[a-f0-9]{64}$/);
  assert.match(task.verificationReceipt.baselineHash, /^[a-f0-9]{64}$/);
  assert.match(task.verificationReceipt.evidenceHash, /^[a-f0-9]{64}$/);
  const reloaded = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await reloaded.tick()).status, "VERIFIED");
});

test("FV-03 rejects omitted, mutated, and cross-identity verification receipts during load", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: { "build integrity": ["integrity.txt", "good output"] },
  });
  const proposed = {
    goal: "Prevent accidental evidence corruption",
    tasks: [{
      id: "integrity", instruction: "build integrity", dependsOn: [],
      acceptance: [{ kind: "file", path: "integrity.txt", minBytes: 1 }],
    }],
  };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  assert.equal((await coordinator.run({ timeoutMs: 5000, pollMs: 1 })).status, "VERIFIED");
  const pristine = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  const corruptions = [
    ["missing receipt", (s) => { s.tasks[0].verificationReceipt = null; }],
    ["wrong digest", (s) => { s.tasks[0].verificationReceipt.digest = "0".repeat(64); }],
    ["wrong task", (s) => { s.tasks[0].verificationReceipt.taskId = "other"; }],
    ["wrong plan", (s) => { s.tasks[0].verificationReceipt.planId = randomUUID(); }],
    ["wrong environment", (s) => { s.tasks[0].verificationReceipt.environment.node = "v0.0.0"; }],
    ["changed evidence", (s) => { s.tasks[0].evidence[0].bytes += 1; }],
    ["changed file baseline", (s) => { s.tasks[0].baseline[0].sha256 = "1".repeat(64); }],
    ["changed acceptance", (s) => { s.tasks[0].acceptance[0].minBytes += 1; }],
    ["changed instruction", (s) => { s.tasks[0].instruction += " changed"; }],
    ["unexpected receipt field", (s) => { s.tasks[0].verificationReceipt.extra = true; }],
  ];
  for (const [label, mutate] of corruptions) {
    const changed = structuredClone(pristine);
    mutate(changed);
    await fs.writeFile(f.stateFile, JSON.stringify(changed));
    await assert.rejects(TaskCoordinator.load({ ...f, supervisor }),
      { code: "VERIFIER_EVIDENCE_INVALID" }, label);
  }
  await fs.writeFile(f.stateFile, JSON.stringify(pristine));
  assert.equal((await TaskCoordinator.load({ ...f, supervisor })).getState().status, "VERIFIED");
});

test("FV-03 rejects receipts attached to tasks that are not VERIFIED", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  const state = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  state.tasks[0].verificationReceipt = { schema: 1 };
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(TaskCoordinator.load({ ...f, supervisor }),
    { code: "VERIFIER_EVIDENCE_INVALID" });
});

test("FV-03 preserves schema 1 file-only checkpoint compatibility without inventing receipts", async (t) => {
  const f = await fixture(t);
  const supervisor = fakeSupervisor({
    workspaceRoot: f.workspaceRoot,
    outputs: { "build one": ["one.txt", "first"],
      "build two": ["two.txt", "second"], "build three": ["three.txt", "third"] },
  });
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: plan() });
  assert.equal((await coordinator.run({ timeoutMs: 5000, pollMs: 1 })).status, "VERIFIED");
  const state = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  state.schema = 1;
  for (const task of state.tasks) delete task.verificationReceipt;
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  const legacy = await TaskCoordinator.load({ ...f, supervisor });
  const resumed = await legacy.tick();
  assert.equal(resumed.schema, 1);
  assert.equal(resumed.status, "VERIFIED");
  assert.ok(resumed.tasks.every((task) => task.verificationReceipt === undefined));
});


test("FV-04 resume detects source drift without replaying successful verification", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "src"));
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.writeFile(path.join(f.workspaceRoot, "src", "app.js"), "export const version = 1;\n");
  const testSource = [
    'const test = require("node:test");',
    'const fs = require("node:fs");',
    'test("record execution", () => {',
    '  const file = "runs.txt";',
    '  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;',
    '  fs.writeFileSync(file, String(n + 1));',
    '});',
  ].join("\n");
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"), testSource);
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const proposed = {
    goal: "Verify and detect input drift on resume",
    tasks: [{
      id: "check", instruction: "run independent test once", dependsOn: [],
      acceptance: [{ kind: "command", program: "node",
        argv: ["--test", "test/accept.test.js"], cwd: ".", timeoutMs: 10000 }],
    }],
  };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const completed = await coordinator.run({ timeoutMs: 15000, pollMs: 1 });
  assert.equal(completed.status, "VERIFIED", completed.lastError);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1");
  assert.match(completed.tasks[0].evidence[0].inputsHash, /^[a-f0-9]{64}$/);

  const restored = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await restored.tick()).status, "VERIFIED");
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1",
    "Resume must never execute an already-completed command");
  assert.deepEqual(supervisor.calls, ["run independent test once"]);

  await fs.writeFile(path.join(f.workspaceRoot, "src", "app.js"), "export const version = 2;\n");
  const drift = await restored.tick();
  assert.equal(drift.status, "BLOCKED");
  assert.equal(drift.lastError, "VERIFIER_INPUT_DRIFT");
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1");
  assert.deepEqual(supervisor.calls, ["run independent test once"]);
});


test("FV-05 Coordinator requires real test and integration results, then resumes read-only", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.mkdir(path.join(f.workspaceRoot, "src"));
  await fs.writeFile(path.join(f.workspaceRoot, "src", "feature.js"), "export const ready = true;\n");
  const testSource = [
    'const test = require("node:test");',
    'const fs = require("node:fs");',
    'test("verified business logic", () => {',
    '  const file = "runs.txt";',
    '  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;',
    '  fs.writeFileSync(file, String(n + 1));',
    '});',
  ].join("\n");
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"), testSource);
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"state":"ready","secret":"not-for-evidence"}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const proposed = {
    goal: "Verify tests and observable localhost behavior",
    tasks: [{
      id: "verify", instruction: "perform FV-05 task", dependsOn: [],
      acceptance: [
        { kind: "test", program: "node", argv: ["--test", "test/accept.test.js"],
          cwd: ".", timeoutMs: 10000, minTests: 1, maxSkipped: 0 },
        { kind: "integration", port, path: "/health",
          expectedStatus: 200, expectedContains: '"state":"ready"',
          timeoutMs: 5000 },
      ],
    }],
  };
  const coordinator = await TaskCoordinator.create({ ...f, supervisor, plan: proposed });
  const completed = await coordinator.run({ timeoutMs: 15000, pollMs: 1 });
  assert.equal(completed.status, "VERIFIED", completed.lastError);
  assert.equal(completed.tasks[0].evidence[0].testSummary.passed, 1);
  assert.equal(completed.tasks[0].evidence[1].statusCode, 200);
  assert.equal(completed.tasks[0].evidence[1].containsExpected, true);
  assert.doesNotMatch(JSON.stringify(completed), /not-for-evidence/);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1");
  assert.equal(requests, 1);

  const restored = await TaskCoordinator.load({ ...f, supervisor });
  assert.equal((await restored.tick()).status, "VERIFIED");
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1");
  assert.equal(requests, 1, "Read-only resume must not issue another HTTP request");
  assert.deepEqual(supervisor.calls, ["perform FV-05 task"]);

  await fs.writeFile(path.join(f.workspaceRoot, "src", "feature.js"), "export const ready = false;\n");
  const drift = await restored.tick();
  assert.equal(drift.status, "BLOCKED");
  assert.equal(drift.lastError, "VERIFIER_INPUT_DRIFT");
  assert.equal(requests, 1);
  assert.equal(await fs.readFile(path.join(f.workspaceRoot, "runs.txt"), "utf8"), "1");
});

test("FV-05 Coordinator rejects a test-less file even with exit code zero", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.workspaceRoot, "test"));
  await fs.writeFile(path.join(f.workspaceRoot, "test", "accept.test.js"),
    "// test runner returns success for a file without registered tests\n");
  const supervisor = fakeSupervisor({ workspaceRoot: f.workspaceRoot });
  const coordinator = await TaskCoordinator.create({
    ...f, supervisor,
    plan: {
      goal: "Never accept empty test files",
      tasks: [{
        id: "empty", instruction: "claim tests pass", dependsOn: [],
        acceptance: [{
          kind: "test", program: "node",
          argv: ["--test", "test/accept.test.js"],
          cwd: ".", timeoutMs: 10000, minTests: 1, maxSkipped: 0,
        }],
      }],
    },
  });
  const outcome = await coordinator.run({ timeoutMs: 15000, pollMs: 1 });
  assert.equal(outcome.status, "BLOCKED");
  assert.equal(outcome.lastError, "VERIFIER_TEST_FAILED");
  assert.deepEqual(supervisor.calls, ["claim tests pass"]);
});
