
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { replaceFileAtomic } from "../shared/atomic-write.js";

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
      if (!check || check.kind !== "file") {
        throw invalid("Only file artifact checks are supported in this version.");
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
  return { goal: input.goal, tasks };
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
}

async function captureBaseline(root, task) {
  const baseline = [];
  for (const check of task.acceptance) {
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
  for (const check of task.acceptance) {
    const proof = await artifactEvidence(root, check);
    const baseline = task.baseline?.find((item) => item.path === check.path);
    if (!baseline) {
      throw invalid(`Missing persisted artifact baseline: ${check.path}`, "STATE_UNSAFE");
    }
    if (!check.sha256 && baseline.sha256 !== null && baseline.sha256 === proof.sha256) {
      throw invalid(`Artifact unchanged since task submission: ${check.path}`, "ARTIFACT_UNCHANGED");
    }
    const prior = evidence?.find((item) => item.path === check.path);
    if (evidence && (!prior || prior.sha256 !== proof.sha256 || prior.bytes !== proof.bytes)) {
      throw invalid(`Verified artifact changed: ${check.path}`, "ARTIFACT_DRIFT");
    }
    results.push(proof);
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
      schema: 1, planId, workspaceRoot: root, workspaceId,
      goal: checked.goal, status: "RUNNING", lastError: null,
      tasks: checked.tasks.map((task) => ({
        ...task, status: "TODO", supervisorTaskId: null,
        idempotencyKey: `autonomy:${planId}:${task.id}`,
        baseline: null, evidence: null, error: null,
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
    if (state.schema !== 1 || state.workspaceRoot !== root
      || state.workspaceId !== workspaceId
      || !/^[a-f0-9-]{36}$/.test(state.planId ?? "")
      || !Array.isArray(state.tasks)) {
      throw invalid("Coordinator checkpoint identity mismatch.", "STATE_UNSAFE");
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
          || task.baseline.some((item, index) =>
            item?.path !== task.acceptance[index].path
            || (item.sha256 !== null && !HASH.test(item.sha256)))))
      || (task.status === "VERIFIED" && !Array.isArray(task.evidence)))) {
      throw invalid("Invalid persisted task state.", "STATE_UNSAFE");
    }
    return new TaskCoordinator({ stateFile: file, workspaceRoot: root, workspaceId, supervisor, state });
  }

  getState() {
    return snapshot(this.state);
  }

  async #save() {
    await persist(this.stateFile, this.state);
  }

  async #advance({ resumePaused = false } = {}) {
    if (this.state.status === "BLOCKED") return this.getState();
    // Even a completed plan must revalidate its persisted evidence on resume.
    // A VERIFIED status alone is never sufficient proof of artifact integrity.
    for (const task of this.state.tasks) {
      if (task.status === "VERIFIED") {
        try {
          await verifyArtifacts(this.workspaceRoot, task, task.evidence);
        } catch (error) {
          this.state.status = "BLOCKED";
          this.state.lastError = error.code ?? "ARTIFACT_DRIFT";
          await this.#save();
          return this.getState();
        }
      }
    }

    if (this.state.status === "VERIFIED") return this.getState();

    let active = this.state.tasks.find((task) => task.status === "RUNNING" || task.status === "VERIFYING");
    if (!active) {
      active = this.state.tasks.find((task) =>
        task.status === "TODO" && task.dependsOn.every((id) =>
          this.state.tasks.find((item) => item.id === id)?.status === "VERIFIED"));
      if (!active) {
        this.state.status = this.state.tasks.every((task) => task.status === "VERIFIED")
          ? "VERIFIED" : "BLOCKED";
        this.state.lastError = this.state.status === "BLOCKED" ? "UNSATISFIED_DEPENDENCIES" : null;
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
        if (supervisorTask.status !== "completed") return this.getState();
        active.status = "VERIFYING";
        await this.#save();
      }
    }

    if (active.status === "VERIFYING") {
      try {
        active.evidence = await verifyArtifacts(this.workspaceRoot, active);
        active.status = "VERIFIED";
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
      this.state.status = "VERIFIED";
      await this.#save();
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
      if (TERMINAL.has(state.status)) return state;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return this.getState(); // Timeout never implies completion or a retry.
  }
}
