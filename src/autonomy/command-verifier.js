import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runProgram } from "../tools/terminal-exec.js";

const APPROVED_SCRIPTS = new Set([
  "check", "test", "test:unit", "test:integration", "test:windows",
  "test:chatgpt-dom", "test:media",
]);

function reject(message, code = "VERIFIER_UNSAFE") {
  return Object.assign(new Error(message), { code });
}

export function commandCheckHash(check) {
  return createHash("sha256").update(JSON.stringify({
    kind: "command", program: check.program, argv: check.argv,
    cwd: check.cwd, timeoutMs: check.timeoutMs,
  })).digest("hex");
}

async function assertRegularPath(root, relativePath) {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === "..") {
      throw reject("Unsafe verifier target path.");
    }
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) {
        throw reject("Verifier target path is inaccessible or missing.");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw reject("Verifier target includes a symlink.");
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw reject("Verifier target contains a non-directory ancestor.");
    }
  }
  if (!(await fs.stat(current)).isFile()) {
    throw reject("Verifier target must be a regular file.");
  }
}

function assertAllowedCommand(check) {
  if (!check || check.kind !== "command" || check.cwd !== "."
    || !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1000
    || check.timeoutMs > 120000 || !Array.isArray(check.argv)) {
    throw reject("Invalid command verification declaration.");
  }
  if (check.program === "npm") {
    const a = check.argv;
    const script = a.length === 1 && a[0] === "test" ? "test"
      : a.length === 2 && a[0] === "run" ? a[1] : null;
    if (!APPROVED_SCRIPTS.has(script)) throw reject("Unapproved verifier script.");
    return;
  }
  if (check.program === "node") {
    const a = check.argv;
    if (a.length < 2 || a.length > 9 || a[0] !== "--test"
      || a.slice(1).some((value) => typeof value !== "string"
        || !/^test\/[A-Za-z0-9_/-]+\.test\.js$/.test(value)
        || value.split("/").some((part) => !part || part === "." || part === ".."))) {
      throw reject("Unapproved Node verifier test path.");
    }
    return;
  }
  throw reject("Unapproved verifier program.");
}

/**
 * Run allowlisted verification in a separate, bounded process. This is NOT an
 * OS sandbox: workspace-controlled npm scripts and test files execute code.
 * Use only in a workspace for which that execution is authorized.
 */
export async function executeCommandCheck(root, check, {
  run = runProgram,
} = {}) {
  assertAllowedCommand(check);
  const workspace = await fs.realpath(root);
  if (workspace !== root) {
    throw reject("Verifier workspace must be the canonical path.");
  }
  if (check.program === "npm") {
    await assertRegularPath(workspace, "package.json");
  } else {
    for (const file of check.argv.slice(1)) {
      await assertRegularPath(workspace, file);
    }
  }

  let result;
  try {
    result = await run({
      program: check.program,
      argv: [...check.argv],
      cwd: workspace,
      timeoutMs: check.timeoutMs,
      maxOutputBytes: 4096,
      maxLogBytes: 4096,
      inheritSensitiveEnv: false,
    });
  } catch {
    throw reject("Verifier process failed to launch.", "VERIFIER_SPAWN_FAILED");
  }
  if (!result || result.completionUnknown) {
    throw reject("Verifier process completion is uncertain.", "VERIFIER_COMPLETION_UNKNOWN");
  }
  if (result.timedOut) {
    throw reject("Verifier exceeded its time budget.", "VERIFIER_TIMEOUT");
  }
  if (result.error || result.exitCode === null || result.exitCode === undefined) {
    throw reject("Verifier process failed.", "VERIFIER_SPAWN_FAILED");
  }
  if (result.ok !== true || result.exitCode !== 0 || result.signal) {
    throw reject("Verification command did not pass.", "VERIFIER_COMMAND_FAILED");
  }
  return {
    kind: "command",
    checkHash: commandCheckHash(check),
    exitCode: 0,
    timedOut: false,
    signal: null,
    durationMs: result.durationMs ?? null,
    stdoutBytes: result.stdoutBytes ?? null,
    stderrBytes: result.stderrBytes ?? null,
    outputHash: createHash("sha256").update(
      JSON.stringify([result.stdout ?? "", result.stderr ?? ""]),
    ).digest("hex"),
  };
}
