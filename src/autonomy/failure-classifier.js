/**
 * Durable diagnostic taxonomy for autonomy failures.
 * Classification never authorizes retries. Only a separate, bounded policy
 * may consider a RETRYABLE code, and legacy BLOCKED work stays blocked.
 * No raw exception messages, paths, credentials, or stack traces are saved.
 */
export const FAILURE_KIND = Object.freeze({
  RETRYABLE: "RETRYABLE",
  VERIFICATION_FAILURE: "VERIFICATION_FAILURE",
  EXTERNAL_BLOCKER: "EXTERNAL_BLOCKER",
  UNCERTAIN_SIDE_EFFECT: "UNCERTAIN_SIDE_EFFECT",
  PERMANENT_FAILURE: "PERMANENT_FAILURE",
});

const CODES = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNCERTAIN = new Set([
  "OUTBOUND_COMMIT_UNCERTAIN",
  "ASSISTANT_COMMIT_UNCERTAIN",
  "TOOL_EXECUTION_UNCERTAIN",
  "SIDE_EFFECT_COMPLETION_UNKNOWN",
  "WORKER_COMMIT_UNCERTAIN",
  "VERIFIER_COMPLETION_UNKNOWN",
  "SUPERVISOR_BLOCKED_UNCERTAIN",
  "SUPERVISOR_INTERRUPTED",
  "SUPERVISOR_NOT_COMPLETED",
  "ASSISTANT_HANDOFF_MISSING",
]);
const EXTERNAL = new Set([
  "SUPERVISOR_PAUSED",
  "BROWSER_ACCESS_CHALLENGE",
  "AUTHENTICATION_REQUIRED",
  "USER_ACTION_REQUIRED",
  "HUMAN_APPROVAL_REQUIRED",
  "CAPTCHA_REQUIRED",
  "RATE_LIMITED",
]);
const PROVEN_RETRYABLE = new Set([
  "PROVEN_NOT_SUBMITTED",
  "OUTBOUND_NOT_SUBMITTED",
  "WORKER_PRESTART_FAILURE",
  "SUPERVISOR_WAITING_RETRY",
]);
const UNSAFE = new Set([
  "VERIFIER_UNSAFE",
  "VERIFIER_INPUT_UNSAFE",
  "STATE_UNSAFE",
  "SUPERVISOR_IDENTITY_MISMATCH",
]);

export function classifyFailure(value) {
  const raw = typeof value === "string" ? value
    : value && typeof value === "object" ? value.code : null;
  const code = typeof raw === "string" && CODES.test(raw)
    ? raw : "UNCLASSIFIED_FAILURE";
  let kind = FAILURE_KIND.PERMANENT_FAILURE;
  if (UNCERTAIN.has(code)) {
    kind = FAILURE_KIND.UNCERTAIN_SIDE_EFFECT;
  } else if (EXTERNAL.has(code)) {
    kind = FAILURE_KIND.EXTERNAL_BLOCKER;
  } else if (PROVEN_RETRYABLE.has(code)) {
    kind = FAILURE_KIND.RETRYABLE;
  } else if (!UNSAFE.has(code)
      && /^(?:ARTIFACT_|VERIFIER_|VERIFICATION_|GOAL_|TEST_|INTEGRATION_|HTTP_CHECK_|RECEIPT_)/.test(code)) {
    kind = FAILURE_KIND.VERIFICATION_FAILURE;
  }
  return { kind, code };
}

/**
 * Recompute all metadata from authoritative legacy status/error fields.
 * A forged or stale classifier field can never turn a BLOCKED checkpoint
 * into executable or retryable work.
 */
export function annotateCheckpointFailures(state) {
  if (!state || typeof state !== "object") {
    throw new TypeError("A coordinator checkpoint is required.");
  }
  state.failure = state.status === "BLOCKED"
    ? classifyFailure(state.lastError) : null;
  for (const task of state.tasks ?? []) {
    task.failure = task.status === "BLOCKED"
      ? classifyFailure(task.error) : null;
  }
  if (state.goalDelivery) {
    const delivery = state.goalDelivery;
    delivery.failure = delivery.status === "BLOCKED"
      ? classifyFailure(delivery.error) : null;
  }
  return state;
}
