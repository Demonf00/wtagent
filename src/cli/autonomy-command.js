
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskCoordinator, validateTaskPlan } from "../autonomy/task-coordinator.js";
import { buildDeliveryReport } from "../autonomy/goal-delivery.js";
import { GoalPlanner } from "../autonomy/goal-planner.js";
import { TaskSupervisor } from "../supervisor/task-supervisor.js";
import { resolveRuntimePaths } from "../runtime/conversation-runner.js";
import { isProcessAlive } from "../browser/cdp-state.js";

const WORKSPACE_ID = "main";
const POLL_MS = 150;
const MAX_PLAN_BYTES = 512 * 1024;

function fail(message, code = "AUTONOMY_INVALID") {
  return Object.assign(new Error(message), { code });
}

async function readPlan(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLAN_BYTES) {
    throw fail("The plan must be a regular JSON file no larger than 512 KiB.");
  }
  return validateTaskPlan(JSON.parse(await fs.readFile(file, "utf8")));
}

async function acquireLock(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  let handle;
  try {
    handle = await fs.open(filename, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw fail("Unsafe autonomy lock file.", "AUTONOMY_LOCK_UNSAFE");
    }
    let previous;
    try {
      previous = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch {
      throw fail("Corrupt autonomy lock: manual inspection required.", "AUTONOMY_LOCK_UNCERTAIN");
    }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) {
      throw fail("Invalid autonomy lock owner: manual inspection required.", "AUTONOMY_LOCK_UNCERTAIN");
    }
    if (isProcessAlive(previous.pid)) {
      throw fail(`Autonomy plan is already controlled by PID ${previous.pid}.`, "AUTONOMY_LOCKED");
    }
    throw fail(`Stale autonomy lock for stopped PID ${previous.pid}. Inspect and remove ${filename} before resuming.`, "AUTONOMY_LOCK_STALE");
  } finally {
    await handle?.close();
  }
  return async () => {
    // Never delete a replacement lock from another process.
    const current = await fs.readFile(filename, "utf8").catch(() => null);
    if (current === payload) await fs.rm(filename, { force: true });
  };
}

