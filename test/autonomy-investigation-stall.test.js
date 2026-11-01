
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";
import {
  MAX_READ_ONLY_STREAK, MAX_STALL_REPLANS,
  initialInvestigationMonitor, observeInvestigationEvents,
  validateInvestigationMonitor,
} from "../src/autonomy/investigation-stall.js";
import { safeRuntimeEvent } from "../src/supervisor/recovery-controller.js";

function event(seq, type, payload) {
  return { seq, type, payload: safeRuntimeEvent({ type, payload }).payload };
}

function readEvents(start = 1, count = MAX_READ_ONLY_STREAK) {
  const events = [];
  let seq = start;
  for (let i = 0; i < count; i++) {
    events.push(event(seq++, "tool.started", { name: "fs.read", args: { secret: "never-persist" } }));
    events.push(event(seq++, "tool.result_sent", { name: "fs.read", ok: true }));
  }
  return events;
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-dp02-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, "workspace");
  const stateFile = path.join(base, "checkpoint", "state.json");
  await fs.mkdir(workspaceRoot);
  const records = new Map();
  const keys = new Map();
  const streams = new Map();
  const calls = [];
  const pauses = [];
  const resumes = [];
  const supervisor = {
    calls, pauses, resumes, streams,
    async create({ workspaceId, instruction, idempotencyKey }) {
      if (keys.has(idempotencyKey)) return { taskId: keys.get(idempotencyKey) };
      const taskId = `task_${randomUUID()}`;
      keys.set(idempotencyKey, taskId);
      records.set(taskId, {
        taskId, status: "running", workspaceId, workspaceRoot,
        instruction, idempotencyKey,
      });
      streams.set(taskId, []);
      calls.push(instruction);
      return { taskId };
    },
    get(taskId) { return { ...records.get(taskId) }; },
    async getEvents(taskId, after = 0) {
      return (streams.get(taskId) ?? []).filter(item => item.seq > after);
    },
    async pause(taskId) {
      pauses.push(taskId);
      records.get(taskId).status = "pausing";
    },
    async resume(taskId) {
      resumes.push(taskId);
      records.get(taskId).status = "running";
    },
    setStatus(taskId, status) { records.get(taskId).status = status; },
    addEvents(taskId, entries) { streams.get(taskId).push(...entries); },
  };
  const plan = {
    goal: "Do work, then verify artifacts",
    tasks: [
      { id: "first", instruction: "build first", dependsOn: [],
        acceptance: [{ kind: "file", path: "first.txt", minBytes: 1 }] },
      { id: "second", instruction: "build second", dependsOn: ["first"],
        acceptance: [{ kind: "file", path: "second.txt", minBytes: 1 }] },
    ],
  };
  const params = { workspaceRoot, stateFile, workspaceId: "main", supervisor };
  const coordinator = await TaskCoordinator.create({ ...params, plan });
  const initial = await coordinator.tick();
  assert.equal(initial.tasks[0].status, "RUNNING");
  const taskId = initial.tasks[0].supervisorTaskId;
  assert.ok(taskId);
  return { base, workspaceRoot, stateFile, supervisor, params, coordinator, plan, taskId };
}

function revisedTasks(plan, suffix = "new") {
  return [
    structuredClone(plan.tasks[0]),
    { ...structuredClone(plan.tasks[1]), instruction: `build second ${suffix}` },
  ];
}

test("DP-02 sanitization retains only classification and result status across Worker and Supervisor", () => {
  const first = safeRuntimeEvent({
    type: "tool.result_sent",
    payload: { name: "fs.read", ok: true, args: { password: "SECRET" }, message: "SECRET" },
  });
  assert.deepEqual(first, {
    type: "tool.result_sent", payload: { toolClass: "read", ok: true },
  });
  assert.deepEqual(safeRuntimeEvent(first), first);
  const verify = safeRuntimeEvent({
    type: "tool.started", payload: { name: "terminal.exec", args: { command: "SECRET" } },
  });
  assert.deepEqual(verify.payload, { toolClass: "other" });
  assert.equal(JSON.stringify(first).includes("SECRET"), false);
});

test("DP-02 completed read-only exploration triggers at bounded threshold", () => {
  const monitor = observeInvestigationEvents(initialInvestigationMonitor(), readEvents());
  assert.equal(monitor.readOnlyStreak, MAX_READ_ONLY_STREAK);
  assert.equal(monitor.observedCompletions, MAX_READ_ONLY_STREAK);
  assert.equal(monitor.replanCount, 1);
  assert.equal(monitor.replanRequired, true);
  assert.deepEqual(observeInvestigationEvents(monitor, readEvents()), monitor);
});

