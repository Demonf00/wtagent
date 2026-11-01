import { createHash } from "node:crypto";

const RECEIPT_SCHEMA = 1;
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: "VERIFIER_EVIDENCE_INVALID" });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function environmentIdentity() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
}

function receiptPayload({ state, task, evidence, verifiedAt }) {
  return {
    schema: RECEIPT_SCHEMA,
    planId: state.planId,
    workspaceId: state.workspaceId,
    workspaceRoot: state.workspaceRoot,
    taskId: task.id,
    supervisorTaskId: task.supervisorTaskId,
    idempotencyKey: task.idempotencyKey,
    taskDefinitionHash: digest({
      id: task.id,
      instruction: task.instruction,
      dependsOn: task.dependsOn,
      acceptance: task.acceptance,
    }),
    baselineHash: digest(task.baseline),
    evidenceHash: digest(evidence),
    environment: environmentIdentity(),
    verifiedAt,
  };
}

/**
 * Non-secret integrity receipt. Detects mismatches and accidental modifications
 * but does not authenticate against a writer who can rewrite the checkpoint.
 */
export function makeVerificationReceipt(state, task, evidence) {
  if (!Array.isArray(evidence) || evidence.length !== task.acceptance.length
    || !Array.isArray(task.baseline)
    || task.baseline.length !== task.acceptance.length
    || !task.supervisorTaskId) {
    throw invalid("Cannot issue receipt without complete verification evidence.");
  }
  const payload = receiptPayload({
    state, task, evidence, verifiedAt: new Date().toISOString(),
  });
  return { ...payload, digest: digest(payload) };
}

export function assertVerificationReceipt(state, task) {
  const receipt = task.verificationReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schema !== RECEIPT_SCHEMA || !SHA256.test(receipt.digest ?? "")
    || !Array.isArray(task.evidence)
    || task.evidence.length !== task.acceptance.length
    || !Array.isArray(task.baseline)
    || task.baseline.length !== task.acceptance.length
    || typeof receipt.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.verifiedAt))
    || !task.supervisorTaskId) {
    throw invalid("Missing, incomplete, or invalid verification receipt.");
  }
  const expected = receiptPayload({
    state, task, evidence: task.evidence, verifiedAt: receipt.verifiedAt,
  });
  if (Object.keys(receipt).length !== Object.keys(expected).length + 1
    || Object.keys(expected).some((key) =>
      JSON.stringify(receipt[key]) !== JSON.stringify(expected[key]))
    || receipt.digest !== digest(expected)) {
    throw invalid("Verification receipt identity or content mismatch.");
  }
  // The environment is deliberately checked against this process. Cross-platform
  // recovery needs fresh verification, rather than trusting an earlier run.
  return true;
}
