
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { replaceFileAtomic } from "../shared/atomic-write.js";
import { annotateCheckpointFailures } from "./failure-classifier.js";
import {
  initialInvestigationMonitor, validateInvestigationMonitor,
  observeInvestigationEvents, MAX_STALL_REPLANS,
} from "./investigation-stall.js";
import { emptyRepairBudget, validateRepairBudget, reserveRepairAttempt, failRepairAttempt, succeedRepairAttempt, repairStopReason } from "./repair-budget.js";
import { buildRepairSubtask, assertRepairSubtask } from "./repair-subtask.js";
import { executeCommandCheck, commandCheckHash } from "./command-verifier.js";
import { makeVerificationReceipt, assertVerificationReceipt } from "./verification-receipt.js";
import { assertSavedTestSummary } from "./test-summary.js";
import {
  validateHttpCheck,
  httpCheckHash,
  executeHttpCheck,
  assertSavedHttpEvidence,
} from "./http-verifier.js";
import { assertVerificationInputsUnchanged } from "./verification-inputs.js";
import {
  makeGoalReceipt, assertGoalReceipt, buildDeliveryReport,
} from "./goal-delivery.js";

const TASK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const STOPPED = new Set(["blocked_uncertain", "failed", "cancelled", "paused", "interrupted"]);
const TERMINAL = new Set(["VERIFIED", "BLOCKED"]);
const MAX_TASKS = 32;

function invalid(message, code = "INVALID_PLAN") {
  return Object.assign(new Error(message), { code });
}

function nonempty(value, limit = 65536) {
  return typeof value === "string" && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= limit;
}

function relativeFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\")
    || value.includes("\0") || path.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === ".."
      || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
    throw invalid("Artifact path must be a safe workspace-relative file path.");
  }
  return value;
}

const ALLOWED_NPM_VERIFICATION_SCRIPTS = new Set([
  "check", "test", "test:unit", "test:integration", "test:windows",
  "test:chatgpt-dom", "test:media",
]);

// This only validates declarations. Command execution is deliberately unavailable
// until a separate, restricted verifier is implemented.
function validateCommandCheck(check) {
  if (Object.keys(check).some((key) =>
    !["kind", "program", "argv", "cwd", "timeoutMs"].includes(key))) {
    throw invalid("Command acceptance contains unsupported fields.");
  }
  if (check.cwd !== undefined && check.cwd !== ".") {
    throw invalid("Command verification must use the workspace root.");
  }
  const timeoutMs = check.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw invalid("Command verification timeout must be 1000 to 120000 ms.");
  }
  const args = check.argv;
  if (!Array.isArray(args) || args.some((arg) =>
    typeof arg !== "string" || !arg || Buffer.byteLength(arg, "utf8") > 256)) {
    throw invalid("Command verification requires bounded argument strings.");
  }
  if (check.program === "npm") {
    const script = args.length === 1 && args[0] === "test" ? "test"
      : args.length === 2 && args[0] === "run" ? args[1] : null;
    if (!ALLOWED_NPM_VERIFICATION_SCRIPTS.has(script)) {
      throw invalid("Command verification allows only approved npm check/test scripts.");
    }
  } else if (check.program === "node") {
    if (args.length < 2 || args.length > 9 || args[0] !== "--test"
      || args.slice(1).some((arg) =>
        !/^test\/[a-zA-Z0-9_/-]+\.test\.js$/.test(arg)
        || arg.split("/").includes("..")
        || arg.split("/").includes("."))) {
      throw invalid("Node verification requires explicit safe test/*.test.js paths.");
    }
  } else {
    throw invalid("Unsupported command verification program.");
  }
  return { kind: "command", program: check.program, argv: [...args],
    cwd: ".", timeoutMs };
}

export function validateTaskPlan(input) {
  if (!input || !nonempty(input.goal, 8192) || !Array.isArray(input.tasks)
    || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) {
    throw invalid("Plan requires a goal and 1 to 32 tasks.");
  }
  const ids = new Set();
  const tasks = input.tasks.map((task) => {
    if (!task || !TASK_ID.test(task.id ?? "") || ids.has(task.id)
      || !nonempty(task.instruction)) {
      throw invalid("Every task needs a unique ID and nonempty instruction.");
    }
    ids.add(task.id);
    if (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length
      || task.dependsOn.some((id) => !TASK_ID.test(id))) {
      throw invalid(`Task ${task.id} has invalid dependencies.`);
    }
    if (!Array.isArray(task.acceptance) || !task.acceptance.length
      || task.acceptance.length > 16) {
      throw invalid(`Task ${task.id} needs objective artifact checks.`);
    }
    const acceptance = task.acceptance.map((check) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) {
        throw invalid("Invalid acceptance check.");
      }
      if (check.kind === "command") return validateCommandCheck(check);
      if (check.kind === "integration") return validateHttpCheck(check);
      if (check.kind === "test") {
        if (Object.keys(check).some((key) => ![
          "kind", "program", "argv", "cwd", "timeoutMs", "minTests", "maxSkipped",
        ].includes(key)) || check.program !== "node") {
          throw invalid("Test acceptance requires an approved explicit Node test command.");
        }
        const command = validateCommandCheck({
          kind: "command", program: check.program, argv: check.argv,
          cwd: check.cwd, timeoutMs: check.timeoutMs,
        });
        const minTests = check.minTests ?? 1;
        const maxSkipped = check.maxSkipped ?? 0;
        if (!Number.isSafeInteger(minTests) || minTests < 1 || minTests > 10000
          || !Number.isSafeInteger(maxSkipped) || maxSkipped < 0 || maxSkipped > 10000) {
          throw invalid("Invalid required test count or skipped-test limit.");
        }
        return { ...command, kind: "test", minTests, maxSkipped };
      }
      if (check.kind !== "file") {
        throw invalid("Only file, command, test and integration acceptance checks are supported.");
      }
      const file = relativeFile(check.path);
      if (check.sha256 !== undefined && !HASH.test(check.sha256)) {
        throw invalid(`Invalid expected SHA-256 for ${file}.`);
      }
      const minBytes = check.minBytes ?? 1;
      if (!Number.isSafeInteger(minBytes) || minBytes < 1 || minBytes > 100_000_000) {
        throw invalid(`Invalid minimum file size for ${file}.`);
      }
      return { kind: "file", path: file, minBytes, ...(check.sha256 ? { sha256: check.sha256 } : {}) };
    });
    return { id: task.id, instruction: task.instruction, dependsOn: [...task.dependsOn], acceptance };
  });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw invalid("Task dependency graph contains a cycle.");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw invalid(`Unknown prerequisite: ${id}.`);
    visiting.add(id);
    for (const prerequisite of task.dependsOn) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  let finalAcceptance = [];
  if (input.finalAcceptance !== undefined) {
    if (!Array.isArray(input.finalAcceptance)
      || input.finalAcceptance.length < 1 || input.finalAcceptance.length > 16
      || input.finalAcceptance.some((check) =>
        !check || !["test", "integration"].includes(check.kind))) {
      throw invalid("Final goal acceptance requires 1 to 16 real test or integration checks.");
    }
    // Reuse exactly the same strict acceptance normalization as worker tasks.
    // No nested finalAcceptance is passed into this one-task validation.
    finalAcceptance = validateTaskPlan({
      goal: "Final functional verification",
      tasks: [{
        id: "final", instruction: "Verify the overall goal",
        dependsOn: [], acceptance: input.finalAcceptance,
      }],
    }).tasks[0].acceptance;
  }
  return {
    goal: input.goal, tasks,
    ...(input.finalAcceptance === undefined ? {} : { finalAcceptance }),
  };
}

