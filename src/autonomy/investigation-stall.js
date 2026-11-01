
/**
 * DP-02: strictly bounded observation of investigation-only progress.
 *
 * Events originate from Supervisor's sanitized, append-only event log.
 * Never inspect prompt text, file contents, commands, or browser output.
 * An event classified as "unknown" is not evidence of a read-only stall.
 */
export const MAX_READ_ONLY_STREAK = 12;
export const MAX_STALL_REPLANS = 2;

const READ_ONLY = new Set([
  "fs.list", "fs.read", "fs.search",
  "browser.inspect",
]);
const VERIFICATION = new Set([
  "verification", "test", "integration",
]);

export function classifyTool(name) {
  if (READ_ONLY.has(name)) return "read";
  if (VERIFICATION.has(name)) return "verify";
  if (typeof name !== "string" || name.length > 100) return "unknown";
  // A mutation or shell tool is not evidence of progress by itself; it only
  // breaks the *investigation-only* streak. Outcome verification remains
  // exclusively the Coordinator's independent artifact checker.
  if (name === "terminal.exec" || name === "process.start"
      || name === "process.stop" || name === "fs.write"
      || name === "fs.edit" || name.startsWith("browser.")
      || name.startsWith("image.")) return "other";
  return "unknown";
}

export function initialInvestigationMonitor() {
  return {
    lastSeq: 0,
    readOnlyStreak: 0,
    observedCompletions: 0,
    replanCount: 0,
    replanRequired: false,
    budgetExhausted: false,
    activeRead: false,
  };
}

export function validateInvestigationMonitor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || !Number.isSafeInteger(input.lastSeq) || input.lastSeq < 0
      || !Number.isSafeInteger(input.readOnlyStreak)
      || input.readOnlyStreak < 0 || input.readOnlyStreak > MAX_READ_ONLY_STREAK
      || !Number.isSafeInteger(input.observedCompletions)
      || input.observedCompletions < 0
      || !Number.isSafeInteger(input.replanCount)
      || input.replanCount < 0 || input.replanCount > MAX_STALL_REPLANS
      || typeof input.replanRequired !== "boolean"
      || typeof input.budgetExhausted !== "boolean"
      || (input.replanRequired && input.budgetExhausted)
      || (input.budgetExhausted && input.replanCount !== MAX_STALL_REPLANS)
      || typeof input.activeRead !== "boolean") {
    const error = new Error("Unsafe investigation monitor checkpoint.");
    error.code = "STATE_UNSAFE";
    throw error;
  }
  return structuredClone(input);
}

/**
 * Consume only strictly ordered, never-before-consumed Supervisor events.
 * Tool starts are necessary to associate a sanitized classification with
 * a tool completion. A start without a completion never increments a streak:
 * genuinely long-running tools and verifications cannot be mistaken for stalls.
 *
 * The Supervisor emits safe toolClass on tool.started and tool.result_sent.
 * Only a successful result paired with a read start increments the streak.
 */
export function observeInvestigationEvents(previous, events) {
  const state = validateInvestigationMonitor(previous);
  if (!Array.isArray(events)) {
    const error = new Error("Investigation events must be an array.");
    error.code = "STATE_UNSAFE";
    throw error;
  }
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 1) {
      const error = new Error("Malformed event sequence.");
      error.code = "STATE_UNSAFE";
      throw error;
    }
    if (event.seq <= state.lastSeq) continue;
    state.lastSeq = event.seq;
    if (event.type === "tool.started") {
      state.activeRead = event.payload?.toolClass === "read";
      // A test, long-running command, or unknown operation has already
      // interrupted read-only exploration. Do not pause it while in flight.
      if (!state.activeRead) state.readOnlyStreak = 0;
    } else if (event.type === "tool.result_sent") {
      state.observedCompletions += 1;
      if (event.payload?.toolClass === "read"
          && event.payload?.ok === true && state.activeRead) {
        state.readOnlyStreak = Math.min(MAX_READ_ONLY_STREAK, state.readOnlyStreak + 1);
      } else {
        state.readOnlyStreak = 0;
      }
      state.activeRead = false;
    } else if (["tool.completion_unknown", "tool.invalid",
        "tool.conflict", "tool.reused_unknown"].includes(event.type)) {
      state.activeRead = false;
      state.readOnlyStreak = 0;
    }
  }
  // Decide only after consuming the entire durable event batch. A later
  // verified mutation/other completed tool in this batch breaks the
  // investigation-only streak before requesting a pause.
  if (state.readOnlyStreak >= MAX_READ_ONLY_STREAK
      && !state.replanRequired && !state.budgetExhausted) {
    if (state.replanCount < MAX_STALL_REPLANS) {
      state.replanRequired = true;
      state.replanCount += 1;
    } else {
      // Fail closed rather than exploring indefinitely after the budget.
      state.budgetExhausted = true;
    }
  }
  return state;
}