async function checkpointExists(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw fail(`Unsafe autonomy checkpoint: ${file}`, "AUTONOMY_STATE_UNSAFE");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function denyPendingApproval(supervisor, taskId, output, stage) {
  if (!taskId) return;
  const task = supervisor.get(taskId);
  if (task.status === "waiting_approval" && task.pendingApproval?.requestId) {
    await supervisor.decide(task.taskId, task.pendingApproval.requestId, "deny");
    output(`[Autonomy] Denied unapproved ${stage} tool request.`);
  }
}

/**
 * Explicit, opt-in CLI boundary for structured plans. No model-side permissions
 * are granted here. Regular wtagent conversations remain unchanged.
 */
export async function runAutonomyCommand({
  action, goal = null, planFile = null, stateFile, options = {},
  output = console.log, createSupervisor = (config) => new TaskSupervisor(config),
  timeoutMs = 120000, pollMs = POLL_MS,
}) {
  if (!["goal", "start", "resume", "repair", "status"].includes(action)) throw fail("Invalid autonomy action.");
  if (action === "goal" && (typeof goal !== "string" || !goal.trim()
      || Buffer.byteLength(goal, "utf8") > 8192)) {
    throw fail("goal requires a nonempty instruction no larger than 8 KiB.");
  }
  if (typeof stateFile !== "string" || !stateFile.trim()) {
    throw fail("Explicit --state <path> is required.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw fail("Invalid autonomy execution budget.");
  }

  const file = path.resolve(stateFile);
  const workspaceRoot = await fs.realpath(path.resolve(options.project ?? process.cwd()));
  const stat = await fs.stat(workspaceRoot);
  if (!stat.isDirectory()) throw fail("Workspace must be a directory.");
  if (file === workspaceRoot || file.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw fail("Autonomy state must live outside the workspace.");
  }

  const plannerFile = `${file}.planner.json`;
  if (action === "status") {
    const hasExecution = await checkpointExists(file);
    const target = hasExecution ? file : plannerFile;
    if (!hasExecution && !await checkpointExists(target)) {
      throw fail("No autonomy checkpoint exists.", "AUTONOMY_STATE_NOT_FOUND");
    }
    const state = JSON.parse(await fs.readFile(target, "utf8"));
    if (!(hasExecution ? [1, 2].includes(state.schema) : state.schema === 1)
        || state.workspaceRoot !== workspaceRoot
        || state.workspaceId !== WORKSPACE_ID) {
      throw fail("Autonomy checkpoint workspace mismatch.", "AUTONOMY_STATE_UNSAFE");
    }
    const summary = hasExecution
      ? {
        planId: state.planId, status: state.status, lastError: state.lastError,
        tasks: state.tasks.map((task) => ({
          id: task.id, status: task.status, supervisorTaskId: task.supervisorTaskId,
          error: task.error,
        })),
        delivery: {
          ...buildDeliveryReport(state),
          evidenceFreshness: "checkpoint_snapshot_not_revalidated",
        },
      }
      : {
        planId: state.id, status: state.status, lastError: state.lastError,
        phase: "planner", supervisorTaskId: state.supervisorTaskId,
        tasks: state.plan?.tasks.map((task) => ({ id: task.id, status: "TODO" })) ?? [],
      };
    output(JSON.stringify(summary, null, 2));
    return summary;
  }

  if (action === "start" && !planFile) throw fail("start requires a plan JSON file.");
  const plan = action === "start" ? await readPlan(path.resolve(planFile)) : null;
  const unlock = await acquireLock(`${file}.lock`);
  let supervisor;
  try {
    const paths = resolveRuntimePaths(options);
    supervisor = createSupervisor({
      dataDir: `${file}.supervisor`,
      sessionsDir: paths.sessionsDir,
      workspaces: [{ id: WORKSPACE_ID, root: workspaceRoot }],
      options,
    });
    await supervisor.init();
    const params = { stateFile: file, workspaceRoot, workspaceId: WORKSPACE_ID, supervisor };
    const deadline = Date.now() + timeoutMs;
    const hasExecution = await checkpointExists(file);
    const hasPlanner = await checkpointExists(plannerFile);
    if (action === "goal" && (hasExecution || hasPlanner)) {
      throw fail("This autonomy state already exists. Use resume instead.", "STATE_EXISTS");
    }
    if (action === "start" && hasPlanner) {
      throw fail("The state belongs to an existing goal. Use resume instead.", "STATE_EXISTS");
    }
    if (action === "repair" && !hasExecution) {
      throw fail("Repair requires an existing execution checkpoint.", "AUTONOMY_STATE_NOT_FOUND");
    }
    if (action === "resume" && !hasExecution && !hasPlanner) {
      throw fail("No autonomy checkpoint exists.", "AUTONOMY_STATE_NOT_FOUND");
    }

    let coordinator;
    if (action === "start") {
      coordinator = await TaskCoordinator.create({ ...params, plan });
    } else if ((action === "resume" || action === "repair") && hasExecution) {
      coordinator = await TaskCoordinator.load(params);
      if (action === "repair" && coordinator.getState().repairSubtask === null) {
        await coordinator.prepareRepairSubtask();
      }
    } else {
      const planner = action === "goal"
        ? await GoalPlanner.create({ ...params, goal })
        : await GoalPlanner.load(params);
      output(`[Autonomy] ${action} goal planner=${planner.getState().id}; workspace=${workspaceRoot}`);
      let previousPlannerStatus = "";
      let resumePlannerPaused = action === "resume";
      while (Date.now() < deadline) {
        const planning = await planner.tick({ resumePaused: resumePlannerPaused });
        resumePlannerPaused = false;
        await denyPendingApproval(supervisor, planning.supervisorTaskId, output, "planner");
        if (planning.status !== previousPlannerStatus) {
          output(`[Autonomy] Planner ${planning.status}`);
          previousPlannerStatus = planning.status;
        }
        if (planning.status === "BLOCKED") {
          output(`[Autonomy] Planner blocked (${planning.lastError})`);
          return planning;
        }
        if (planning.status === "PLANNED") break;
        if (supervisor.fatalError) throw supervisor.fatalError;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      const planning = planner.getState();
      if (planning.status !== "PLANNED") {
        output("[Autonomy] Planning budget reached; planner checkpoint retained.");
        return planning;
      }
      // The planner checkpoint is durable BEFORE the execution checkpoint is
      // created. If we crash here, resume reads this exact plan and never
      // submits the same goal for another model turn.
      coordinator = await checkpointExists(file)
        ? await TaskCoordinator.load(params)
        : await TaskCoordinator.create({ ...params, plan: planning.plan });
    }
    output(`[Autonomy] ${action} plan=${coordinator.getState().planId}; workspace=${workspaceRoot}`);

    let previous = "";
    // Only an explicit resume of an existing execution checkpoint grants a
    // one-time paused-task resumption. Never repeatedly resume on polling.
    let resumeExistingPaused = action === "resume" && hasExecution;
    while (Date.now() < deadline) {
      const before = coordinator.getState();
      const continueRepair = before.repairExecution !== null
        || (action === "repair" && before.repairSubtask !== null);
      const state = continueRepair
        ? await coordinator.repairTick()
        : await coordinator.tick({ resumePaused: resumeExistingPaused });
      resumeExistingPaused = false;
      const active = state.tasks.find((task) =>
        task.status === "RUNNING" || task.status === "VERIFYING");
      await denyPendingApproval(supervisor, active?.supervisorTaskId, output, "executor");
      await denyPendingApproval(supervisor, state.repairExecution?.supervisorTaskId, output, "repair");
      const progress = `${state.status}:${state.tasks.map((task) => task.status).join(",")}:${state.repairExecution?.phase ?? "none"}`;
      if (progress !== previous) {
        output(`[Autonomy] ${progress}`);
        previous = progress;
      }
      if (state.investigation?.monitor.replanRequired
          || state.investigation?.monitor.budgetExhausted) {
        output(state.investigation.monitor.budgetExhausted
          ? "[Autonomy] Investigation replan budget exhausted; Worker pause requested. Intervention required."
          : "[Autonomy] Investigation stalled; Worker pause requested. A revised DAG is required before continuing.");
        return state;
      }
      if (state.status === "VERIFIED" || (state.status === "BLOCKED" && !state.repairExecution)) {
        output(`[Autonomy] ${state.status}${state.lastError ? ` (${state.lastError})` : ""}`);
        const report = coordinator.getDeliveryReport();
        output(`[Autonomy] Goal Delivery: ${report.status}; final checks ${report.evidencedFinalChecks}/${report.requiredFinalChecks}${report.reason ? ` (${report.reason})` : ""}`);
        return state;
      }
      if (supervisor.fatalError) throw supervisor.fatalError;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    output("[Autonomy] Time budget reached. Current checkpoint retained; no success claimed.");
    return coordinator.getState();
  } finally {
    try {
      await supervisor?.close();
    } finally {
      await unlock();
    }
  }
}
