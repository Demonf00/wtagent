import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runWorkerProcess } from "../src/supervisor/worker-client.js";
import { TaskControl } from "../src/supervisor/task-control.js";
import { SupervisorApprovalProvider } from "../src/supervisor/approval-provider.js";

const settings = {
  heartbeatMs: 10,
  progressTimeoutMs: 100,
};

class FakeChild extends EventEmitter {
  constructor(onSend) {
    super();
    this.pid = 12345;
    this.connected = true;
    this.sent = [];
    this.kills = 0;
    this.onSend = onSend;
  }
  send(message, callback) {
    this.sent.push(message);
    this.onSend?.(message, this);
    callback?.(null);
    return true;
  }
  kill() {
    if (!this.connected) return false;
    this.kills++;
    this.exit(1);
    return true;
  }
  exit(code = 0) {
    if (!this.connected) return;
    this.connected = false;
    this.emit("exit", code, null);
  }
}

function harness(onSend, { control = new TaskControl(), onRequired = async () => {} } = {}) {
  let child;
  const approvalProvider = new SupervisorApprovalProvider({ control, onRequired });
  const run = runWorkerProcess({
    sessionsDir: "/tmp/sessions", sessionId: "sess", workspaceRoot: "/tmp",
    options: {}, settings, control, approvalProvider,
    forkProcess: () => (child = new FakeChild(onSend)),
  });
  return { run, control, approvalProvider, get child() { return child; } };
}

test("worker result is returned only after process exit", async () => {
  const h = harness((message, child) => {
    if (message.type !== "start") return;
    queueMicrotask(() => {
      child.emit("message", {
        type: "result", result: { message: "finished", cancelled: false },
      });
      // The result is not sufficient; the child must have exited.
      queueMicrotask(() => child.exit(0));
    });
  });
  const result = await h.run;
  assert.equal(result.message, "finished");
  assert.equal(h.child.connected, false);
  assert.equal(h.child.kills, 0);
});

test("worker exit during approval aborts the pending decision", async () => {
  let published;
  let notifyPublished;
  const required = new Promise((resolve) => { notifyPublished = resolve; });
  const h = harness((message, child) => {
    if (message.type === "start") {
      queueMicrotask(() => child.emit("message", {
        type: "approval.required",
        requestId: "approval-1",
        toolCall: { id: "tool", name: "fs.read", args: { path: "safe" } },
        reasons: [],
      }));
    }
  }, {
    onRequired: async ({ requestId }) => {
      published = requestId;
      notifyPublished();
    },
  });
  await required;
  assert.equal(published, h.approvalProvider.pending.requestId);
  h.child.exit(1);
  await assert.rejects(h.run, { code: "WORKER_EXITED" });
  assert.equal(h.approvalProvider.pending, null);
});

test("cancel requests control stop and does not retry on worker exit", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const h = harness((message, child) => {
    if (message.type === "start") started();
    if (message.type === "control") child.exit(1);
  });
  await ready;
  h.control.request("cancel");
  await assert.rejects(h.run, { code: "TASK_CANCELLED" });
  assert.ok(h.child.sent.some((item) =>
    item.type === "control" && item.reason === "cancel"));
});

test("watchdog detects no progress while heartbeat alone remains healthy", async () => {
  let heartbeat;
  const h = harness((message, child) => {
    if (message.type === "start") {
      heartbeat = setInterval(() => {
        if (child.connected) child.emit("message", { type: "heartbeat" });
      }, 5);
    }
  });
  try {
    await assert.rejects(h.run, { code: "WORKER_PROGRESS_TIMEOUT" });
    assert.ok(h.child.kills > 0);
    assert.equal(h.child.connected, false);
  } finally {
    clearInterval(heartbeat);
  }
});

test("worker crash cannot be mistaken for successful task completion", async () => {
  const h = harness((message, child) => {
    if (message.type === "start") queueMicrotask(() => child.exit(1));
  });
  await assert.rejects(h.run, { code: "WORKER_EXITED" });
});