test("DP-02 ignores in-flight long-running tools and verification activity", () => {
  let state = observeInvestigationEvents(initialInvestigationMonitor(),
    readEvents(1, MAX_READ_ONLY_STREAK - 1));
  state = observeInvestigationEvents(state, [
    event(23, "tool.started", { name: "terminal.exec" }),
  ]);
  assert.equal(state.replanRequired, false);
  assert.equal(state.readOnlyStreak, 0);
  state = observeInvestigationEvents(state, [
    event(24, "tool.result_sent", { name: "terminal.exec", ok: true }),
  ]);
  assert.equal(state.readOnlyStreak, 0);
  assert.equal(state.replanRequired, false);
  assert.equal(state.replanCount, 0);
});

test("DP-02 in-flight verification following threshold reads prevents premature pause", () => {
  const events = readEvents();
  events.push(event(2 * MAX_READ_ONLY_STREAK + 1, "tool.started", {
    name: "terminal.exec",
  }));
  const state = observeInvestigationEvents(initialInvestigationMonitor(), events);
  assert.equal(state.readOnlyStreak, 0);
  assert.equal(state.activeRead, false);
  assert.equal(state.replanRequired, false);
  assert.equal(state.replanCount, 0);
  assert.equal(state.observedCompletions, MAX_READ_ONLY_STREAK);
});

test("DP-02 repeated process polling during lengthy verification is not investigation", () => {
  const events = [];
  let seq = 1;
  for (let i = 0; i < MAX_READ_ONLY_STREAK + 10; i++) {
    events.push(event(seq++, "tool.started", { name: "process.read" }));
    events.push(event(seq++, "tool.result_sent", { name: "process.read", ok: true }));
  }
  const state = observeInvestigationEvents(initialInvestigationMonitor(), events);
  assert.equal(state.readOnlyStreak, 0);
  assert.equal(state.replanCount, 0);
  assert.equal(state.replanRequired, false);
  assert.equal(state.observedCompletions, MAX_READ_ONLY_STREAK + 10);
  assert.deepEqual(safeRuntimeEvent({
    type: "tool.result_sent", payload: { name: "process.read", ok: true },
  }).payload, { toolClass: "other", ok: true });
});

test("DP-02 reading followed by a real mutation does not falsely request replanning", () => {
  const events = readEvents();
  events.push(event(25, "tool.started", { name: "fs.write" }));
  events.push(event(26, "tool.result_sent", { name: "fs.write", ok: true }));
  const state = observeInvestigationEvents(initialInvestigationMonitor(), events);
  assert.equal(state.readOnlyStreak, 0);
  assert.equal(state.replanRequired, false);
  assert.equal(state.replanCount, 0);
});

test("DP-02 coordinator persists replan intent and never calls pause twice after restart", async t => {
  const f = await fixture(t);
  f.supervisor.addEvents(f.taskId, readEvents());
  const stalled = await f.coordinator.tick();
  assert.equal(stalled.status, "RUNNING");
  assert.equal(stalled.tasks[0].status, "RUNNING");
  assert.equal(stalled.tasks[0].verificationReceipt, null);
  assert.equal(stalled.investigation.monitor.replanRequired, true);
  assert.equal(stalled.investigation.monitor.replanCount, 1);
  assert.equal(f.supervisor.pauses.length, 1);
  assert.equal(f.supervisor.calls.length, 1);
  const stored = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(stored.investigation.monitor.lastSeq, 24);
  const restored = await TaskCoordinator.load(f.params);
  f.supervisor.setStatus(f.taskId, "paused");
  const state = await restored.tick();
  assert.equal(state.investigation.monitor.replanRequired, true);
  assert.equal(state.status, "RUNNING");
  assert.equal(state.tasks[0].status, "RUNNING");
  assert.equal(f.supervisor.pauses.length, 1);
  assert.equal(f.supervisor.calls.length, 1);
});

test("DP-02 refuses replanning until paused and preserves running worker identity", async t => {
  const f = await fixture(t);
  f.supervisor.addEvents(f.taskId, readEvents());
  await f.coordinator.tick();
  const before = f.coordinator.getState();
  await assert.rejects(f.coordinator.revisePlan({
    expectedRevision: 0, tasks: revisedTasks(f.plan),
  }), { code: "PLAN_REVISION_BLOCKED" });
  f.supervisor.setStatus(f.taskId, "paused");
  const revised = await f.coordinator.revisePlan({
    expectedRevision: 0, tasks: revisedTasks(f.plan),
  });
  assert.equal(revised.planRevision, 1);
  assert.equal(revised.investigation.monitor.replanRequired, false);
  assert.equal(revised.investigation.monitor.replanCount, 1);
  assert.deepEqual(revised.tasks[0], before.tasks[0]);
  assert.equal(revised.tasks[1].status, "TODO");
  assert.equal(f.supervisor.calls.length, 1);
  const restarted = await TaskCoordinator.load(f.params);
  const resumed = await restarted.tick({ resumePaused: true });
  assert.equal(resumed.status, "RUNNING");
  assert.equal(f.supervisor.resumes.length, 1);
  assert.equal(f.supervisor.calls.length, 1);
});