async function persist(file, state) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFileAtomic(tmp, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function artifactEvidence(root, check) {
  try {
    let candidate = root;
    for (const segment of check.path.split("/")) {
      candidate = path.join(candidate, segment);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw invalid("Symlinked artifact paths are forbidden.", "ARTIFACT_UNSAFE");
    }
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size < check.minBytes || stat.size > 100_000_000) {
      throw invalid(`Artifact size or type failed: ${check.path}`, "ARTIFACT_INVALID");
    }
    const bytes = await fs.readFile(candidate);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (check.sha256 && sha256 !== check.sha256) {
      throw invalid(`Artifact hash mismatch: ${check.path}`, "ARTIFACT_MISMATCH");
    }
    return { path: check.path, sha256, bytes: bytes.length };
  } catch (error) {
    // Only a missing artifact within the verification path is repairable.
    // Do not reinterpret permission, symlink or unrelated filesystem errors.
    if (error?.code === "ENOENT") {
      throw invalid("Required verification artifact is missing.", "ARTIFACT_MISSING");
    }
    throw error;
  }
}

async function captureBaseline(root, task) {
  const baseline = [];
  for (const check of task.acceptance) {
    if (check.kind === "command" || check.kind === "test") {
      baseline.push({ kind: check.kind, checkHash: commandCheckHash(check) });
      continue;
    }
    if (check.kind === "integration") {
      baseline.push({ kind: "integration", checkHash: httpCheckHash(check) });
      continue;
    }
    let candidate = root;
    let missing = false;
    for (const segment of check.path.split("/")) {
      candidate = path.join(candidate, segment);
      let stat;
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        missing = true;
        break;
      }
      if (stat.isSymbolicLink()) {
        throw invalid("Symlinked artifact paths are forbidden.", "ARTIFACT_UNSAFE");
      }
    }
    if (missing) {
      baseline.push({ path: check.path, sha256: null });
      continue;
    }
    const stat = await fs.stat(candidate);
    if (!stat.isFile() || stat.size > 100_000_000) {
      throw invalid(`Preexisting artifact is not a safe file: ${check.path}`, "ARTIFACT_INVALID");
    }
    const bytes = await fs.readFile(candidate);
    baseline.push({
      path: check.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return baseline;
}

async function verifyArtifacts(root, task, evidence = null) {
  const results = [];
  for (let index = 0; index < task.acceptance.length; index += 1) {
    const check = task.acceptance[index];
    const baseline = task.baseline?.[index];
    if (check.kind === "integration") {
      const checkHash = httpCheckHash(check);
      if (baseline?.kind !== "integration" || baseline.checkHash !== checkHash) {
        throw invalid("Missing or mismatched integration baseline.", "STATE_UNSAFE");
      }
      if (evidence) {
        const prior = evidence[index];
        assertSavedHttpEvidence(prior, check);
        await assertVerificationInputsUnchanged(root, prior);
        results.push(prior);
      } else {
        results.push(await executeHttpCheck(root, check));
      }
      continue;
    }
    if (check.kind === "command" || check.kind === "test") {
      const checkHash = commandCheckHash(check);
      if (baseline?.kind !== check.kind || baseline.checkHash !== checkHash) {
        throw invalid("Missing or mismatched command/test baseline.", "STATE_UNSAFE");
      }
      if (evidence) {
        const prior = evidence[index];
        if (!prior || prior.kind !== "command" || prior.checkHash !== checkHash
          || prior.exitCode !== 0 || prior.timedOut !== false || prior.signal !== null) {
          throw invalid("Command verification evidence is missing or invalid.", "VERIFIER_EVIDENCE_INVALID");
        }
        if (check.kind === "test") assertSavedTestSummary(prior, check);
        // Read-only revalidation; never rerun tests or npm scripts on resume.
        await assertVerificationInputsUnchanged(root, prior);
        results.push(prior);
      } else {
        results.push(await executeCommandCheck(root, check, {
          ...(check.kind === "test" ? {
            testRequirements: {
              minTests: check.minTests,
              maxSkipped: check.maxSkipped,
            },
          } : {}),
        }));
      }
      continue;
    }
    const proof = await artifactEvidence(root, check);
    if (!baseline || baseline.path !== check.path) {
      throw invalid(`Missing persisted artifact baseline: ${check.path}`, "STATE_UNSAFE");
    }
    if (!check.sha256 && baseline.sha256 !== null && baseline.sha256 === proof.sha256) {
      throw invalid(`Artifact unchanged since task submission: ${check.path}`, "ARTIFACT_UNCHANGED");
    }
    const prior = evidence?.[index];
    if (evidence && (!prior || prior.sha256 !== proof.sha256 || prior.bytes !== proof.bytes)) {
      throw invalid(`Verified artifact changed: ${check.path}`, "ARTIFACT_DRIFT");
    }
    results.push(proof);
  }
  if (evidence && evidence.length !== results.length) {
    throw invalid("Verification evidence length mismatch.", "VERIFIER_EVIDENCE_INVALID");
  }
  return results;
}

function snapshot(value) {
  return structuredClone(value);
}

/**
 * Single-writer, one-workspace coordinator. The caller owns process lifecycle;
 * it must not create multiple independent coordinators for the same stateFile.
 * A stopped/uncertain Supervisor task is never automatically resubmitted.
 */

/**
 * An execution record is an intent persisted before Supervisor.create.
 * SUBMITTING may be recovered solely through the Supervisor's stable,
 * durable idempotency key. RUNNING / VERIFYING must have authentic identity.
 */
function assertRepairExecution(state, execution, supervisor) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) {
    throw invalid("Repair execution record is invalid.", "REPAIR_EXECUTION_UNSAFE");
  }
  const proposal = state.repairSubtask;
  const attempt = state.repairBudget?.attempts?.at(-1);
  if (state.status !== "BLOCKED" || !proposal
      || execution.schema !== 1
      || !["SUBMITTING", "RUNNING", "VERIFYING"].includes(execution.phase)
      || execution.attemptSequence !== proposal.attemptSequence
      || execution.idempotencyKey !== proposal.idempotencyKey
      || execution.instruction !== proposal.instruction
      || attempt?.status !== "RESERVED"
      || attempt.sequence !== execution.attemptSequence
      || ((execution.phase === "SUBMITTING") !== (execution.supervisorTaskId === null))) {
    throw invalid("Repair execution identity does not match reservation.", "REPAIR_EXECUTION_UNSAFE");
  }
  if (execution.supervisorTaskId !== null) {
    if (!/^task_[a-f0-9-]{36}$/.test(execution.supervisorTaskId)) {
      throw invalid("Repair Supervisor ID is invalid.", "REPAIR_EXECUTION_UNSAFE");
    }
    const record = supervisor.get(execution.supervisorTaskId);
    if (!record || record.taskId !== execution.supervisorTaskId
        || record.idempotencyKey !== proposal.idempotencyKey
        || record.instruction !== proposal.instruction
        || record.workspaceId !== state.workspaceId
        || record.workspaceRoot !== state.workspaceRoot) {
      throw invalid("Repair Supervisor identity mismatch.", "REPAIR_EXECUTION_UNSAFE");
    }
  }
  return true;
}

