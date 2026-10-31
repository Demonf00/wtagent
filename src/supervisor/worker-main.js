import { AgentSession } from "../session/agent-session.js";
import { executeConversationTurn } from "../runtime/conversation-runner.js";
import { TaskControl } from "./task-control.js";
import { approvalIdentity } from "./approval-provider.js";
import { safeRuntimeEvent } from "./recovery-controller.js";

// A task worker is disposable. The Supervisor owns scheduling, persistence,
// decisions and recovery. Only the existing runtime may reconcile an outbound.
const control = new TaskControl();
const approvals = new Map();
let started = false;
let shuttingDown = false;
let heartbeat;
let lastProgress = 0;

function send(message) {
  if (process.connected && process.send) {
    try { process.send(message); } catch { /* Supervisor has gone away. */ }
  }
}

function failureCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : "WORKER_ERROR";
}

// IPC does not automatically serialize Error's non-enumerable fields.
// These details stay inside parent/child IPC; Supervisor persists only safe codes.
function serializeError(error) {
  if (!error) return null;
  return {
    code: failureCode(error),
    name: typeof error.name === "string" ? error.name.slice(0, 128) : "Error",
    message: typeof error.message === "string" ? error.message.slice(0, 2048) : "",
    stack: typeof error.stack === "string" ? error.stack.slice(0, 8192) : null,
    ...(typeof error.recoverable === "boolean" ? { recoverable: error.recoverable } : {}),
  };
}

// Wait for the final message to be handed to IPC before disconnecting.
async function sendFinal(message) {
  if (!process.connected || !process.send) return;
  await new Promise((resolve) => {
    try { process.send(message, () => resolve()); } catch { resolve(); }
  });
}

function progress(type) {
  const time = Date.now();
  if (time - lastProgress >= 1000) {
    lastProgress = time;
    send({ type: "progress", eventType: type });
  }
}

async function requestApproval({ toolCall, reasons }) {
  control.checkpoint();
  const requestId = approvalIdentity(toolCall);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (approved, error) => {
      if (settled) return;
      settled = true;
      approvals.delete(requestId);
      unsubscribe();
      if (error) reject(error);
      else resolve(approved);
    };
    approvals.set(requestId, finish);
    unsubscribe = control.onStop((error) => finish(false, error));
    if (settled) unsubscribe();
    else send({
      type: "approval.required", requestId,
      toolCall: {
        id: toolCall.id, name: toolCall.name, args: toolCall.args,
      },
      reasons,
    });
  });
}

function quietRenderer() {
  return {
    handle() {}, stopSpinner() {}, finish() {}, hint() {}, println() {},
  };
}

async function run(message) {
  try {
    const session = await AgentSession.load({
      sessionsDir: message.sessionsDir,
      sessionId: message.sessionId,
    });
    if (session.state.projectRoot !== message.workspaceRoot) {
      const error = new Error("Workspace changed.");
      error.code = "STORAGE_UNSAFE";
      throw error;
    }
    process.chdir(message.workspaceRoot);
    const result = await executeConversationTurn({
      session,
      options: message.options ?? {},
      resume: session.state.runCount > 0,
      instruction: message.instruction ?? null,
      files: message.files ?? [],
      control,
      approvalProvider: { request: requestApproval },
      renderer: quietRenderer(),
      onEvent: async (event) => {
        progress(event?.type);
        if (event?.type !== "model.streaming") {
          send({ type: "event", event: safeRuntimeEvent(event) });
        }
      },
    });
    await sendFinal({
      type: "result",
      result: {
        message: typeof result?.message === "string" ? result.message : null,
        recoveryRequired: Boolean(result?.recoveryRequired),
        cancelled: Boolean(result?.cancelled),
        error: serializeError(result?.error),
      },
    });
  } catch (error) {
    await sendFinal({ type: "failure", error: serializeError(error) });
  } finally {
    shuttingDown = true;
    clearInterval(heartbeat);
    if (process.connected) process.disconnect();
  }
}

process.on("disconnect", () => {
  clearInterval(heartbeat);
  // Parent unexpectedly disappeared: stop orphaned browser/tool work.
  // Our own graceful disconnect must not turn success into exit code 1.
  if (!shuttingDown) process.exit(1);
});

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "control") {
    control.request(message.reason);
    return;
  }
  if (message.type === "approval.decision") {
    approvals.get(message.requestId)?.(message.approved === true);
    return;
  }
  if (message.type === "approval.stop") {
    const error = new Error("Approval stopped.");
    error.code = message.code === "TASK_CANCELLED" ? "TASK_CANCELLED"
      : message.code === "TASK_PAUSED" ? "TASK_PAUSED" : "WORKER_ERROR";
    approvals.get(message.requestId)?.(false, error);
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  const interval = Math.max(1000, Math.min(60_000, message.heartbeatMs || 5000));
  heartbeat = setInterval(() => send({ type: "heartbeat" }), interval);
  send({ type: "heartbeat" });
  void run(message);
});

// Ready is independent of heartbeats and is emitted only after all IPC
// handlers have been installed. The parent must not send start before this.
send({ type: "ready" });
