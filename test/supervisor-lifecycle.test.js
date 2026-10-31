import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { AgentSession } from "../src/session/agent-session.js";

async function fixture(t, { execute, autoRun = true, recovery = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-supervisor-"));
  const dataDir = path.join(root, "supervisor");
  const sessionsDir = path.join(root, "sessions");
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  let supervisor;
  const makeSupervisor = async (overrides = {}) => {
    supervisor = new TaskSupervisor({
      dataDir, sessionsDir,
      workspaces: [{ id: "main", root: workspaceRoot }],
      autoRun,
      execute,
      options: { recovery: { retryBaseMs: 10, retryMaxMs: 20, maxRetries: 2, ...recovery } },
      ...overrides,
    });
    await supervisor.init();
    return supervisor;
  };
  t.after(async () => {
    await supervisor?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await makeSupervisor();
  return {
    get supervisor() { return supervisor; },
    makeSupervisor, dataDir, sessionsDir, workspaceRoot,
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Supervisor state.");
}

test("completed task persists events and de-duplicates idempotent create", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    execute: async () => { calls++; return { message: "done" }; },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "run test",
    idempotencyKey: "stable-1",
  });
  const complete = await waitFor(() => {
    const record = f.supervisor.get(created.taskId);
    return record.status === "completed" && record;
  });
  assert.equal(complete.result.message, "done");
  assert.equal(calls, 1);
  const duplicate = await f.supervisor.create({
    workspaceId: "main", instruction: "run test",
    idempotencyKey: "stable-1",
  });
  assert.equal(duplicate.taskId, created.taskId);
  assert.equal(f.supervisor.list().length, 1);
  const events = await f.supervisor.getEvents(created.taskId);
  assert.ok(events.some((event) => event.type === "task.completed"));
  assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
});

test("transient pre-start failure has bounded durable retry and completes", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    execute: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("temporary"), { code: "TURN_TIMEOUT" });
      return { message: "recovered" };
    },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "retry task",
  });
  const result = await waitFor(() => {
    const task = f.supervisor.get(created.taskId);
    return task.status === "completed" && task;
  });
  assert.equal(result.retries, 1);
  assert.equal(result.attempts, 2);
  assert.equal(result.result.message, "recovered");
  assert.equal(calls, 2);
  const events = await f.supervisor.getEvents(created.taskId);
  assert.ok(events.some((event) => event.type === "task.retry_scheduled"));
  assert.ok(events.some((event) => event.type === "task.retry_ready"));
});

test("failed worker after ambiguous checkpoint is blocked, not retried", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    execute: async ({ session }) => {
      calls++;
      await session.update({ runCount: 1, phase: "interrupted" });
      throw Object.assign(new Error("unknown send"), { code: "TURN_TIMEOUT" });
    },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "unsafe task",
  });
  const blocked = await waitFor(() => {
    const task = f.supervisor.get(created.taskId);
    return task.status === "blocked_uncertain" && task;
  });
  assert.equal(calls, 1);
  assert.equal(blocked.retries, 0);
  assert.equal(blocked.error, "NO_SAFE_RECOVERY_CHECKPOINT");
  await assert.rejects(() => f.supervisor.resume(created.taskId), { code: "CONFLICT" });
  const cancelled = await f.supervisor.cancel(created.taskId);
  assert.equal(cancelled.status, "cancelled");
});

test("restart conservatively classifies stale running task", async (t) => {
  const f = await fixture(t, { autoRun: false, execute: async () => ({ message: "ok" }) });
  const record = await f.supervisor.create({
    workspaceId: "main", instruction: "restart safely",
  });
  await f.supervisor.close();
  const file = path.join(f.dataDir, `${record.taskId}.json`);
  await fs.writeFile(file, JSON.stringify({ ...record, status: "running" }));
  await f.makeSupervisor({ autoRun: false });
  const recovered = f.supervisor.get(record.taskId);
  assert.equal(recovered.status, "waiting_retry");
  assert.equal(recovered.retries, 1);
  assert.ok(Date.parse(recovered.retryAt) > 0);
});

test("restart blocks stale task without safe checkpoint", async (t) => {
  const f = await fixture(t, { autoRun: false, execute: async () => ({ message: "ok" }) });
  const record = await f.supervisor.create({
    workspaceId: "main", instruction: "restart with unknown send",
  });
  const session = await AgentSession.load({
    sessionsDir: f.sessionsDir, sessionId: record.sessionId,
  });
  await session.update({ runCount: 1, phase: "interrupted" });
  await f.supervisor.close();
  await fs.writeFile(path.join(f.dataDir, `${record.taskId}.json`),
    JSON.stringify({ ...record, status: "running" }));
  await f.makeSupervisor({ autoRun: false });
  const blocked = f.supervisor.get(record.taskId);
  assert.equal(blocked.status, "blocked_uncertain");
  assert.equal(blocked.error, "NO_SAFE_RECOVERY_CHECKPOINT");
});

test("Supervisor event log never stores streamed or tool-argument secrets", async (t) => {
  const secret = "TOP_SECRET_MODEL_STREAM";
  const f = await fixture(t, {
    execute: async ({ onEvent }) => {
      await onEvent({ type: "model.streaming", payload: { delta: secret } });
      await onEvent({ type: "tool.proposed", payload: { args: { password: secret } } });
      return { message: "safe result" };
    },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "privacy test",
  });
  await waitFor(() => f.supervisor.get(created.taskId).status === "completed");
  const events = await f.supervisor.getEvents(created.taskId);
  assert.ok(events.some((event) => event.type === "tool.proposed"));
  assert.equal(events.some((event) => event.type === "model.streaming"), false);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test("explicitly nonrecoverable worker failure terminates without retry", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    execute: async () => {
      calls++;
      throw Object.assign(new Error("configuration rejected"), {
        code: "BROWSER_CONFIG_INVALID", recoverable: false,
      });
    },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "must not retry",
  });
  const deadline = Date.now() + 5000;
  let failed;
  while (Date.now() < deadline) {
    const record = f.supervisor.get(created.taskId);
    if (record.status === "failed") { failed = record; break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(failed, "task must fail rather than enter a retry loop");
  assert.equal(failed.error, "NONRECOVERABLE_WORKER_ERROR");
  assert.equal(failed.retries, 0);
  assert.equal(calls, 1);
});

test("browser access challenge during pending assistant handoff is never retried automatically", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    execute: async ({ session }) => {
      calls++;
      await session.update({
        phase: "waiting_model", runCount: 1,
        conversationTargetId: "saved-tab",
        pendingAssistantTurn: {
          handoffId: "outbound:one", sourceOutboundId: "one",
          conversationTargetId: "saved-tab", status: "waiting",
        },
      });
      throw Object.assign(new Error("Browser access challenge detected."), {
        code: "BROWSER_ACCESS_CHALLENGE", recoverable: false,
      });
    },
  });
  const created = await f.supervisor.create({
    workspaceId: "main", instruction: "test challenge pause",
  });
  const failed = await waitFor(() => {
    const task = f.supervisor.get(created.taskId);
    return task.status === "failed" && task;
  });
  assert.equal(failed.error, "NONRECOVERABLE_WORKER_ERROR");
  assert.equal(failed.incident.code, "BROWSER_ACCESS_CHALLENGE");
  assert.equal(failed.incident.reason, "PENDING_ASSISTANT_TURN");
  assert.equal(failed.retries, 0);
  assert.equal(failed.attempts, 1);
  assert.equal(calls, 1);
});
