
/**
 * FR-03 — Evidence-backed, constrained repair proposals.
 *
 * Preparing a proposal does not execute a tool, authorize approval, release a
 * BLOCKED checkpoint, or count as successful verification.
 */
import { createHash } from "node:crypto";
import { classifyFailure, FAILURE_KIND } from "./failure-classifier.js";

const REPAIRABLE_CODES = new Set([
  "ARTIFACT_MISSING",
  "ARTIFACT_INVALID",
  "ARTIFACT_UNCHANGED",
  "ARTIFACT_MISMATCH",
]);
const TASK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function reject(code) {
  return Object.assign(new Error(code), { code });
}

function context(state, sequence, supervisorTask) {
  if (!state || state.status !== "BLOCKED"
      || !Number.isSafeInteger(sequence) || sequence < 1
      || !Array.isArray(state.tasks)) {
    throw reject("REPAIR_CONTEXT_UNSAFE");
  }

  const blocked = state.tasks.filter((task) => task.status === "BLOCKED");
  if (blocked.length !== 1) throw reject("REPAIR_CONTEXT_UNSAFE");

  const task = blocked[0];
  const failureCode = state.lastError;
  if (!TASK_ID.test(task.id)
      || task.error !== failureCode
      || !REPAIRABLE_CODES.has(failureCode)
      || classifyFailure(failureCode).kind !== FAILURE_KIND.VERIFICATION_FAILURE) {
    throw reject("REPAIR_EVIDENCE_UNSUPPORTED");
  }

  if (!Array.isArray(task.acceptance) || task.acceptance.length < 1
      || task.acceptance.length > 16
      || task.acceptance.some((check) => check.kind !== "file")
      || !Array.isArray(task.baseline)
      || task.baseline.length !== task.acceptance.length
      || task.verificationReceipt != null || task.evidence != null) {
    throw reject("REPAIR_EVIDENCE_UNSUPPORTED");
  }

  const dependencies = task.dependsOn ?? [];
  if (dependencies.some((id) =>
    state.tasks.find((candidate) => candidate.id === id)?.status !== "VERIFIED")) {
    throw reject("REPAIR_DEPENDENCY_UNVERIFIED");
  }

  if (!task.supervisorTaskId || !supervisorTask
      || supervisorTask.status !== "completed"
      || supervisorTask.taskId !== task.supervisorTaskId
      || supervisorTask.workspaceId !== state.workspaceId
      || supervisorTask.workspaceRoot !== state.workspaceRoot
      || supervisorTask.instruction !== task.instruction
      || supervisorTask.idempotencyKey !== task.idempotencyKey) {
    throw reject("REPAIR_SUPERVISOR_NOT_PROVEN_COMPLETE");
  }

  const attempt = state.repairBudget?.attempts?.at(-1);
  if (!attempt || attempt.sequence !== sequence
      || attempt.status !== "RESERVED"
      || attempt.triggerCode !== failureCode) {
    throw reject("REPAIR_ATTEMPT_NOT_RESERVED");
  }

  return { task, failureCode };
}

export function buildRepairSubtask(state, { sequence, supervisorTask }) {
  const { task, failureCode } = context(state, sequence, supervisorTask);
  const acceptance = structuredClone(task.acceptance);
  const baseline = structuredClone(task.baseline);

  const checks = acceptance.map((check, index) => {
    const original = baseline[index];
    if (!original || original.path !== check.path) {
      throw reject("REPAIR_EVIDENCE_UNSUPPORTED");
    }
    return {
      path: check.path,
      minBytes: check.minBytes,
      ...(check.sha256 ? { sha256: check.sha256 } : {}),
      baselineSha256: original.sha256 ?? null,
    };
  });

  const evidence = {
    type: "persisted-artifact-verification-failure",
    failureCode,
    supervisorStatus: "completed",
    originalChecks: checks,
  };
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify(evidence)).digest("hex");

  const checkLines = checks.map((check, i) => {
    const hashRequirement = check.sha256
      ? ", required SHA-256: " + check.sha256 : "";
    return `${i + 1}. ${check.path} (minimum ${check.minBytes} bytes${hashRequirement})`;
  });

  const instruction = [
    `Repair the output of existing task "${task.id}".`,
    `Recorded verification failure: ${failureCode}.`,
    `Original completed Supervisor task: ${task.supervisorTaskId}.`,
    `Recorded verification evidence SHA-256: ${evidenceHash}.`,
    "The original acceptance checks are unchanged:",
    ...checkLines,
    "Limit changes to producing or repairing the listed task outputs.",
    "Do not modify previously VERIFIED tasks or their artifacts.",
    "Do not change acceptance criteria, verification receipts or evidence.",
    "Do not rerun uncertain side effects or bypass human approval.",
    "This instruction is not proof of success: independent verification is mandatory.",
  ].join("\n");

  if (instruction.length > 8192) {
    throw reject("REPAIR_INSTRUCTION_TOO_LARGE");
  }

  return {
    schema: 1,
    status: "PREPARED",
    sourceTaskId: task.id,
    sourceSupervisorTaskId: task.supervisorTaskId,
    attemptSequence: sequence,
    failureCode,
    evidence,
    evidenceHash,
    acceptance,
    instruction,
    idempotencyKey: `autonomy:${state.planId}:repair:${task.id}:${sequence}`,
  };
}

export function assertRepairSubtask(state, proposal, supervisorTask) {
  if (proposal == null) return null;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw reject("REPAIR_SUBTASK_UNSAFE");
  }

  let expected;
  try {
    expected = buildRepairSubtask(state, {
      sequence: proposal.attemptSequence,
      supervisorTask,
    });
  } catch {
    throw reject("REPAIR_SUBTASK_UNSAFE");
  }

  if (JSON.stringify(proposal) !== JSON.stringify(expected)) {
    throw reject("REPAIR_SUBTASK_UNSAFE");
  }
  return proposal;
}
