import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runProgram } from "../tools/terminal-exec.js";
import {
  fingerprintVerificationInputs,
  assertVerificationInputsUnchanged,
} from "./verification-inputs.js";

const PROBE_SCRIPT = fileURLToPath(new URL("./local-http-probe.js", import.meta.url));

function reject(message, code = "VERIFIER_HTTP_FAILED") {
  return Object.assign(new Error(message), { code });
}

export function validateHttpCheck(check) {
  if (!check || typeof check !== "object" || Array.isArray(check)
    || Object.keys(check).some((key) => ![
      "kind", "port", "path", "expectedStatus", "expectedContains", "timeoutMs",
    ].includes(key))) {
    throw reject("Unsupported localhost integration acceptance fields.", "INVALID_PLAN");
  }
  const timeoutMs = check.timeoutMs ?? 5000;
  if (check.kind !== "integration"
    || !Number.isSafeInteger(check.port) || check.port < 1024 || check.port > 65535
    || typeof check.path !== "string" || check.path.length > 512
    || !/^\/[A-Za-z0-9/_?=&.%+-]*$/.test(check.path)
    || check.path.startsWith("//")
    || !Number.isSafeInteger(check.expectedStatus)
    || check.expectedStatus < 200 || check.expectedStatus > 299
    || typeof check.expectedContains !== "string"
    || !check.expectedContains.length
    || Buffer.byteLength(check.expectedContains, "utf8") > 256
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10000) {
    throw reject("Integration acceptance must describe a bounded, read-only loopback GET.", "INVALID_PLAN");
  }
  return {
    kind: "integration",
    port: check.port,
    path: check.path,
    expectedStatus: check.expectedStatus,
    expectedContains: check.expectedContains,
    timeoutMs,
  };
}

export function httpCheckHash(check) {
  return createHash("sha256").update(JSON.stringify(check)).digest("hex");
}

export function assertSavedHttpEvidence(prior, check) {
  if (!prior || prior.kind !== "integration"
    || prior.checkHash !== httpCheckHash(check)
    || prior.statusCode !== check.expectedStatus
    || prior.containsExpected !== true
    || !Number.isSafeInteger(prior.bodyBytes) || prior.bodyBytes < 1
    || prior.bodyBytes > 16 * 1024
    || typeof prior.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(prior.bodyHash)
    || prior.exitCode !== 0 || prior.timedOut !== false || prior.signal !== null) {
    throw reject("Persisted localhost integration result is invalid.", "VERIFIER_EVIDENCE_INVALID");
  }
}

export async function executeHttpCheck(root, check, { run = runProgram } = {}) {
  const validated = validateHttpCheck(check);
  const workspace = await fs.realpath(root);
  if (workspace !== root) {
    throw reject("Verifier workspace must be canonical.", "VERIFIER_UNSAFE");
  }
  const inputs = await fingerprintVerificationInputs(workspace);
  let result;
  try {
    result = await run({
      program: "node",
      argv: [
        PROBE_SCRIPT, String(validated.port), validated.path,
        String(validated.expectedStatus), validated.expectedContains,
      ],
      cwd: workspace,
      timeoutMs: validated.timeoutMs,
      maxOutputBytes: 2048,
      maxLogBytes: 2048,
      inheritSensitiveEnv: false,
    });
  } catch {
    throw reject("Local integration probe failed to launch.", "VERIFIER_SPAWN_FAILED");
  }
  if (!result || result.completionUnknown) {
    throw reject("Local integration probe completion is uncertain.", "VERIFIER_COMPLETION_UNKNOWN");
  }
  if (result.timedOut) throw reject("Local integration probe timed out.", "VERIFIER_TIMEOUT");
  if (result.ok !== true || result.exitCode !== 0 || result.signal
    || result.truncated === true || result.stderr !== "") {
    throw reject("Local integration probe did not pass.");
  }

  let measured;
  try {
    measured = JSON.parse(result.stdout);
  } catch {
    throw reject("Local integration probe returned invalid structured data.");
  }
  if (!measured || Object.keys(measured).sort().join(",") !==
    ["schema", "statusCode", "bodyBytes", "bodyHash", "containsExpected"].sort().join(",")
    || measured.schema !== 1
    || measured.statusCode !== validated.expectedStatus
    || measured.containsExpected !== true
    || !Number.isSafeInteger(measured.bodyBytes)
    || measured.bodyBytes < 1 || measured.bodyBytes > 16 * 1024
    || typeof measured.bodyHash !== "string"
    || !/^[a-f0-9]{64}$/.test(measured.bodyHash)) {
    throw reject("Local integration probe returned invalid results.");
  }

  await assertVerificationInputsUnchanged(workspace, inputs);
  const proof = {
    kind: "integration",
    checkHash: httpCheckHash(validated),
    ...inputs,
    exitCode: 0,
    timedOut: false,
    signal: null,
    statusCode: measured.statusCode,
    bodyBytes: measured.bodyBytes,
    bodyHash: measured.bodyHash,
    containsExpected: true,
  };
  assertSavedHttpEvidence(proof, validated);
  return proof;
}