test("DP-02 replan attempts are globally bounded across revisions", async t => {
  const f = await fixture(t);
  let next = 1;
  for (let attempt = 0; attempt < MAX_STALL_REPLANS; attempt++) {
    f.supervisor.addEvents(f.taskId, readEvents(next));
    next += 2 * MAX_READ_ONLY_STREAK;
    const stalled = await f.coordinator.tick();
    assert.equal(stalled.investigation.monitor.replanRequired, true);
    assert.equal(stalled.investigation.monitor.replanCount, attempt + 1);
    f.supervisor.setStatus(f.taskId, "paused");
    await f.coordinator.revisePlan({
      expectedRevision: attempt,
      tasks: revisedTasks(f.plan, `revision${attempt + 1}`),
    });
    await f.coordinator.tick({ resumePaused: true });
  }
  f.supervisor.addEvents(f.taskId, readEvents(next));
  const final = await f.coordinator.tick();
  assert.equal(final.investigation.monitor.replanCount, MAX_STALL_REPLANS);
  assert.equal(final.investigation.monitor.replanRequired, false);
  assert.equal(final.investigation.monitor.budgetExhausted, true);
  assert.equal(final.tasks[0].status, "RUNNING");
  assert.equal(final.tasks[0].verificationReceipt, null);
  assert.equal(f.supervisor.pauses.length, MAX_STALL_REPLANS + 1);
  f.supervisor.setStatus(f.taskId, "paused");
  const checkpoint = await TaskCoordinator.load(f.params);
  const afterRestart = await checkpoint.tick({ resumePaused: true });
  assert.equal(afterRestart.investigation.monitor.budgetExhausted, true);
  assert.equal(f.supervisor.pauses.length, MAX_STALL_REPLANS + 1);
  assert.equal(f.supervisor.resumes.length, MAX_STALL_REPLANS);
  await assert.rejects(checkpoint.revisePlan({
    expectedRevision: MAX_STALL_REPLANS,
    tasks: revisedTasks(f.plan, "after-budget-exhausted"),
  }), { code: "PLAN_REVISION_BLOCKED" });
  assert.equal(f.supervisor.calls.length, 1);
});

test("DP-02 completed Worker is independently verified, not declared stalled", async t => {
  const f = await fixture(t);
  f.supervisor.addEvents(f.taskId, readEvents());
  await fs.writeFile(path.join(f.workspaceRoot, "first.txt"), "delivered");
  f.supervisor.setStatus(f.taskId, "completed");
  const result = await f.coordinator.tick();
  assert.equal(result.tasks[0].status, "VERIFIED");
  assert.equal(result.tasks[0].verificationReceipt !== null, true);
  assert.equal(f.supervisor.pauses.length, 0);
});

test("DP-02 validates restored monitor, never trusts a forged success flag", async t => {
  const f = await fixture(t);
  f.supervisor.addEvents(f.taskId, readEvents());
  await f.coordinator.tick();
  const stored = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  stored.investigation.monitor.replanCount = 999;
  await fs.writeFile(f.stateFile, JSON.stringify(stored));
  await assert.rejects(TaskCoordinator.load(f.params), { code: "STATE_UNSAFE" });
  assert.throws(() => validateInvestigationMonitor({
    ...initialInvestigationMonitor(), lastSeq: -1,
  }), { code: "STATE_UNSAFE" });
});


test("DP-02 stale Coordinator cannot overwrite a durable investigation pause", async t => {
  const f = await fixture(t);
  const stale = await TaskCoordinator.load(f.params);
  f.supervisor.addEvents(f.taskId, readEvents());
  await f.coordinator.tick();
  f.supervisor.setStatus(f.taskId, "paused");
  const before = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(before.investigation.monitor.replanRequired, true);
  await assert.rejects(stale.revisePlan({
    expectedRevision: 0,
    tasks: revisedTasks(f.plan, "stale-writer"),
  }), { code: "PLAN_REVISION_CONFLICT" });
  const after = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.deepEqual(after, before);
  assert.equal(after.tasks[0].status, "RUNNING");
  assert.equal(f.supervisor.calls.length, 1);
});
