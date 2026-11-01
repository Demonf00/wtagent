import path from "node:path";
import { AgentSession } from "../session/agent-session.js";
import { TaskCoordinator } from "../autonomy/task-coordinator.js";
import { buildCanonicalContextManifest } from "./canonical-manifest.js";

const ADVANCE = new Set(["START_TASK", "VERIFY_TASK", "MONITOR_WORKER"]);
const HASH = /^[a-f0-9]{64}$/;

function fail(message, code = "CONTEXT_PLAN_RESUME_UNSAFE") {
  return Object.assign(new Error(message), { code });
}

function assertPreviousManifest(previous, current) {
  if (previous == null) return;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)
    || previous.schema !== current.schema
    || previous.authority !== current.authority
    || previous.planId !== current.planId
    || previous.goalId !== current.goalId
    || previous.planRevision !== current.planRevision
    || !Array.isArray(previous.tasks)
    || previous.tasks.length !== current.tasks.length) {
    throw fail("Previous canonical plan identity does not match the current authoritative checkpoint.");
  }
  for (let index = 0; index < current.tasks.length; index++) {
    const earlier = previous.tasks[index];
    const now = current.tasks[index];
    if (!earlier || earlier.id !== now.id
      || !Array.isArray(earlier.dependsOn)
      || JSON.stringify(earlier.dependsOn) !== JSON.stringify(now.dependsOn)) {
      throw fail("Canonical task identity or dependencies changed during handoff.");
    }
    if (earlier.status === "VERIFIED" && (
      now.status !== "VERIFIED"
      || !HASH.test(earlier.receiptSha256 ?? "")
      || earlier.receiptSha256 !== now.receiptSha256
    )) {
      throw fail("Previously verified task cannot be reopened or lose its verification receipt.");
    }
  }
}

/**
 * Load the actual checkpoint and return an explicit safe next-step decision.
 * Historical conversation summaries and caller-provided manifests are never
 * execution authority: the manifest is rebuilt from on-disk Coordinator data.
 */
export async function inspectPlannedWorkResumption({
  session, sessionsDir, stateFile, workspaceRoot,
  workspaceId = "main", supervisor, previousManifest = null,
} = {}) {
  if (!session || typeof sessionsDir !== "string" || !sessionsDir
    || !stateFile || !workspaceRoot || !supervisor) {
    throw fail("Session, checkpoint, workspace and Supervisor are required.");
  }
  if (path.resolve(path.dirname(session.directory)) !== path.resolve(sessionsDir)) {
    throw fail("Session is outside its declared session store.");
  }
  const currentSession = await AgentSession.load({
    sessionsDir, sessionId: session.sessionId,
  });
  const parentId = currentSession.state.previousContextSessionId;
  if (typeof parentId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(parentId)
    || parentId === currentSession.sessionId) {
    throw fail("A valid previous conversation identity is required.");
  }
  const parent = await AgentSession.load({
    sessionsDir, sessionId: parentId,
  });
  if (path.resolve(parent.state.projectRoot) !== path.resolve(workspaceRoot)
    || path.resolve(currentSession.state.projectRoot) !== path.resolve(workspaceRoot)) {
    throw fail("Workspace does not match the previous and current Sessions.");
  }
  const rotation = parent.state.automaticContextRotation;
  if (rotation && (rotation.schema !== 1 || rotation.status !== "ROTATED"
    || rotation.nextSessionId !== currentSession.sessionId)) {
    throw fail("Automatic rotation checkpoint does not authorize this new Session.");
  }
  const params = { stateFile, workspaceRoot, workspaceId, supervisor };
  const manifest = await buildCanonicalContextManifest(params);
  assertPreviousManifest(previousManifest, manifest);
  const coordinator = await TaskCoordinator.load(params);
  const state = coordinator.getState();
  const action = manifest.nextAction.action;
  const taskId = manifest.nextAction.taskId ?? null;
  const task = taskId ? state.tasks.find(item => item.id === taskId) : null;
  if (taskId && !task) {
    throw fail("Manifest selected a task absent from the authoritative checkpoint.");
  }
  // A running/finished Worker legitimately modifies its workspace before
  // artifacts are verified and committed. Monitoring that SAME validated Worker
  // or completing its verification must not be mistaken for starting new work.
  // A fresh START_TASK still requires a clean worktree. Every other hazard
  // remains blocking, including uncertain submission and repair state.
  const hazards = manifest.hazards.filter(hazard =>
    !(hazard === "WORKTREE_DIRTY"
      && (action === "MONITOR_WORKER" || action === "VERIFY_TASK")));
  if (hazards.length) {
    return {
      status: "BLOCKED", action, taskId,
      reasons: hazards, manifest,
    };
  }
  if (action === "REPORT_VERIFIED") {
    // A VERIFIED Coordinator receipt does not prove that the working tree is
    // clean. Require hazards to settle before claiming the resumed goal done.
    return { status: "COMPLETE", action, taskId: null, manifest };
  }
  if (!ADVANCE.has(action)) {
    return {
      status: "BLOCKED", action, taskId,
      reasons: ["UNSAFE_RECOVERY_ACTION"], manifest,
    };
  }
  if (action === "START_TASK") {
    if (!task || task.status !== "TODO" || task.supervisorTaskId != null
      || !task.dependsOn.every(dep => state.tasks.some(item =>
        item.id === dep && item.status === "VERIFIED"))) {
      throw fail("Only a dependency-ready, never-submitted task may be started.");
    }
  } else {
    if (!task || !["RUNNING", "VERIFYING"].includes(task.status)
      || !task.supervisorTaskId) {
      throw fail("Existing task cannot be recovered without its original Worker.");
    }
    if (task.verificationStarted) {
      return {
        status: "BLOCKED", action, taskId,
        reasons: ["VERIFIER_COMPLETION_UNKNOWN"], manifest,
      };
    }
    const worker = supervisor.get(task.supervisorTaskId);
    if (!worker || !["queued", "running", "waiting_retry",
      "waiting_approval", "pausing", "cancelling", "completed"].includes(worker.status)) {
      return {
        status: "BLOCKED", action, taskId,
        reasons: ["WORKER_COMPLETION_UNCERTAIN"], manifest,
      };
    }
  }
  return { status: "READY", action, taskId, manifest };
}

/**
 * Advance at most one Coordinator step. The coordinator and Supervisor own
 * idempotent submission, evidence verification, and checkpoint persistence.
 * Never replay a user instruction or browser/tool payload from a handoff.
 */
export async function resumePlannedWorkStep(args) {
  const decision = await inspectPlannedWorkResumption(args);
  if (decision.status !== "READY") return decision;
  const params = {
    stateFile: args.stateFile,
    workspaceRoot: args.workspaceRoot,
    workspaceId: args.workspaceId ?? "main",
    supervisor: args.supervisor,
  };
  const before = await buildCanonicalContextManifest(params);
  if (JSON.stringify(before) !== JSON.stringify(decision.manifest)) {
    throw fail("Canonical plan changed before task continuation.");
  }
  const coordinator = await TaskCoordinator.load(params);
  const current = coordinator.getState();
  if (current.planId !== before.planId
    || current.planRevision !== before.planRevision) {
    throw fail("Coordinator changed before task continuation.");
  }
  await coordinator.tick({ resumePaused: false });
  const after = await buildCanonicalContextManifest(params);
  assertPreviousManifest(decision.manifest, after);
  return {
    status: "ADVANCED", action: decision.action, taskId: decision.taskId,
    manifest: after,
  };
}
