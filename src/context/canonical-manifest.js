
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskCoordinator } from "../autonomy/task-coordinator.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_LIKE_ID = /^(?:sk-|ghp_|gho_|github_pat_|AKIA)[a-z0-9_-]+$/i;

export const MAX_CANONICAL_MANIFEST_BYTES = 8192;
export const CANONICAL_MANIFEST_SCHEMA = 1;

function fail(message, code = "CANONICAL_STATE_UNSAFE") {
  return Object.assign(new Error(message), { code });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value) {
  if (typeof value !== "string" || !ID.test(value)
      || SECRET_LIKE_ID.test(value)) {
    throw fail("Canonical task identity is invalid or unsafe.");
  }
  return value;
}

async function gitSource(workspaceRoot) {
  let head;
  let status;
  try {
    const options = {
      cwd: workspaceRoot,
      timeout: 10000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    };
    ({ stdout: head } = await execFileAsync("git", [
      "rev-parse", "--verify", "HEAD",
    ], options));
    ({ stdout: status } = await execFileAsync("git", [
      "status", "--porcelain", "--untracked-files=normal",
    ], options));
  } catch {
    throw fail("Current Git HEAD or worktree status is unavailable.",
      "CANONICAL_SOURCE_UNAVAILABLE");
  }
  const sha = head.trim();
  if (!GIT_SHA.test(sha)) {
    throw fail("Current Git HEAD is not a full commit SHA.",
      "CANONICAL_SOURCE_UNAVAILABLE");
  }
  return { currentHeadSha: sha, clean: status.length === 0 };
}

function projectTasks(state) {
  if (!Array.isArray(state.tasks) || !state.tasks.length) {
    throw fail("Canonical task list is missing.");
  }
  return state.tasks.map(task => {
    const id = safeId(task.id);
    const dependencies = task.dependsOn.map(safeId);
    const receipt = task.verificationReceipt?.digest ?? null;
    if (task.status === "VERIFIED" && !SHA256.test(receipt ?? "")) {
      throw fail("Verified task has no canonical verification receipt.");
    }
    if (receipt !== null && !SHA256.test(receipt)) {
      throw fail("Task contains an invalid verification receipt digest.");
    }
    return {
      id,
      status: task.status,
      dependsOn: dependencies,
      receiptSha256: receipt,
      ...(task.status === "RUNNING" || task.status === "VERIFYING"
        ? { submissionPending: task.supervisorTaskId === null } : {}),
    };
  });
}

function decideNext(state, supervisor) {
  if (state.investigation?.monitor?.budgetExhausted) {
    return { action: "USER_INTERVENTION", reason: "REPLAN_BUDGET_EXHAUSTED" };
  }
  if (state.investigation?.monitor?.replanRequired) {
    const active = state.tasks.find(task => task.id === state.investigation.taskId);
    if (!active?.supervisorTaskId) throw fail("Replanning Worker identity missing.");
    const worker = supervisor.get(active.supervisorTaskId);
    if (!worker || worker.taskId !== active.supervisorTaskId) {
      throw fail("Replanning Worker cannot be verified.");
    }
    return {
      action: worker.status === "paused" ? "REVISE_PLAN" : "PAUSE_WORKER",
      taskId: safeId(active.id),
    };
  }
  if (state.status === "BLOCKED") {
    return { action: "REVIEW_BLOCKER" };
  }
  if (state.repairExecution) {
    return { action: "RECOVER_REPAIR" };
  }
  if (state.repairSubtask) {
    return { action: "RESOLVE_REPAIR" };
  }
  const active = state.tasks.find(task =>
    task.status === "RUNNING" || task.status === "VERIFYING");
  if (active) {
    const taskId = safeId(active.id);
    if (!active.supervisorTaskId) {
      if (active.status !== "RUNNING") {
        throw fail("Verification task is missing its Supervisor identity.");
      }
      return { action: "RECONCILE_SUBMISSION", taskId };
    }
    const worker = supervisor.get(active.supervisorTaskId);
    if (!worker || worker.taskId !== active.supervisorTaskId
        || worker.idempotencyKey !== active.idempotencyKey
        || worker.instruction !== active.instruction
        || worker.workspaceId !== state.workspaceId
        || worker.workspaceRoot !== state.workspaceRoot) {
      throw fail("Supervisor identity mismatches canonical checkpoint.");
    }
    return {
      action: active.status === "VERIFYING" || worker.status === "completed"
        ? "VERIFY_TASK"
        : worker.status === "paused" ? "RESUME_WORKER"
          : "MONITOR_WORKER",
      taskId,
    };
  }
  const ready = state.tasks.find(task =>
    task.status === "TODO" && task.dependsOn.every(dep =>
      state.tasks.some(other => other.id === dep && other.status === "VERIFIED")));
  if (ready) return { action: "START_TASK", taskId: safeId(ready.id) };
  if (state.tasks.every(task => task.status === "VERIFIED")) {
    return { action: state.status === "VERIFIED"
      ? "REPORT_VERIFIED" : "VERIFY_GOAL" };
  }
  throw fail("No canonical runnable or recoverable next action.");
}

