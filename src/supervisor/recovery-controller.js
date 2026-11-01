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
    ...(code === "BROWSER_ACCESS_CHALLENGE"
      && ["URL", "DOM", "TITLE", "BODY"].includes(error?.details?.evidence)
      ? { challengeEvidence: error.details.evidence } : {}),
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
/**
 * A sanitized, durable decision for one failed Worker attempt. This is
 * intentionally independent of browser text and exception messages.
 */
export function recoveryDecision({ status, incident, attempts, retries, retryAt, stopReason } = {}) {
  const actions = {
    waiting_retry: "retry",
    blocked_uncertain: "block",
    failed: "stop",
    paused: "pause",
    completed: "complete",
  };
  const action = actions[status];
  if (!action) return null;
  const safeCode = value => typeof value === "string" && SAFE_CODES.test(value)
    ? value : "UNCLASSIFIED";
  return {
    action,
    code: safeCode(incident?.code),
    reason: safeCode(incident?.reason),
    attempts: Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0,
    retries: Number.isSafeInteger(retries) && retries >= 0 ? retries : 0,
    retryAt: action === "retry" && typeof retryAt === "string"
      && Number.isFinite(Date.parse(retryAt)) ? retryAt : null,
    stopReason: action === "retry" ? null : safeCode(stopReason),
    recordedAt: typeof incident?.recordedAt === "string"
      && !Number.isNaN(Date.parse(incident.recordedAt))
      ? new Date(incident.recordedAt).toISOString() : new Date().toISOString(),
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
  if (type === "tool.started" || type === "tool.result_sent") {
    // Only a fixed category survives either Worker or Supervisor sanitization.
    // Never persist raw tool names, arguments, commands, or browser content.
    const readOnly = new Set([
      "fs.list", "fs.read", "fs.search", "browser.inspect",
    ]);
    const name = allowed.name;
    if (typeof name === "string" && readOnly.has(name)) {
      payload.toolClass = "read";
    } else if (typeof name === "string"
        && /^[a-z][a-z0-9_.-]{0,95}$/.test(name)) {
      payload.toolClass = name.startsWith("verification.") ? "verify" : "other";
    } else if (["read", "verify", "other", "unknown"].includes(allowed.toolClass)) {
      payload.toolClass = allowed.toolClass;
    } else {
      payload.toolClass = "unknown";
    }
    if (type === "tool.result_sent" && typeof allowed.ok === "boolean") {
      payload.ok = allowed.ok;
    }
  }
  return { type, payload };
}
