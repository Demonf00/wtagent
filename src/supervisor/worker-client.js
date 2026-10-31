import { fork } from "node:child_process";
import { TaskStoppedError } from "./task-control.js";
import { safeRuntimeEvent } from "./recovery-controller.js";

function workerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Run exactly one task in a disposable Node process. The parent owns durable
 * task state and approvals. The worker owns the browser/runtime lifecycle.
 *
 * We do not resolve before the child has exited: a hung or orphaned worker
 * must never overlap a replacement process using the same browser profile.
 */
export async function runWorkerProcess({
  sessionsDir,
  sessionId,
  workspaceRoot,
  options = {},
  settings,
  control,
  approvalProvider,
  onEvent,
  isWaitingApproval = () => false,
  onStart = () => {},
  forkProcess = fork,
}) {
  control.checkpoint();
  const child = forkProcess(new URL("./worker-main.js", import.meta.url), [], {
    cwd: workspaceRoot,
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  onStart(child.pid);
  let result;
  let failure;
  let exited = false;
  let started = false;
  let lastHeartbeat = Date.now();
  let lastProgress = Date.now();
  let invalidActions = 0;
  let stopRequestedAt = null;
  let processing = Promise.resolve();

  const send = (message) => {
    if (!child.connected) return false;
    try {
      child.send(message, (error) => {
        if (error && !failure) failure = workerError("WORKER_IPC_FAILED");
      });
      return true;
    } catch {
      if (!failure) failure = workerError("WORKER_IPC_FAILED");
      return false;
    }
  };
  const kill = (code) => {
    if (exited) return;
    if (!failure) failure = workerError(code);
    // An earlier IPC/worker error must not disable the watchdog: a child
    // which reported failure can still hang instead of exiting.
    try { child.kill("SIGKILL"); } catch { /* exit/error handler settles */ }
  };
  const stopListener = control.onStop((error) => {
    stopRequestedAt ??= Date.now();
    send({ type: "control", reason: error.code === "TASK_CANCELLED" ? "cancel" : "pause" });
  });
  const heartbeatLimit = Math.max(15_000, settings.heartbeatMs * 4);
  const watchdog = setInterval(() => {
    if (exited) return;
    const time = Date.now();
    if (stopRequestedAt && time - stopRequestedAt > 10_000) {
      // The control signal is cooperative, but Pause/Cancel cannot wait
      // indefinitely for a browser call which never returns.
      kill("WORKER_STOP_TIMEOUT");
    } else if (time - lastHeartbeat > heartbeatLimit) {
      kill("WORKER_HEARTBEAT_TIMEOUT");
    } else if (!isWaitingApproval() && time - lastProgress > settings.progressTimeoutMs) {
      kill("WORKER_PROGRESS_TIMEOUT");
    }
  }, Math.min(1000, settings.heartbeatMs));
  watchdog.unref?.();

  const exitOutcome = new Promise((resolve) => {
    child.once("error", () => {
      if (!failure) failure = workerError("WORKER_SPAWN_FAILED");
      exited = true;
      resolve();
    });
    child.once("exit", (code, signal) => {
      exited = true;
      if (!result && !failure) {
        failure = workerError(code === 0 ? "WORKER_RESULT_MISSING" : "WORKER_EXITED");
      }
      resolve();
    });
  });

  child.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "heartbeat") {
      lastHeartbeat = Date.now();
      return;
    }
    if (message.type === "progress") {
      lastProgress = Date.now();
      return;
    }
    if (message.type === "failure") {
      const code = typeof message.code === "string" && SAFE_CODE.test(message.code)
        ? message.code : "WORKER_ERROR";
      failure = workerError(code);
      return;
    }
    if (message.type === "result") {
      result = message.result;
      return;
    }
    // Preserve message ordering so durable event/approval updates are
    // completed before the result is observed by the Supervisor.
    processing = processing.then(async () => {
      if (message.type === "event") {
        const event = safeRuntimeEvent(message.event);
        if (event.type === "tool.invalid") invalidActions++;
        else if (event.type === "model.message_complete") invalidActions = 0;
        if (invalidActions >= 12) {
          kill("WORKER_UNPRODUCTIVE_LOOP");
          return;
        }
        await onEvent?.(event);
      } else if (message.type === "approval.required") {
        lastProgress = Date.now();
        // Register the pending approval synchronously, but do NOT await a
        // human decision in the IPC event queue. On worker exit we must be
        // able to drain all queued events before aborting any approval.
        void approvalProvider.request({
          toolCall: message.toolCall,
          reasons: message.reasons,
        }).then((approved) => {
          send({
            type: "approval.decision",
            requestId: message.requestId,
            approved,
          });
        }).catch((error) => {
          send({
            type: "approval.stop", requestId: message.requestId,
            code: error?.code === "TASK_CANCELLED" ? "TASK_CANCELLED" : "TASK_PAUSED",
          });
        }).finally(() => {
          lastProgress = Date.now();
        });
      }
    }).catch(() => kill("WORKER_EVENT_PERSISTENCE_FAILED"));
  });

  try {
    if (control.reason) {
      kill(control.reason === "cancel" ? "TASK_CANCELLED" : "TASK_PAUSED");
    } else {
      started = send({
        type: "start",
        sessionsDir, sessionId, workspaceRoot, options,
        heartbeatMs: settings.heartbeatMs,
      });
      if (!started) kill("WORKER_IPC_FAILED");
    }
    await exitOutcome;
    // All arrived approval.required messages must first be registered.
    // The IPC queue no longer awaits the human decision, so this is bounded.
    await processing;
    approvalProvider.abort(failure ?? workerError("WORKER_EXITED"));
    // Explicit user stop takes precedence over transient worker failures.
    // The browser/session checkpoint is left intact for safe later recovery.
    control.checkpoint();
    if (failure) throw failure;
    if (!result || typeof result !== "object") throw workerError("WORKER_RESULT_MISSING");
    return result;
  } finally {
    clearInterval(watchdog);
    stopListener();
    if (!exited) {
      approvalProvider.abort(workerError("WORKER_EXITED"));
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      // Never start another worker while this process may still be alive.
      await exitOutcome;
    }
  }
}