/**
 * Creates a bounded, read-only handoff grounded in validated on-disk
 * TaskCoordinator state and the actual current Git HEAD. No user prose,
 * untrusted conversation summaries, original instructions, raw tool logs,
 * filesystem paths, or private artifact content enter the result.
 *
 * This is a consistency snapshot, not a signed attestation. The SHA is the
 * CURRENT Git HEAD, not proof of the commit used by historical verification.
 */
export async function buildCanonicalContextManifest({
  stateFile,
  workspaceRoot,
  workspaceId = "main",
  supervisor,
} = {}) {
  if (typeof stateFile !== "string" || !stateFile
      || typeof workspaceRoot !== "string" || !workspaceRoot
      || !supervisor?.create || !supervisor?.get) {
    throw fail("Canonical checkpoint path, workspace, and Supervisor required.",
      "CANONICAL_STATE_UNAVAILABLE");
  }
  let coordinator;
  try {
    coordinator = await TaskCoordinator.load({
      stateFile, workspaceRoot, workspaceId, supervisor,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw fail("Canonical Coordinator checkpoint does not exist.",
        "CANONICAL_STATE_UNAVAILABLE");
    }
    throw fail("Canonical Coordinator checkpoint cannot be validated.");
  }
  const state = coordinator.getState();
  if (!state.planId || !state.goal || !state.workspaceRoot
      || !Number.isSafeInteger(state.planRevision)
      || state.planRevision < 0) {
    throw fail("Canonical checkpoint identity is incomplete.");
  }
  const source = await gitSource(await fs.realpath(path.resolve(workspaceRoot)));
  const tasks = projectTasks(state);
  const nextAction = decideNext(state, supervisor);
  const hazards = [];
  if (!source.clean) hazards.push("WORKTREE_DIRTY");
  if (state.status === "BLOCKED") hazards.push("TASK_BLOCKED");
  if (state.investigation?.monitor?.replanRequired) {
    hazards.push("REPLAN_PENDING");
  }
  if (state.investigation?.monitor?.budgetExhausted) {
    hazards.push("REPLAN_BUDGET_EXHAUSTED");
  }
  if (state.repairSubtask || state.repairExecution) {
    hazards.push("REPAIR_PENDING");
  }
  if (tasks.some(task => task.submissionPending)) {
    hazards.push("SUBMISSION_RECOVERY");
  }

  const manifest = {
    schema: CANONICAL_MANIFEST_SCHEMA,
    authority: "validated-task-coordinator-checkpoint",
    goalId: digest(state.goal),
    planId: state.planId,
    planRevision: state.planRevision,
    status: state.status,
    source,
    goalDelivery: {
      status: state.goalDelivery?.status ?? "UNVERIFIED",
      receiptSha256: state.goalDelivery?.receipt?.digest ?? null,
    },
    tasks,
    hazards,
    nextAction,
  };
  if (manifest.goalDelivery.receiptSha256 !== null
      && !SHA256.test(manifest.goalDelivery.receiptSha256)) {
    throw fail("Goal delivery receipt has an invalid digest.");
  }
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8")
      > MAX_CANONICAL_MANIFEST_BYTES) {
    throw fail("Canonical context manifest exceeds the bounded handoff limit.",
      "CANONICAL_MANIFEST_TOO_LARGE");
  }
  return manifest;
}
