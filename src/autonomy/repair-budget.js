/**
 * FR-02: durable, bounded repair-attempt accounting.
 *
 * Reserving a budget does not execute a tool, authorize a retry, elevate
 * permissions, or release a BLOCKED task. A reserved attempt without a
 * recorded outcome is permanently unsafe to repeat automatically.
 */
import { classifyFailure, FAILURE_KIND } from "./failure-classifier.js";

export const REPAIR_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxIdenticalFailures: 2,
});

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ALLOWED = new Set([
  FAILURE_KIND.RETRYABLE,
  FAILURE_KIND.VERIFICATION_FAILURE,
]);

function reject(code) {
  return Object.assign(new Error(code), { code });
}

function codeOf(value) {
  if (typeof value !== "string" || !CODE.test(value)) {
    throw reject("REPAIR_INVALID_DIAGNOSTIC");
  }
  return value;
}

export function emptyRepairBudget() {
  return {
    schema: 1,
    maxAttempts: REPAIR_LIMITS.maxAttempts,
    maxIdenticalFailures: REPAIR_LIMITS.maxIdenticalFailures,
    attempts: [],
  };
}

export function validateRepairBudget(value) {
  if (value == null) return emptyRepairBudget();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== 1
      || value.maxAttempts !== REPAIR_LIMITS.maxAttempts
      || value.maxIdenticalFailures !== REPAIR_LIMITS.maxIdenticalFailures
      || !Array.isArray(value.attempts)
      || value.attempts.length > REPAIR_LIMITS.maxAttempts) {
    throw reject("REPAIR_BUDGET_UNSAFE");
  }
  for (let i = 0; i < value.attempts.length; i++) {
    const entry = value.attempts[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || entry.sequence !== i + 1 || !CODE.test(entry.triggerCode)
        || !["RESERVED", "FAILED"].includes(entry.status)
        || (entry.status === "RESERVED" && entry.resultCode !== null)
        || (entry.status === "FAILED" && !CODE.test(entry.resultCode))
        || (entry.status === "RESERVED" && i !== value.attempts.length - 1)) {
      throw reject("REPAIR_BUDGET_UNSAFE");
    }
  }
  return value;
}

export function repairStopReason(value) {
  const budget = validateRepairBudget(value);
  const entries = budget.attempts;
  if (!entries.length) return null;
  const last = entries.at(-1);
  if (last.status === "RESERVED") return "REPAIR_ATTEMPT_OUTCOME_UNKNOWN";
  if (!ALLOWED.has(classifyFailure(last.resultCode).kind)) {
    return "REPAIR_FAILURE_NOT_REPAIRABLE";
  }
  let repeated = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].status !== "FAILED" || entries[i].resultCode !== last.resultCode) break;
    repeated++;
  }
  if (repeated >= REPAIR_LIMITS.maxIdenticalFailures) {
    return "REPAIR_SAME_ERROR_LOOP";
  }
  if (entries.length >= REPAIR_LIMITS.maxAttempts) {
    return "REPAIR_ATTEMPTS_EXHAUSTED";
  }
  return null;
}

export function reserveRepairAttempt(value, errorCode) {
  const budget = validateRepairBudget(value);
  const triggerCode = codeOf(errorCode);
  if (!ALLOWED.has(classifyFailure(triggerCode).kind)) {
    throw reject("REPAIR_FAILURE_NOT_REPAIRABLE");
  }
  const stopCode = repairStopReason(budget);
  if (stopCode) throw reject(stopCode);
  const next = structuredClone(budget);
  const attempt = {
    sequence: next.attempts.length + 1,
    triggerCode,
    resultCode: null,
    status: "RESERVED",
  };
  next.attempts.push(attempt);
  return { budget: next, attempt: { ...attempt } };
}

export function failRepairAttempt(value, { sequence, errorCode }) {
  const budget = validateRepairBudget(value);
  const code = codeOf(errorCode);
  const last = budget.attempts.at(-1);
  if (!last || last.status !== "RESERVED" || last.sequence !== sequence) {
    throw reject("REPAIR_ATTEMPT_NOT_RESERVED");
  }
  const next = structuredClone(budget);
  const target = next.attempts.at(-1);
  target.resultCode = code;
  target.status = "FAILED";
  return { budget: next, stopCode: repairStopReason(next) };
}
