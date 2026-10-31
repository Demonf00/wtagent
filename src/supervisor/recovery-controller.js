/**
 * Conservative, deterministic recovery policy.
 *
 * Never infer that a browser send failed from an exception or a timeout.
 * The runtime owns pendingOutbound reconciliation; the supervisor can only
 * resume an existing, target-bound checkpoint. It must never clear a
 * checkpoint, alter an outbound identity, or issue a replacement prompt.
 */

export const RECOVERY_DEFAULTS = Object.freeze({
  maxRetries: 3,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  progressTimeoutMs: 180_000,
  heartbeatMs: 5_000,
});

const SAFE_CODES = /^[A-Z][A-Z0-9_]{0,63}$/;

export function recoveryOptions(options = {}) {
  const source = options?.recovery ?? {};
  const positiveInteger = (key, fallback, max) =>
    Number.isSafeInteger(source[key]) && source[key] > 0 && source[key] <= max
      ? source[key] : fallback;
  return {
    maxRetries: positiveInteger("maxRetries", RECOVERY_DEFAULTS.maxRetries, 20),
    retryBaseMs: positiveInteger("retryBaseMs", RECOVERY_DEFAULTS.retryBaseMs, 60_000),
    retryMaxMs: positiveInteger("retryMaxMs", RECOVERY_DEFAULTS.retryMaxMs, 300_000),
    progressTimeoutMs: positiveInteger("progressTimeoutMs", RECOVERY_DEFAULTS.progressTimeoutMs, 3_600_000),
    heartbeatMs: positiveInteger("heartbeatMs", RECOVERY_DEFAULTS.heartbeatMs, 60_000),
  };
}

export function retryDelay(retries, settings = RECOVERY_DEFAULTS) {
  const exponent = Math.max(0, Math.min(20, retries - 1));
  return Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** exponent);
}

/**
 * Distinguish recovery checkpoint availability from retryability.
 * In particular, runCount > 0 without any pending handoff is NOT proof
 * that replaying the last user message would be safe.
 */
export function inspectCheckpoint(state) {
  if (!state || typeof state !== "object") {
    return { action: "block", reason: "SESSION_UNAVAILABLE" };
  }
  if (state.phase === "idle" && state.lastMessage && state.runCount > 0
      && !state.pendingOutbound && !state.pendingAssistantTurn
      && !state.pendingAuxiliaryTurn) {
    return { action: "complete", reason: "SESSION_ALREADY_COMPLETED" };
  }
  if (state.pendingAuxiliaryTurn) {
    return { action: "block", reason: "AUXILIARY_HANDOFF_UNCERTAIN" };
  }
  if (state.pendingOutbound || state.pendingAssistantTurn) {
    const outbound = state.pendingOutbound;
    const expected = state.conversationTargetId;
    const observed = outbound?.conversationTargetId;
    if (typeof expected !== "string" || !expected.trim()) {
      return { action: "block", reason: "CONVERSATION_TARGET_UNBOUND" };
    }
    if (observed && observed !== expected) {
      return { action: "block", reason: "CONVERSATION_TARGET_MISMATCH" };
    }
    return {
      action: "reconcile",
      reason: outbound ? "PENDING_OUTBOUND" : "PENDING_ASSISTANT_TURN",
    };
  }
  if (!state.runCount && state.phase === "idle") {
    return { action: "retry", reason: "NEVER_STARTED" };
  }
  return { action: "block", reason: "NO_SAFE_RECOVERY_CHECKPOINT" };
}

/** Structured diagnostics never include exception messages or browser content. */
export function incidentSummary({ error, state, reason, retries, workerHealth } = {}) {
  const rawCode = error?.code;
  const code = typeof rawCode === "string" && SAFE_CODES.test(rawCode)
    ? rawCode : "UNCLASSIFIED";
  const outbound = state?.pendingOutbound;
  return {
    code,
    reason: typeof reason === "string" && SAFE_CODES.test(reason) ? reason : "UNCLASSIFIED",
    retries: Number.isSafeInteger(retries) ? retries : 0,
    workerHealth: ["healthy", "stalled", "exited", "unknown"].includes(workerHealth)
      ? workerHealth : "unknown",
    hasPendingOutbound: Boolean(outbound),
    hasPendingAssistantTurn: Boolean(state?.pendingAssistantTurn),
    hasPendingAuxiliaryTurn: Boolean(state?.pendingAuxiliaryTurn),
    hasBoundConversationTarget: Boolean(state?.conversationTargetId),
    hasOutboundIdentity: typeof outbound?.outboundId === "string" && !!outbound.outboundId,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Event payloads are deliberately stripped of browser text, prompt content,
 * tool arguments, screenshots, credentials and raw exception messages.
 */
export function safeRuntimeEvent(event) {
  const type = typeof event?.type === "string"
    && /^[a-z][a-z0-9_.-]{0,63}$/.test(event.type)
    ? event.type : "runtime.event";
  const payload = {};
  const allowed = event?.payload ?? {};
  for (const key of ["code", "phase", "status"]) {
    const value = allowed[key];
    if (typeof value === "string" && SAFE_CODES.test(value)) payload[key] = value;
  }
  return { type, payload };
}
