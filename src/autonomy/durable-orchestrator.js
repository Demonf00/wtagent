import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const SCHEMA = 1;
const STOPPED = new Set(["COMPLETE", "BLOCKED", "PAUSED", "UNCERTAIN"]);
const VALID = new Set(["READY", "RUNNING", "WAITING", ...STOPPED]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw failure("ORCHESTRATOR_OPTIONS_INVALID", "Invalid " + name);
  }
}

async function regularJson(file, optional = false) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw failure("ORCHESTRATOR_STATE_UNSAFE", "Unsafe orchestration checkpoint.");
  }
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw failure("ORCHESTRATOR_STATE_UNSAFE", "Invalid orchestration checkpoint."); }
  return value;
}

async function persist(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state) + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

function live(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}

async function acquire(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const claim = JSON.stringify({ schema: SCHEMA, pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(claim); await handle.sync(); }
      finally { await handle.close(); }
      return async () => {
        const current = await regularJson(file, true);
        if (current?.token === token && current.pid === process.pid) {
          await fs.rm(file, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await regularJson(file);
      if (previous.schema !== SCHEMA || typeof previous.token !== "string"
        || !/^[a-f0-9-]{36}$/.test(previous.token)) {
        throw failure("ORCHESTRATOR_OWNER_UNCERTAIN", "Invalid previous owner.");
      }
      const isAlive = live(previous.pid);
      if (isAlive !== false) {
        throw failure("ORCHESTRATOR_ALREADY_OWNED",
          "Another owner may be executing this goal.");
      }
      // Re-read before removal. Never steal a live, ambiguous, or changed owner.
      const again = await regularJson(file);
      if (JSON.stringify(previous) !== JSON.stringify(again)) {
        throw failure("ORCHESTRATOR_OWNER_UNCERTAIN", "Owner changed during recovery.");
      }
      await fs.rm(file);
    }
  }
  throw failure("ORCHESTRATOR_ALREADY_OWNED", "Could not acquire goal ownership.");
}

function validateState(value, workspaceRoot, stateFile) {
  if (!value || value.schema !== SCHEMA || !VALID.has(value.status)
    || !/^[a-f0-9-]{36}$/.test(value.id ?? "")
    || value.workspaceRoot !== workspaceRoot
    || value.stateFile !== stateFile
    || !["goal", "start"].includes(value.initialAction)
    || typeof value.started !== "boolean"
    || typeof value.inFlight !== "boolean"
    || !Number.isSafeInteger(value.cycles) || value.cycles < 0
    || !(value.nextRunAt === null || Number.isSafeInteger(value.nextRunAt))
    || !(value.goal === null || typeof value.goal === "string")
    || !(value.planFile === null || typeof value.planFile === "string")) {
    throw failure("ORCHESTRATOR_STATE_UNSAFE", "Orchestration identity is invalid.");
  }
  return value;
}

export async function readDurableOrchestratorState({ stateFile, workspaceRoot }) {
  const file = path.resolve(stateFile) + ".orchestrator.json";
  const state = await regularJson(file);
  return structuredClone(validateState(state,
    await fs.realpath(path.resolve(workspaceRoot)), path.resolve(stateFile)));
}

/**
 * One exclusive owner runs a bounded sequence of existing autonomy CLI
 * slices. The Planner/Coordinator/Supervisor own task and tool idempotency;
 * this module never re-submits their original instructions on recovery.
 * No future/background work is promised after this invocation exits.
 */
export async function runDurableOrchestrator({
  stateFile, workspaceRoot, goal = null, planFile = null,
  runSlice, maxCycles = 8, sliceMs = 15000,
  cooldownMs = 1000, maxRunMs = 120000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onState = () => {},
} = {}) {
  if (typeof stateFile !== "string" || !stateFile.trim()
    || typeof workspaceRoot !== "string" || !workspaceRoot.trim()
    || typeof runSlice !== "function") {
    throw failure("ORCHESTRATOR_OPTIONS_INVALID", "Checkpoint, workspace and executor required.");
  }
  integer(maxCycles, 1, 100, "maxCycles");
  integer(sliceMs, 10, 300000, "sliceMs");
  integer(cooldownMs, 100, 3600000, "cooldownMs");
  integer(maxRunMs, 10, 3600000, "maxRunMs");
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const checkpoint = path.resolve(stateFile);
  // Match the underlying Autonomy CLI's workspace isolation rule before
  // creating any lock or orchestration checkpoint.
  if (checkpoint === root || checkpoint.startsWith(root + path.sep)) {
    throw failure("ORCHESTRATOR_OPTIONS_INVALID",
      "Orchestrator checkpoint must be outside the workspace.");
  }
  const file = checkpoint + ".orchestrator.json";
  // Prevent two separately checkpointed goals from mutating one workspace
  // simultaneously. A workspace-wide lock is intentionally more conservative
  // than one keyed to an individual goal's name.
  const rootKey = createHash("sha256").update(root).digest("hex");
  const workspaceLock = path.join(path.dirname(root),
    ".wtagent-orchestrator-" + rootKey + ".lock");
  const releaseWorkspace = await acquire(workspaceLock);
  let releaseCheckpoint;
  try {
    releaseCheckpoint = await acquire(checkpoint + ".orchestrator.lock");
    let state = await regularJson(file, true);
    if (state) {
      validateState(state, root, checkpoint);
      if (goal !== null && goal !== state.goal
        || planFile !== null && path.resolve(planFile) !== state.planFile) {
        throw failure("ORCHESTRATOR_STATE_UNSAFE", "Goal identity changed on resume.");
      }
    } else {
      if (Boolean(goal) === Boolean(planFile)) {
        throw failure("ORCHESTRATOR_OPTIONS_INVALID",
          "A new goal requires exactly one of goal or planFile.");
      }
      if (goal !== null && (typeof goal !== "string" || !goal.trim()
        || Buffer.byteLength(goal, "utf8") > 8192)) {
        throw failure("ORCHESTRATOR_OPTIONS_INVALID", "Invalid goal.");
      }
      state = {
        schema: SCHEMA, id: randomUUID(), workspaceRoot: root,
        stateFile: checkpoint, initialAction: goal ? "goal" : "start",
        goal, planFile: planFile === null ? null : path.resolve(planFile),
        status: "READY", started: false, inFlight: false,
        cycles: 0, nextRunAt: null, lastStage: "NEW", lastError: null,
      };
      await persist(file, state);
    }

    if (STOPPED.has(state.status)) return structuredClone(state);
    if (state.inFlight) {
      // A crash may occur after a Supervisor submit but before the scheduler
      // recorded its result. Only the existing durable execution or planner
      // checkpoint makes a bare resume permissible.
      const execution = await regularJson(checkpoint, true);
      const planning = await regularJson(checkpoint + ".planner.json", true);
      if (!execution && !planning) {
        state = { ...state, status: "UNCERTAIN", lastError: "MISSING_RECOVERY_CHECKPOINT",
          nextRunAt: null };
        await persist(file, state);
        return structuredClone(state);
      }
      state.started = true;
      state.inFlight = false;
      state.status = "READY";
      await persist(file, state);
    }

    const until = now() + maxRunMs;
    let used = 0;
    while (used < maxCycles && now() < until) {
      if (STOPPED.has(state.status)) break;
      // Timer wake-ups can occur a millisecond early. Keep sleeping until
      // the due timestamp, without submitting another Worker or busy-spinning.
      while (state.nextRunAt !== null && now() < state.nextRunAt
        && now() < until) {
        const remaining = Math.min(state.nextRunAt - now(), until - now());
        if (remaining <= 0) break;
        await sleep(Math.max(1, remaining));
      }
      if (now() >= until) break;
      const action = state.started ? "resume" : state.initialAction;
      state = { ...state, status: "RUNNING", inFlight: true,
        nextRunAt: null, lastError: null };
      await persist(file, state);
      onState(structuredClone(state));
      let result;
      try {
        result = await runSlice({
          action, stateFile: checkpoint, workspaceRoot: root,
          goal: action === "goal" ? state.goal : null,
          planFile: action === "start" ? state.planFile : null,
          timeoutMs: Math.max(10, Math.min(sliceMs, until - now())),
        });
      } catch (error) {
        // Outcome may be unknown even if a tool was already invoked.
        state = { ...state, status: "UNCERTAIN",
          lastError: typeof error?.code === "string" ? error.code : "SLICE_OUTCOME_UNKNOWN",
          nextRunAt: null };
        await persist(file, state);
        return structuredClone(state);
      }
      const status = result?.status;
      if (typeof status !== "string") {
        state = { ...state, status: "UNCERTAIN", lastError: "INVALID_SLICE_RESULT",
          nextRunAt: null };
      } else {
        // A sliced CLI execution shuts down its Supervisor before returning;
        // the Coordinator and Planner checkpoint, not an assumed Supervisor
        // file path, is the durable source of execution identity.
        const taskStatuses = Array.isArray(result.tasks)
          ? result.tasks.map(task => task?.status) : [];
        // A resumed Coordinator can return RUNNING while the underlying
        // Worker has been explicitly paused. Never re-issue automatic resume
        // calls for terminal, paused, or approval-gated states.
        const mustPause = status === "PAUSED"
          || taskStatuses.some(value => ["PAUSED", "WAITING_APPROVAL"].includes(value))
          || Boolean(result.investigation?.monitor?.replanRequired)
          || Boolean(result.investigation?.monitor?.budgetExhausted);
        const nextStatus = status === "VERIFIED" ? "COMPLETE"
          : status === "BLOCKED" ? "BLOCKED"
            : mustPause ? "PAUSED"
              : ["PLANNING", "PLANNED", "RUNNING", "VERIFYING"].includes(status)
                ? "WAITING" : "UNCERTAIN";
        state = { ...state, status: nextStatus,
          lastStage: status, lastError: nextStatus === "UNCERTAIN" ? "INVALID_SLICE_STATUS" : null,
          nextRunAt: nextStatus === "WAITING" ? now() + cooldownMs : null };
      }
      state.started = true;
      state.inFlight = false;
      state.cycles++;
      await persist(file, state);
      onState(structuredClone(state));
      used++;
    }
    return structuredClone(state);
  } finally {
    try { await releaseCheckpoint?.(); }
    finally { await releaseWorkspace(); }
  }
}