export class TaskCoordinator {
  constructor({ stateFile, workspaceRoot, workspaceId, supervisor, state }) {
    this.stateFile = stateFile;
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = workspaceId;
    this.supervisor = supervisor;
    this.state = state;
    this.mutations = Promise.resolve();
  }

  static async create({ stateFile, workspaceRoot, workspaceId = "main", supervisor, plan }) {
    if (!supervisor?.create || !supervisor?.get || !nonempty(workspaceId, 64)) {
      throw invalid("A live Supervisor and workspace ID are required.");
    }
    const root = await fs.realpath(workspaceRoot);
    const file = path.resolve(stateFile);
    if (file === root || file.startsWith(`${root}${path.sep}`)) {
      throw invalid("Coordinator state must live outside the agent workspace.");
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.lstat(file);
      throw invalid("Coordinator state already exists. Resume it instead.", "STATE_EXISTS");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const checked = validateTaskPlan(plan);
    const planId = randomUUID();
    const state = {
      schema: 2, planId, workspaceRoot: root, workspaceId,
      goal: checked.goal, status: "RUNNING", lastError: null,
      planRevision: 0,
      investigation: null,
      repairBudget: emptyRepairBudget(),
      repairSubtask: null,
      repairExecution: null,
      goalDelivery: {
        status: checked.finalAcceptance?.length ? "PENDING" : "UNVERIFIED",
        acceptance: checked.finalAcceptance ?? [],
        verificationStarted: false, evidence: null, receipt: null, error: null,
      },
      tasks: checked.tasks.map((task) => ({
        ...task, status: "TODO", supervisorTaskId: null,
        idempotencyKey: `autonomy:${planId}:${task.id}`,
        baseline: null, evidence: null, verificationReceipt: null, error: null,
      })),
    };
    await persist(file, state);
    return new TaskCoordinator({ stateFile: file, workspaceRoot: root, workspaceId, supervisor, state });
  }

  static async load({ stateFile, workspaceRoot, workspaceId = "main", supervisor }) {
    if (!supervisor?.create || !supervisor?.get) {
      throw invalid("A live Supervisor is required.");
    }
    const root = await fs.realpath(workspaceRoot);
    const file = path.resolve(stateFile);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw invalid("Unsafe coordinator checkpoint.", "STATE_UNSAFE");
    }
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    if (![1, 2].includes(state.schema) || state.workspaceRoot !== root
      || state.workspaceId !== workspaceId
      || !/^[a-f0-9-]{36}$/.test(state.planId ?? "")
      || !Array.isArray(state.tasks)) {
      throw invalid("Coordinator checkpoint identity mismatch.", "STATE_UNSAFE");
    }
    state.planRevision ??= 0;
    if (!Number.isSafeInteger(state.planRevision) || state.planRevision < 0) {
      throw invalid("Invalid plan revision.", "STATE_UNSAFE");
    }
    state.investigation ??= null;
    if (state.investigation !== null) {
      const record = state.investigation;
      const matched = state.tasks.find(task => task.id === record?.taskId);
      if (!matched || !matched.supervisorTaskId
          || matched.supervisorTaskId !== record.supervisorTaskId
          || !Number.isSafeInteger(record.revisionAtTrigger)
          || record.revisionAtTrigger < 0
          || record.revisionAtTrigger > state.planRevision
          || typeof record.pauseRequested !== "boolean") {
        throw invalid("Invalid investigation monitor identity.", "STATE_UNSAFE");
      }
      try {
        record.monitor = validateInvestigationMonitor(record.monitor);
      } catch {
        throw invalid("Invalid investigation monitor state.", "STATE_UNSAFE");
      }
      if ((record.monitor.replanRequired || record.monitor.budgetExhausted)
          && matched.status !== "RUNNING") {
        throw invalid("Pending investigation replan requires a running task.", "STATE_UNSAFE");
      }
    }
    const checked = validateTaskPlan({ goal: state.goal, tasks: state.tasks });
    if (checked.tasks.length !== state.tasks.length
      || !["RUNNING", "VERIFIED", "BLOCKED"].includes(state.status)
      || (state.status === "VERIFIED"
        && !state.tasks.every((task) => task.status === "VERIFIED"))
      || state.tasks.some((task) =>
      !["TODO", "RUNNING", "VERIFYING", "VERIFIED", "BLOCKED"].includes(task.status)
      || task.idempotencyKey !== `autonomy:${state.planId}:${task.id}`
      || (task.supervisorTaskId !== null && !/^task_[a-f0-9-]{36}$/.test(task.supervisorTaskId))
      || (["RUNNING", "VERIFYING", "VERIFIED"].includes(task.status)
        && (!Array.isArray(task.baseline)
          || task.baseline.length !== task.acceptance.length
          || task.baseline.some((item, index) => {
            const check = task.acceptance[index];
            if (check.kind === "command" || check.kind === "test") {
              return item?.kind !== check.kind || item.checkHash !== commandCheckHash(check);
            }
            if (check.kind === "integration") {
              return item?.kind !== "integration" || item.checkHash !== httpCheckHash(check);
            }
            return item?.path !== check.path
              || (item.sha256 !== null && !HASH.test(item.sha256));
          })))
      || (task.status === "VERIFIED" && !Array.isArray(task.evidence)))) {
      throw invalid("Invalid persisted task state.", "STATE_UNSAFE");
    }
    if (state.schema >= 2) {
      for (const task of state.tasks) {
        if (task.status === "VERIFIED") {
          assertVerificationReceipt(state, task);
        } else if (task.verificationReceipt != null) {
          throw invalid("Unverified task cannot carry a completed verification receipt.",
            "VERIFIER_EVIDENCE_INVALID");
        }
      }
    }
    // Checkpoints written before FV-06 did not declare whole-goal acceptance.
    // They may remain task-VERIFIED but can never inherit DELIVERED status.
    if (state.goalDelivery === undefined) {
      state.goalDelivery = {
        status: "UNVERIFIED", acceptance: [], verificationStarted: false,
        evidence: null, receipt: null, error: null,
      };
    } else {
      const delivery = state.goalDelivery;
      if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)
        || !["UNVERIFIED", "PENDING", "DELIVERED", "BLOCKED"].includes(delivery.status)
        || !Array.isArray(delivery.acceptance)
        || typeof delivery.verificationStarted !== "boolean"
        || (delivery.status === "UNVERIFIED"
          ? delivery.acceptance.length !== 0 || delivery.evidence !== null
            || delivery.receipt !== null
          : delivery.acceptance.length === 0)
        || (delivery.status === "DELIVERED"
          && (state.status !== "VERIFIED" || delivery.verificationStarted))
        || (state.status === "VERIFIED"
          && !["DELIVERED", "UNVERIFIED"].includes(delivery.status))
        || (delivery.status === "BLOCKED" && state.status !== "BLOCKED")
        || (state.status === "BLOCKED" && delivery.status === "DELIVERED")
        || (delivery.status === "PENDING"
          && (delivery.evidence !== null || delivery.receipt !== null))
        || (delivery.status !== "DELIVERED" && delivery.receipt !== null)) {
        throw invalid("Invalid persisted goal delivery state.", "STATE_UNSAFE");
      }
      const normalized = validateTaskPlan({
        goal: state.goal, tasks: state.tasks,
        ...(delivery.acceptance.length ? { finalAcceptance: delivery.acceptance } : {}),
      }).finalAcceptance ?? [];
      if (JSON.stringify(normalized) !== JSON.stringify(delivery.acceptance)) {
        throw invalid("Persisted final acceptance differs from approved checks.", "STATE_UNSAFE");
      }
      if (delivery.status === "DELIVERED") assertGoalReceipt(state);
    }
    try {
      state.repairBudget = validateRepairBudget(state.repairBudget);
    } catch {
      throw invalid("Invalid persisted repair budget.", "STATE_UNSAFE");
    }
    state.repairSubtask ??= null;
    state.repairExecution ??= null;
    if (state.repairSubtask !== null) {
      try {
        const taskId = state.repairSubtask.sourceSupervisorTaskId;
        assertRepairSubtask(state, state.repairSubtask, supervisor.get(taskId));
      } catch {
        throw invalid("Invalid persisted repair subtask.", "STATE_UNSAFE");
      }
    }
    if (state.repairExecution !== null) {
      try {
        assertRepairExecution(state, state.repairExecution, supervisor);
      } catch {
        throw invalid("Invalid persisted repair execution.", "STATE_UNSAFE");
      }
    }
    annotateCheckpointFailures(state);
    return new TaskCoordinator({ stateFile: file, workspaceRoot: root, workspaceId, supervisor, state });
  }

  getState() {
    return snapshot(this.state);
  }

  getDeliveryReport() {
    return buildDeliveryReport(this.state);
  }

  /**
   * Revisioned DAG replacement, restricted to never-started TODO nodes.
   * Already running or verified work retains its exact task definition.
   * The revision lock serializes independent Coordinator revision writers.
   */
  revisePlan({ expectedRevision, tasks } = {}) {
    const action = this.mutations.catch(() => {}).then(async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
          || !Array.isArray(tasks)) {
        throw invalid("A nonnegative expected revision and complete task DAG are required.",
          "PLAN_REVISION_INVALID");
      }
      if (this.state.status !== "RUNNING"
          || this.state.repairSubtask !== null
          || this.state.repairExecution !== null) {
        throw invalid("Plan changes require an active, unrepaired checkpoint.",
          "PLAN_REVISION_BLOCKED");
      }
      if (this.state.investigation?.monitor.budgetExhausted) {
        throw invalid("Investigation replan budget exhausted; intervention required.",
          "PLAN_REVISION_BLOCKED");
      }
      if (this.state.investigation?.monitor.replanRequired) {
        const pending = this.state.investigation;
        const supervisorTask = this.supervisor.get(pending.supervisorTaskId);
        if (supervisorTask.status !== "paused"
            || pending.revisionAtTrigger !== expectedRevision) {
          throw invalid("The stalled Worker must be safely paused before replanning.",
            "PLAN_REVISION_BLOCKED");
        }
      }
      if (expectedRevision !== this.state.planRevision) {
        throw invalid("Expected plan revision is stale.", "PLAN_REVISION_CONFLICT");
      }

      const checked = validateTaskPlan({ goal: this.state.goal, tasks });
      const updated = new Map(checked.tasks.map(task => [task.id, task]));
      for (const existing of this.state.tasks) {
        if (existing.status !== "TODO") {
          const requested = updated.get(existing.id);
          const immutable = {
            id: existing.id, instruction: existing.instruction,
            dependsOn: existing.dependsOn, acceptance: existing.acceptance,
          };
          if (!requested || JSON.stringify(requested) !== JSON.stringify(immutable)) {
            throw invalid("Started and verified task definitions are immutable.",
              "PLAN_REVISION_IMMUTABLE");
          }
        } else if (existing.supervisorTaskId !== null
            || existing.baseline !== null || existing.evidence !== null
            || existing.verificationReceipt !== null || existing.error !== null
            || existing.verificationStarted === true) {
          throw invalid("An incomplete task already contains execution evidence.",
            "PLAN_REVISION_IMMUTABLE");
        }
      }

      const existingById = new Map(this.state.tasks.map(task => [task.id, task]));
      const replacement = checked.tasks.map(task => {
        const prior = existingById.get(task.id);
        if (prior && prior.status !== "TODO") return prior;
        return {
          ...task, status: "TODO", supervisorTaskId: null,
          idempotencyKey: "autonomy:" + this.state.planId + ":" + task.id,
          baseline: null, evidence: null, verificationReceipt: null, error: null,
        };
      });
      if (this.state.planRevision === Number.MAX_SAFE_INTEGER) {
        throw invalid("Plan revision exhausted.", "PLAN_REVISION_INVALID");
      }

      const lockPath = this.stateFile + ".revision.lock";
      let lock;
      try {
        try {
          lock = await fs.open(lockPath, "wx", 0o600);
        } catch (error) {
          if (error?.code === "EEXIST") {
            throw invalid("Another plan revision is in progress.",
              "PLAN_REVISION_LOCKED");
          }
          throw error;
        }
        const disk = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
        if (disk.planId !== this.state.planId
            || (disk.planRevision ?? 0) !== expectedRevision
            || disk.status !== this.state.status
            || JSON.stringify(disk.tasks) !== JSON.stringify(this.state.tasks)
            || JSON.stringify(disk.investigation ?? null)
              !== JSON.stringify(this.state.investigation ?? null)) {
          throw invalid("Concurrent plan change or task advancement detected.",
            "PLAN_REVISION_CONFLICT");
        }
        const before = snapshot(this.state);
        this.state.tasks = replacement;
        this.state.planRevision = expectedRevision + 1;
        if (this.state.investigation?.monitor.replanRequired) {
          // Replanning never resets a started Worker or proof of its effects.
          // A separate explicit resume is required for a paused Worker.
          const m = this.state.investigation.monitor;
          m.replanRequired = false;
          m.readOnlyStreak = 0;
          m.activeRead = false;
          this.state.investigation.revisionAtTrigger = this.state.planRevision;
          this.state.investigation.pauseRequested = false;
        }
        try {
          await this.#save();
        } catch (error) {
          this.state = before;
          throw error;
        }
        return this.getState();
      } finally {
        if (lock) {
          await lock.close();
          await fs.rm(lockPath, { force: true });
        }
      }
    });
    this.mutations = action;
    return action;
  }



  /**
   * Atomically reserve the next attempt and prepare an evidence-backed repair.
   * This method never creates a Supervisor task or grants tool permissions.
   */
  prepareRepairSubtask() {
    const action = this.mutations.catch(() => {}).then(async () => {
      if (this.state.status !== "BLOCKED") {
        throw invalid("Repair requires a blocked checkpoint.", "REPAIR_NOT_BLOCKED");
      }
      if (this.state.repairSubtask !== null) {
        const existing = this.state.repairSubtask;
        assertRepairSubtask(this.state, existing,
          this.supervisor.get(existing.sourceSupervisorTaskId));
        return snapshot(existing);
      }
      const { budget, attempt } = reserveRepairAttempt(
        this.state.repairBudget, this.state.lastError,
      );
      const candidateState = { ...this.state, repairBudget: budget };
      const blockedTask = candidateState.tasks.find(task => task.status === "BLOCKED");
      const supervisorTask = blockedTask?.supervisorTaskId
        ? this.supervisor.get(blockedTask.supervisorTaskId) : null;
      const proposal = buildRepairSubtask(candidateState, {
        sequence: attempt.sequence,
        supervisorTask,
      });
      this.state.repairBudget = budget;
      this.state.repairSubtask = proposal;
      await this.#save();
      return snapshot(proposal);
    });
    this.mutations = action;
    return action;
  }

  /**
   * Reserve budget before any repair action. This API only records intent:
   * it never unblocks a task, launches a Worker, or requests approval.
   * A RESERVED attempt stays non-replayable after a crash.
   */

  /**
   * Start only an explicitly prepared repair. The original task remains
   * BLOCKED throughout execution; no normal tick can replay it.
   */
  repairTick() {
    const action = this.mutations.catch(() => {}).then(async () => {
      if (this.state.status !== "BLOCKED" || !this.state.repairSubtask) {
        throw invalid("An explicit prepared repair is required.", "REPAIR_NOT_PREPARED");
      }
      const proposal = this.state.repairSubtask;
      assertRepairSubtask(this.state, proposal,
        this.supervisor.get(proposal.sourceSupervisorTaskId));

      if (this.state.repairExecution === null) {
        this.state.repairExecution = {
          schema: 1, phase: "SUBMITTING",
          attemptSequence: proposal.attemptSequence,
          idempotencyKey: proposal.idempotencyKey,
          instruction: proposal.instruction,
          supervisorTaskId: null,
        };
        await this.#save();
      }
      let execution = this.state.repairExecution;
      assertRepairExecution(this.state, execution, this.supervisor);

      if (execution.phase === "SUBMITTING") {
        // Same instruction and durable key: Supervisor.create must deduplicate.
        // Never synthesize another key after an interrupted submission.
        const created = await this.supervisor.create({
          workspaceId: this.workspaceId,
          instruction: proposal.instruction,
          idempotencyKey: proposal.idempotencyKey,
        });
        if (!/^task_[a-f0-9-]{36}$/.test(created?.taskId ?? "")) {
          throw invalid("Invalid repair Supervisor response.", "REPAIR_SUPERVISOR_UNSAFE");
        }
        execution.supervisorTaskId = created.taskId;
        execution.phase = "RUNNING";
        await this.#save();
        assertRepairExecution(this.state, execution, this.supervisor);
      }
      const supervisorTask = this.supervisor.get(execution.supervisorTaskId);
      if (STOPPED.has(supervisorTask.status)) {
        return this.#finishFailedRepair("SUPERVISOR_" + supervisorTask.status.toUpperCase());
      }
      if (execution.phase === "RUNNING") {
        if (supervisorTask.status !== "completed") return this.getState();
        execution.phase = "VERIFYING";
        await this.#save();
      }
      if (supervisorTask.status !== "completed") {
        return this.#finishFailedRepair("SUPERVISOR_NOT_COMPLETED");
      }
      // Verification failures are repair failures. Persistence failures are not:
      // a failed checkpoint write must never settle the budget as FAILED.
      const original = this.state.tasks.find(t => t.id === proposal.sourceTaskId);
      let evidence;
      let receipt;
      try {
        for (const task of this.state.tasks) {
          if (task.status !== "VERIFIED") continue;
          if (this.state.schema >= 2) assertVerificationReceipt(this.state, task);
          await verifyArtifacts(this.workspaceRoot, task, task.evidence);
        }
        evidence = await verifyArtifacts(this.workspaceRoot, original);
        receipt = this.state.schema >= 2
          ? makeVerificationReceipt(this.state, original, evidence) : null;
      } catch (error) {
        return this.#finishFailedRepair(error?.code ?? "ARTIFACT_CHECK_FAILED");
      }

      const settledBudget = succeedRepairAttempt(this.state.repairBudget, {
        sequence: proposal.attemptSequence,
      });
      const beforeCommit = snapshot(this.state);
      original.evidence = evidence;
      original.verificationReceipt = receipt;
      original.status = "VERIFIED";
      original.error = null;
      original.verificationStarted = false;
      this.state.repairBudget = settledBudget;
      this.state.repairExecution = null;
      this.state.repairSubtask = null;
      this.state.status = "RUNNING";
      this.state.lastError = null;
      try {
        await this.#save();
      } catch (error) {
        // Keep this instance coherent with the last known persisted state.
        // A new process must reload before continuing if the write outcome
        // itself is uncertain; a matching Supervisor task is never replayed.
        this.state = beforeCommit;
        throw error;
      }
      return this.getState();
    });
    this.mutations = action;
    return action;
  }

  async #finishFailedRepair(errorCode) {
    const proposal = this.state.repairSubtask;
    const { budget } = failRepairAttempt(this.state.repairBudget, {
      sequence: proposal.attemptSequence, errorCode,
    });
    const original = this.state.tasks.find(t => t.id === proposal.sourceTaskId);
    original.status = "BLOCKED";
    original.error = errorCode;
    this.state.repairBudget = budget;
    this.state.repairExecution = null;
    this.state.repairSubtask = null;
    this.state.status = "BLOCKED";
    this.state.lastError = errorCode;
    await this.#save();
    return this.getState();
  }

  reserveRepair({ errorCode } = {}) {
    const action = this.mutations.catch(() => {}).then(async () => {
      if (this.state.status !== "BLOCKED") {
        throw invalid("Repair requires a blocked checkpoint.", "REPAIR_NOT_BLOCKED");
      }
      const budget = validateRepairBudget(this.state.repairBudget);
      const previous = budget.attempts.at(-1);
      const expectedCode = previous?.status === "FAILED"
        ? previous.resultCode : this.state.lastError;
      if (errorCode != null && errorCode !== expectedCode) {
        throw invalid("Repair failure identity mismatch.", "REPAIR_DIAGNOSTIC_MISMATCH");
      }
      const { budget: next, attempt } = reserveRepairAttempt(budget, expectedCode);
      this.state.repairBudget = next;
      await this.#save();
      return { attempt: snapshot(attempt), stopCode: repairStopReason(next) };
    });
    this.mutations = action;
    return action;
  }

  /**
   * Record an independently observed failure. This never retries it.
   * Permission and Supervisor state remain unchanged.
   */
  recordRepairFailure({ sequence, errorCode }) {
    const action = this.mutations.catch(() => {}).then(async () => {
      if (this.state.status !== "BLOCKED") {
        throw invalid("Repair requires a blocked checkpoint.", "REPAIR_NOT_BLOCKED");
      }
      if (this.state.repairExecution !== null) {
        throw invalid("Cannot manually settle an active repair.", "REPAIR_EXECUTION_ACTIVE");
      }
      const { budget, stopCode } = failRepairAttempt(this.state.repairBudget, {
        sequence, errorCode,
      });
      this.state.repairBudget = budget;
      this.state.repairSubtask = null;
      await this.#save();
      return { stopCode, budget: snapshot(budget) };
    });
    this.mutations = action;
    return action;
  }

  async #save() {
    if (this.state.investigation !== null) {
      this.state.investigation.monitor =
        validateInvestigationMonitor(this.state.investigation.monitor);
    }
    if (!Number.isSafeInteger(this.state.planRevision)
        || this.state.planRevision < 0) {
      throw invalid("Invalid plan revision.", "STATE_UNSAFE");
    }
    this.state.repairBudget = validateRepairBudget(this.state.repairBudget);
    annotateCheckpointFailures(this.state);
    if (this.state.repairSubtask != null) {
      const proposal = this.state.repairSubtask;
      assertRepairSubtask(this.state, proposal,
        this.supervisor.get(proposal.sourceSupervisorTaskId));
    }
    if (this.state.repairExecution !== null) {
      assertRepairExecution(this.state, this.state.repairExecution, this.supervisor);
    }
    await persist(this.stateFile, this.state);
  }

  async #finishVerifiedTasks() {
    if (!this.state.tasks.every((task) => task.status === "VERIFIED")) {
      throw invalid("Cannot finish a goal before every task is verified.", "STATE_UNSAFE");
    }
    const delivery = this.state.goalDelivery;
    if (!delivery?.acceptance.length) {
      // Legacy plans remain task-complete, never goal-delivered.
      this.state.status = "VERIFIED";
      await this.#save();
      return this.getState();
    }
    try {
      if (delivery.status === "DELIVERED") {
        assertGoalReceipt(this.state);
        await verifyArtifacts(this.workspaceRoot, {
          acceptance: delivery.acceptance, baseline: delivery.baseline,
        }, delivery.evidence);
        this.state.status = "VERIFIED";
        return this.getState();
      }
      if (delivery.status !== "PENDING" || delivery.verificationStarted) {
        throw invalid("Final verification was interrupted or its outcome is unknown.",
          "GOAL_COMPLETION_UNKNOWN");
      }
      delivery.baseline = await captureBaseline(this.workspaceRoot, {
        acceptance: delivery.acceptance,
      });
      // Commit the no-replay boundary BEFORE running any test or HTTP probe.
      delivery.verificationStarted = true;
      await this.#save();
      delivery.evidence = await verifyArtifacts(this.workspaceRoot, {
        acceptance: delivery.acceptance, baseline: delivery.baseline,
      });
      delivery.status = "DELIVERED";
      delivery.receipt = makeGoalReceipt(this.state);
      delivery.verificationStarted = false;
      delivery.error = null;
      this.state.status = "VERIFIED";
      this.state.lastError = null;
      await this.#save();
    } catch (error) {
      delivery.status = "BLOCKED";
      delivery.error = error.code ?? "GOAL_VERIFICATION_FAILED";
      this.state.status = "BLOCKED";
      this.state.lastError = delivery.error;
      await this.#save();
    }
    return this.getState();
  }


  /**
   * Observe only sanitized, durable Supervisor tool events. This never
   * executes tools, verifies artifacts, or declares task success. The
   * persisted pending request survives a crash before/while pausing.
   */
  async #observeInvestigation(active, supervisorTask) {
    if (typeof this.supervisor.getEvents !== "function"
        || typeof this.supervisor.pause !== "function"
        || active.status !== "RUNNING"
        || !active.supervisorTaskId) return false;
    let record = this.state.investigation;
    if (record?.supervisorTaskId !== active.supervisorTaskId) {
      const budgetUsed = record?.monitor?.replanCount ?? 0;
      const monitor = initialInvestigationMonitor();
      monitor.replanCount = Math.min(MAX_STALL_REPLANS, budgetUsed);
      record = {
        taskId: active.id, supervisorTaskId: active.supervisorTaskId,
        monitor, revisionAtTrigger: this.state.planRevision,
        pauseRequested: false,
      };
      this.state.investigation = record;
      await this.#save();
    }
    if (!record.monitor.replanRequired && !record.monitor.budgetExhausted
        && supervisorTask.status !== "completed") {
      const events = await this.supervisor.getEvents(active.supervisorTaskId,
        record.monitor.lastSeq);
      if (events.length) {
        record.monitor = observeInvestigationEvents(record.monitor, events);
        if (record.monitor.replanRequired) {
          record.revisionAtTrigger = this.state.planRevision;
        }
        await this.#save();
      }
    }
    if ((record.monitor.replanRequired || record.monitor.budgetExhausted)
        && supervisorTask.status === "completed") {
      // A Worker that has already finished must undergo normal independent
      // verification, not be reported as an investigation-only failure.
      record.monitor.replanRequired = false;
      record.monitor.budgetExhausted = false;
      record.monitor.readOnlyStreak = 0;
      record.monitor.activeRead = false;
      await this.#save();
      return false;
    }
    if (!record.monitor.replanRequired && !record.monitor.budgetExhausted) return false;

    // Intent is saved BEFORE pause. Repeated calls only issue an idempotent
    // pause if the Supervisor is still in a pausable state.
    if (!record.pauseRequested
        && ["running", "waiting_approval", "queued",
          "waiting_retry", "interrupted"].includes(supervisorTask.status)) {
      await this.supervisor.pause(active.supervisorTaskId);
      record.pauseRequested = true;
      await this.#save();
    }
    return true;
  }

  async #advance({ resumePaused = false } = {}) {
    if (this.state.status === "BLOCKED") return this.getState();
    // Even a completed plan must revalidate its persisted evidence on resume.
    // A VERIFIED status alone is never sufficient proof of artifact integrity.
    for (const task of this.state.tasks) {
      if (task.status === "VERIFIED") {
        try {
          if (this.state.schema >= 2) {
            assertVerificationReceipt(this.state, task);
          }
          await verifyArtifacts(this.workspaceRoot, task, task.evidence);
        } catch (error) {
          if (this.state.goalDelivery?.status === "DELIVERED") {
            this.state.goalDelivery.status = "BLOCKED";
            this.state.goalDelivery.receipt = null;
            this.state.goalDelivery.error = error.code ?? "ARTIFACT_DRIFT";
          }
          this.state.status = "BLOCKED";
          this.state.lastError = error.code ?? "ARTIFACT_DRIFT";
          await this.#save();
          return this.getState();
        }
      }
    }

    if (this.state.goalDelivery?.status === "DELIVERED") {
      try {
        assertGoalReceipt(this.state);
        await verifyArtifacts(this.workspaceRoot, {
          acceptance: this.state.goalDelivery.acceptance,
          baseline: this.state.goalDelivery.baseline,
        }, this.state.goalDelivery.evidence);
      } catch (error) {
        this.state.goalDelivery.status = "BLOCKED";
        this.state.goalDelivery.receipt = null;
        this.state.goalDelivery.error = error.code ?? "GOAL_EVIDENCE_INVALID";
        this.state.status = "BLOCKED";
        this.state.lastError = this.state.goalDelivery.error;
        await this.#save();
        return this.getState();
      }
    }
    if (this.state.status === "VERIFIED") return this.getState();

    let active = this.state.tasks.find((task) => task.status === "RUNNING" || task.status === "VERIFYING");
    if (!active) {
      active = this.state.tasks.find((task) =>
        task.status === "TODO" && task.dependsOn.every((id) =>
          this.state.tasks.find((item) => item.id === id)?.status === "VERIFIED"));
      if (!active) {
        if (this.state.tasks.every((task) => task.status === "VERIFIED")) {
          return this.#finishVerifiedTasks();
        }
        this.state.status = "BLOCKED";
        this.state.lastError = "UNSATISFIED_DEPENDENCIES";
        await this.#save();
        return this.getState();
      }
      try {
        // Persist the pre-run baseline before Supervisor can start a Worker.
        // Recovery reuses this snapshot; it must never be recaptured mid-task.
        active.baseline = await captureBaseline(this.workspaceRoot, active);
      } catch (error) {
        active.status = "BLOCKED";
        active.error = error.code ?? "ARTIFACT_BASELINE_FAILED";
        this.state.status = "BLOCKED";
        this.state.lastError = active.error;
        await this.#save();
        return this.getState();
      }
      active.status = "RUNNING";
      await this.#save();
    }

    if (active.status === "RUNNING" && !active.supervisorTaskId) {
      // The stable key survives a crash between Supervisor.create and saving
      // its returned ID. Replaying create is safe only because Supervisor
      // durably deduplicates this key and exact instruction.
      const created = await this.supervisor.create({
        workspaceId: this.workspaceId,
        instruction: active.instruction,
        idempotencyKey: active.idempotencyKey,
      });
      active.supervisorTaskId = created.taskId;
      await this.#save();
    }

    if (active.status === "RUNNING" || active.status === "VERIFYING") {
      let supervisorTask = active.supervisorTaskId
        ? this.supervisor.get(active.supervisorTaskId) : null;
      if (!supervisorTask
        || supervisorTask.taskId !== active.supervisorTaskId
        || supervisorTask.idempotencyKey !== active.idempotencyKey
        || supervisorTask.instruction !== active.instruction
        || supervisorTask.workspaceId !== this.workspaceId
        || supervisorTask.workspaceRoot !== this.workspaceRoot) {
        active.status = "BLOCKED";
        active.error = "SUPERVISOR_IDENTITY_MISMATCH";
        this.state.status = "BLOCKED";
        this.state.lastError = active.error;
        await this.#save();
        return this.getState();
      }
      if (active.status === "VERIFYING" && supervisorTask.status !== "completed") {
        active.status = "BLOCKED";
        active.error = "SUPERVISOR_NOT_COMPLETED";
        this.state.status = "BLOCKED";
        this.state.lastError = active.error;
        await this.#save();
        return this.getState();
      }
      // Pending replan is a separate control-plane state, not a failed task.
      // In particular, Supervisor.paused must never be classified as STOPPED
      // until the plan has been revised and explicitly resumed.
      if (active.status === "RUNNING"
          && this.state.investigation?.supervisorTaskId === active.supervisorTaskId
          && (this.state.investigation.monitor.replanRequired
            || this.state.investigation.monitor.budgetExhausted)) {
        if (await this.#observeInvestigation(active, supervisorTask)) {
          return this.getState();
        }
      }
      // Only an explicit CLI resume may restart an existing paused task.
      // Identity and previously verified artifacts have already been checked.
      // Uncertain, failed, and cancelled work must not be restarted here.
      if (active.status === "RUNNING" && supervisorTask.status === "paused" && resumePaused) {
        await this.supervisor.resume(active.supervisorTaskId);
        supervisorTask = this.supervisor.get(active.supervisorTaskId);
      }
      if (active.status === "RUNNING" && STOPPED.has(supervisorTask.status)) {
        active.status = "BLOCKED";
        active.error = `SUPERVISOR_${supervisorTask.status.toUpperCase()}`;
        this.state.status = "BLOCKED";
        this.state.lastError = active.error;
        await this.#save();
        return this.getState();
      }
      if (active.status === "RUNNING") {
        if (await this.#observeInvestigation(active, supervisorTask)) {
          return this.getState(); // Pending replan is not task completion.
        }
        if (supervisorTask.status !== "completed") return this.getState();
        active.status = "VERIFYING";
        await this.#save();
      }
    }

    if (active.status === "VERIFYING") {
      try {
        if (active.verificationStarted) {
          throw invalid("Verification interrupted; previous command may have run.",
            "VERIFIER_COMPLETION_UNKNOWN");
        }
        if (active.acceptance.some((check) =>
            check.kind === "command" || check.kind === "test" || check.kind === "integration")) {
          // Persist before executing any project-controlled verification code.
          // A crash after this boundary must never replay a possibly executed command.
          active.verificationStarted = true;
          await this.#save();
        }
        active.evidence = await verifyArtifacts(this.workspaceRoot, active);
        if (this.state.schema >= 2) {
          active.verificationReceipt = makeVerificationReceipt(
            this.state, active, active.evidence);
        }
        active.status = "VERIFIED";
        active.verificationStarted = false;
        active.error = null;
      } catch (error) {
        active.status = "BLOCKED";
        active.error = error.code ?? "ARTIFACT_CHECK_FAILED";
        this.state.status = "BLOCKED";
        this.state.lastError = active.error;
      }
      await this.#save();
    }
    if (this.state.tasks.every((task) => task.status === "VERIFIED")) {
      return this.#finishVerifiedTasks();
    }
    return this.getState();
  }

  tick({ resumePaused = false } = {}) {
    const next = this.mutations.catch(() => {}).then(() => this.#advance({ resumePaused }));
    this.mutations = next;
    return next;
  }

  async run({ timeoutMs = 120000, pollMs = 20 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(pollMs) || pollMs < 1) {
      throw invalid("Invalid coordinator run budget.");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.tick();
      if (TERMINAL.has(state.status)
          || state.investigation?.monitor.replanRequired
          || state.investigation?.monitor.budgetExhausted) return state;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return this.getState(); // Timeout never implies completion or a retry.
  }
}
