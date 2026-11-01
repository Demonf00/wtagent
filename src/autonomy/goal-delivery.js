import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = 1;

function invalid(message) {
  return Object.assign(new Error(message), { code: "GOAL_EVIDENCE_INVALID" });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function environment() {
  return { platform: process.platform, arch: process.arch, node: process.version };
}

function payload(state, verifiedAt) {
  return {
    schema: VERSION,
    planId: state.planId,
    workspaceId: state.workspaceId,
    workspaceRoot: state.workspaceRoot,
    goalHash: digest(state.goal),
    taskReceiptsHash: digest(state.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      receipt: task.verificationReceipt?.digest ?? null,
    }))),
    acceptanceHash: digest(state.goalDelivery.acceptance),
    evidenceHash: digest(state.goalDelivery.evidence),
    environment: environment(),
    verifiedAt,
  };
}

/**
 * A non-secret consistency receipt, NOT a cryptographic signature.
 * Every required task and final functional check must be evidenced first.
 */
export function makeGoalReceipt(state) {
  const delivery = state.goalDelivery;
  if (!delivery || !Array.isArray(delivery.acceptance)
    || !delivery.acceptance.length
    || !Array.isArray(delivery.evidence)
    || delivery.evidence.length !== delivery.acceptance.length
    || !state.tasks.every((task) => task.status === "VERIFIED"
      && task.verificationReceipt?.digest)) {
    throw invalid("Goal delivery requires all task receipts and final evidence.");
  }
  const data = payload(state, new Date().toISOString());
  return { ...data, digest: digest(data) };
}

export function assertGoalReceipt(state) {
  const delivery = state.goalDelivery;
  const receipt = delivery?.receipt;
  if (!delivery || delivery.status !== "DELIVERED"
    || !receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schema !== VERSION || !SHA256.test(receipt.digest ?? "")
    || !Array.isArray(delivery.evidence)
    || delivery.evidence.length !== delivery.acceptance.length
    || typeof receipt.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.verifiedAt))
    || !state.tasks.every((task) => task.status === "VERIFIED")) {
    throw invalid("Goal-delivery receipt is absent or incomplete.");
  }
  const expected = payload(state, receipt.verifiedAt);
  if (Object.keys(receipt).length !== Object.keys(expected).length + 1
    || Object.keys(expected).some((key) =>
      JSON.stringify(receipt[key]) !== JSON.stringify(expected[key]))
    || receipt.digest !== digest(expected)) {
    throw invalid("Goal-delivery receipt does not match verified evidence.");
  }
  return true;
}

export function buildDeliveryReport(state) {
  const delivery = state.goalDelivery;
  const tasks = state.tasks.map((task) => ({
    id: task.id,
    status: task.status,
    artifactVerified: task.status === "VERIFIED"
      && task.acceptance.some((check) => check.kind === "file"),
    taskVerified: task.status === "VERIFIED",
    requiredChecks: task.acceptance.length,
    evidencedChecks: task.status === "VERIFIED" ? (task.evidence?.length ?? 0) : 0,
  }));
  const delivered = state.status === "VERIFIED" && delivery?.status === "DELIVERED";
  const requiredFinalChecks = delivery?.acceptance?.length ?? 0;
  const evidencedFinalChecks = delivered ? (delivery?.evidence?.length ?? 0) : 0;
  return {
    goal: state.goal,
    status: delivered ? "DELIVERED" : state.status === "BLOCKED" ? "BLOCKED"
      : requiredFinalChecks === 0 ? "UNVERIFIED" : "PENDING",
    tasks,
    requiredFinalChecks,
    evidencedFinalChecks,
    verifiedCapabilities: delivered
      ? delivery.acceptance.map((check, index) => ({
        index, kind: check.kind, evidence: true,
      })) : [],
    unverifiedCapabilities: delivered ? [] : requiredFinalChecks === 0
      ? ["No independent final functional acceptance was supplied."]
      : delivery.acceptance.map((check, index) => ({
        index, kind: check.kind, reason: state.lastError ?? "Final acceptance incomplete",
      })),
    reason: delivered ? null : state.lastError ??
      (requiredFinalChecks ? "GOAL_NOT_YET_VERIFIED" : "GOAL_ACCEPTANCE_NOT_DECLARED"),
  };
}
