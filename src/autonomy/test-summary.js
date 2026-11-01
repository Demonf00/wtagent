function reject(message) {
  return Object.assign(new Error(message), { code: "VERIFIER_TEST_RESULTS_INVALID" });
}

/**
 * Recognize the final, untruncated Node test runner TAP summary, not arbitrary
 * PASS strings. Only structured counts are persisted, never raw test output.
 */
export function parseTestSummary(stdout, { truncated = false, minTests = 1, maxSkipped = 0 } = {}) {
  if (truncated || typeof stdout !== "string" || Buffer.byteLength(stdout) > 65536) {
    throw reject("Test output is truncated, oversized or missing.");
  }
  if (!Number.isSafeInteger(minTests) || minTests < 1 || minTests > 10000
    || !Number.isSafeInteger(maxSkipped) || maxSkipped < 0 || maxSkipped > 10000) {
    throw reject("Invalid required test count or skip allowance.");
  }
  const counts = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    if (counts.has(match[1])) throw reject("Ambiguous duplicate test summary field.");
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value > 1000000) throw reject("Invalid test result count.");
    counts.set(match[1], value);
  }
  for (const field of ["tests", "pass", "fail", "skipped", "cancelled", "todo"]) {
    if (!counts.has(field)) throw reject(`Missing required test summary: ${field}.`);
  }
  const tests = counts.get("tests"), passed = counts.get("pass");
  const failed = counts.get("fail"), skipped = counts.get("skipped");
  const cancelled = counts.get("cancelled"), todo = counts.get("todo");
  if (tests !== passed + failed + skipped + cancelled + todo) {
    throw reject("Test summary counts are inconsistent.");
  }
  if (passed < minTests || failed !== 0 || cancelled !== 0 || todo !== 0
    || skipped > maxSkipped) {
    throw Object.assign(new Error("Required test acceptance did not pass."),
      { code: "VERIFIER_TEST_FAILED" });
  }
  return { tests, passed, failed, skipped, cancelled, todo, minTests, maxSkipped };
}

/**
 * Parse the trusted, dedicated Node reporter output. Node's ordinary output
 * counts an empty test file as a passing test; our reporter counts only
 * events belonging to registered test cases (entryFile present).
 */
export function parseStructuredTestSummary(stdout, {
  truncated = false,
  minTests = 1,
  maxSkipped = 0,
} = {}) {
  if (truncated || typeof stdout !== "string"
    || Buffer.byteLength(stdout, "utf8") > 4096
    || !Number.isSafeInteger(minTests) || minTests < 1 || minTests > 10000
    || !Number.isSafeInteger(maxSkipped) || maxSkipped < 0 || maxSkipped > 10000) {
    throw reject("Invalid or truncated structured test result.");
  }
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    throw reject("Missing structured Node test reporter result.");
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)
    || Object.keys(summary).sort().join(",") !== [
      "schema", "tests", "passed", "failed", "skipped", "cancelled", "todo",
    ].sort().join(",")
    || summary.schema !== 1
    || Object.values(summary).some((value) => !Number.isSafeInteger(value) || value < 0)
    || summary.tests > 10000
    || summary.tests !== summary.passed + summary.failed + summary.skipped
      + summary.cancelled + summary.todo) {
    throw reject("Malformed or inconsistent structured test results.");
  }
  if (summary.passed < minTests || summary.failed !== 0
    || summary.cancelled !== 0 || summary.todo !== 0
    || summary.skipped > maxSkipped) {
    throw Object.assign(new Error("Required Node test cases did not pass."),
      { code: "VERIFIER_TEST_FAILED" });
  }
  const { tests, passed, failed, skipped, cancelled, todo } = summary;
  return { tests, passed, failed, skipped, cancelled, todo, minTests, maxSkipped };
}

export function assertSavedTestSummary(proof, check) {
  if (!proof || !proof.testSummary || typeof proof.testSummary !== "object") {
    throw reject("Missing persisted structured test results.");
  }
  const s = proof.testSummary;
  if (Object.keys(s).sort().join(",") !==
    ["tests", "passed", "failed", "skipped", "cancelled", "todo", "minTests", "maxSkipped"].sort().join(",")
    || Object.values(s).some((v) => !Number.isSafeInteger(v) || v < 0)
    || s.minTests !== check.minTests || s.maxSkipped !== check.maxSkipped
    || s.tests !== s.passed + s.failed + s.skipped + s.cancelled + s.todo
    || s.passed < s.minTests || s.failed || s.cancelled || s.todo || s.skipped > s.maxSkipped) {
    throw reject("Persisted test evidence does not meet acceptance requirements.");
  }
}
