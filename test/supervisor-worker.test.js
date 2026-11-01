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
    queueMicrotask(() => this.emit("message", { type: "ready" }));
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

function harness(onSend, {
  control = new TaskControl(), onRequired = async () => {}, onDisplay = null,
} = {}) {
  let child;
  const approvalProvider = new SupervisorApprovalProvider({ control, onRequired });
  const run = runWorkerProcess({
    sessionsDir: "/tmp/sessions", sessionId: "sess", workspaceRoot: "/tmp",
    options: {}, settings, control, approvalProvider, onDisplay,
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

test("worker waits for ready handshake before sending start", async () => {
  let child;
  const control = new TaskControl();
  const approvalProvider = new SupervisorApprovalProvider({ control, onRequired: async () => {} });
  const run = runWorkerProcess({
    sessionsDir: "/tmp/sessions", sessionId: "sess", workspaceRoot: "/tmp",
    settings, control, approvalProvider,
    forkProcess: () => {
      child = new FakeChild((message, target) => {
        if (message.type === "start") queueMicrotask(() => {
          target.emit("message", { type: "result", result: { message: "ok" } });
          target.exit(0);
        });
      });
      return child;
    },
  });
  assert.equal(child.sent.some((message) => message.type === "start"), false);
  assert.equal((await run).message, "ok");
  assert.equal(child.sent.filter((message) => message.type === "start").length, 1);
});

test("IPC failure preserves nonrecoverable marker", async () => {
  const h = harness((message, child) => {
    if (message.type !== "start") return;
    queueMicrotask(() => {
      child.emit("message", { type: "failure", error: {
        code: "BROWSER_UNAVAILABLE", name: "BrowserAdapterError",
        message: "Browser cannot start", recoverable: false,
      } });
      child.exit(1);
    });
  });
  await assert.rejects(h.run, (error) =>
    error.code === "BROWSER_UNAVAILABLE"
    && error.recoverable === false
    && error.name === "BrowserAdapterError");
});

test("result recovery errors retain nonrecoverable marker", async () => {
  const h = harness((message, child) => {
    if (message.type !== "start") return;
    queueMicrotask(() => {
      child.emit("message", { type: "result", result: {
        message: null, recoveryRequired: true,
        error: { code: "RECOVERY_UNAVAILABLE", recoverable: false },
      } });
      child.exit(0);
    });
  });
  const result = await h.run;
  assert.equal(result.error.code, "RECOVERY_UNAVAILABLE");
  assert.equal(result.error.recoverable, false);
});

test("worker IPC preserves only whitelisted challenge evidence", async () => {
  const h = harness((message, child) => {
    if (message.type !== "start") return;
    queueMicrotask(() => {
      child.emit("message", { type: "failure", error: {
        code: "BROWSER_ACCESS_CHALLENGE", recoverable: false,
        message: "Browser verification required", challengeEvidence: "BODY",
      } });
      child.exit(1);
    });
  });
  await assert.rejects(h.run, (error) =>
    error.code === "BROWSER_ACCESS_CHALLENGE"
    && error.details?.evidence === "BODY"
    && error.recoverable === false);
});


test("Worker IPC relays model and tool echo to local display without persisting provider content", async () => {
  const displayed = [];
  const h = harness((message, child) => {
    if (message.type !== "start") return;
    queueMicrotask(() => {
      child.emit("message", {
        type: "live",
        event: { type: "model.progress", payload: {
          message: "Checking source files",
          extra: "SECRET_NOT_FOR_SUPERVISOR_STORAGE",
        } },
      });
      child.emit("message", {
        type: "live",
        event: { type: "tool.proposed", payload: {
          name: "terminal.exec",
          args: { argv: ["-e", "PASSWORD=SECRET"] },
        } },
      });
      child.emit("message", {
        type: "live",
        event: { type: "tool.completed", payload: {
          result: { name: "terminal.exec", ok: true, stdout: "SECRET" },
        } },
      });
      child.emit("message", { type: "result", result: { message: "done" } });
      child.exit(0);
    });
  }, {
    onDisplay: (event) => displayed.push(event),
  });
  assert.equal((await h.run).message, "done");
  assert.deepEqual(displayed.map((item) => item.type), [
    "model.progress", "tool.proposed", "tool.completed",
  ]);
  assert.deepEqual(displayed[1].payload, { name: "terminal.exec" });
  assert.deepEqual(displayed[2].payload, { name: "terminal.exec", ok: true });
  assert.doesNotMatch(JSON.stringify(displayed), /SECRET|PASSWORD/);
});
