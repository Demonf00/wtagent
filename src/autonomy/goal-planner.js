
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { replaceFileAtomic } from "../shared/atomic-write.js";
import { validateTaskPlan } from "./task-coordinator.js";

const ID = /^[a-f0-9-]{36}$/;
const TASK_ID = /^task_[a-f0-9-]{36}$/;
const TERMINAL_FAILURE = new Set(["blocked_uncertain", "failed", "cancelled", "interrupted"]);
const MAX_GOAL_BYTES = 8192;
const MAX_RESPONSE_BYTES = 256 * 1024;

function failure(message, code = "PLANNER_INVALID") {
  return Object.assign(new Error(message), { code });
}

function instructionFor(goal) {
  return `You are the planning stage of a local development agent. Your only job is to create a concrete, independently verifiable implementation plan for the user goal below.

DO NOT call tools, inspect files, modify code, claim work is done, or execute steps. Do not request permissions. Follow WTAgent's existing XML response protocol exactly. In the final <agent_response>, set <done>true</done> and place ONLY one valid JSON object inside the <message> CDATA content (no Markdown, no commentary, no code fences). Do not output raw JSON outside the XML envelope.

Required JSON structure:
{
  "goal": "COPY THE USER GOAL VERBATIM",
  "tasks": [
    {
      "id": "step_one",
      "instruction": "Concrete, self-contained instruction for a coding Worker",
      "dependsOn": [],
      "acceptance": [
        { "kind": "file", "path": "relative/path/from/workspace", "minBytes": 1 }
      ]
    }
  ]
}

Rules:
- Generate 1 to 8 tasks, in a sensible execution order, with dependencies.
- Each task must have specific, nonempty instructions and at least one real file artifact.
- Artifact paths must be workspace-relative using forward slashes, without ".." or absolute paths.
- Include verification and relevant tests in task instructions, but do not pretend the tests have passed.
- The final task should verify and integrate the deliverable with real evidence.
- Do not use a fabricated status, success claim, placeholders, or an acceptance artifact that is unrelated to the goal.
- Do not modify or execute anything while planning. Permissions are not yours to grant.
- If the goal cannot be decomposed into file-backed tasks, provide no fabricated plan; respond with JSON {"error":"UNSUPPORTED_GOAL"}.

USER GOAL:
${goal}`;
}

function parsePlan(message, goal) {
  if (typeof message !== "string" || !message.trim()
      || Buffer.byteLength(message, "utf8") > MAX_RESPONSE_BYTES) {
    throw failure("Planner returned no bounded JSON plan.", "PLANNER_OUTPUT_INVALID");
  }
  let value;
  try {
    value = JSON.parse(message.trim());
  } catch {
    throw failure("Planner response is not a single JSON object.", "PLANNER_OUTPUT_INVALID");
  }
  if (!value || Array.isArray(value) || typeof value !== "object" || value.error) {
    throw failure("Planner did not provide a supported task plan.", "PLANNER_OUTPUT_INVALID");
  }
  if (value.goal !== goal) {
    throw failure("Planner changed the requested goal.", "PLANNER_GOAL_MISMATCH");
  }
  return validateTaskPlan(value);
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFileAtomic(tmp, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export class GoalPlanner {
  constructor({ file, workspaceRoot, workspaceId, supervisor, state }) {
    Object.assign(this, { file, workspaceRoot, workspaceId, supervisor, state });
    this.pending = Promise.resolve();
  }

  static async create({ stateFile, workspaceRoot, workspaceId = "main", supervisor, goal }) {
    if (typeof goal !== "string" || !goal.trim()
        || Buffer.byteLength(goal, "utf8") > MAX_GOAL_BYTES
        || !supervisor?.create || !supervisor?.get) {
      throw failure("A bounded user goal and active Supervisor are required.");
    }
    const root = await fs.realpath(workspaceRoot);
    const file = path.resolve(`${stateFile}.planner.json`);
    if (file === root || file.startsWith(`${root}${path.sep}`)) {
      throw failure("Planner state must reside outside the workspace.");
    }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const state = {
      schema: 1, id, status: "PLANNING", workspaceRoot: root, workspaceId,
      goal, instruction: instructionFor(goal),
      idempotencyKey: `autonomy-planner:${id}`,
      supervisorTaskId: null, plan: null, lastError: null,
    };
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } catch (error) {
      if (error.code === "EEXIST") {
        throw failure("Planner state already exists. Resume it instead.", "STATE_EXISTS");
      }
      throw error;
    } finally {
      await handle?.close();
    }
    return new GoalPlanner({ file, workspaceRoot: root, workspaceId, supervisor, state });
  }

  static async load({ stateFile, workspaceRoot, workspaceId = "main", supervisor }) {
    if (!supervisor?.create || !supervisor?.get) {
      throw failure("An active Supervisor is required.");
    }
    const root = await fs.realpath(workspaceRoot);
    const file = path.resolve(`${stateFile}.planner.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESPONSE_BYTES + 10000) {
      throw failure("Unsafe planner checkpoint.", "STATE_UNSAFE");
    }
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    if (state.schema !== 1 || !ID.test(state.id ?? "")
        || !["PLANNING", "PLANNED", "BLOCKED"].includes(state.status)
        || state.workspaceRoot !== root || state.workspaceId !== workspaceId
        || typeof state.goal !== "string" || !state.goal.trim()
        || Buffer.byteLength(state.goal, "utf8") > MAX_GOAL_BYTES
        || state.instruction !== instructionFor(state.goal)
        || state.idempotencyKey !== `autonomy-planner:${state.id}`
        || (state.supervisorTaskId !== null && !TASK_ID.test(state.supervisorTaskId))
        || (state.status === "PLANNED" && !state.supervisorTaskId)
        || (state.status === "PLANNED" && JSON.stringify(validateTaskPlan(state.plan)) !== JSON.stringify(state.plan))) {
      throw failure("Planner checkpoint identity or plan invalid.", "STATE_UNSAFE");
    }
    return new GoalPlanner({ file, workspaceRoot: root, workspaceId, supervisor, state });
  }

  getState() { return structuredClone(this.state); }

  async #save() { await writeAtomic(this.file, this.state); }

  async #advance({ resumePaused = false } = {}) {
    if (this.state.status !== "PLANNING") return this.getState();
    if (!this.state.supervisorTaskId) {
      // A stable key protects against a crash after Supervisor.create()
      // succeeded but before its returned ID reached this checkpoint.
      const task = await this.supervisor.create({
        workspaceId: this.workspaceId,
        instruction: this.state.instruction,
        idempotencyKey: this.state.idempotencyKey,
      });
      this.state.supervisorTaskId = task.taskId;
      await this.#save();
    }
    let task = this.supervisor.get(this.state.supervisorTaskId);
    if (task.taskId !== this.state.supervisorTaskId
        || task.workspaceId !== this.workspaceId
        || task.workspaceRoot !== this.workspaceRoot
        || task.idempotencyKey !== this.state.idempotencyKey
        || task.instruction !== this.state.instruction) {
      this.state.status = "BLOCKED";
      this.state.lastError = "PLANNER_SUPERVISOR_IDENTITY_MISMATCH";
      await this.#save();
      return this.getState();
    }
    if (task.status === "paused" && resumePaused) {
      await this.supervisor.resume(task.taskId);
      task = this.supervisor.get(task.taskId);
    }
    if (TERMINAL_FAILURE.has(task.status) || task.status === "paused") {
      this.state.status = "BLOCKED";
      this.state.lastError = `PLANNER_SUPERVISOR_${task.status.toUpperCase()}`;
      await this.#save();
      return this.getState();
    }
    if (task.status !== "completed") return this.getState();
    try {
      this.state.plan = parsePlan(task.result?.message, this.state.goal);
      this.state.status = "PLANNED";
      this.state.lastError = null;
    } catch (error) {
      this.state.status = "BLOCKED";
      this.state.lastError = error.code ?? "PLANNER_OUTPUT_INVALID";
    }
    await this.#save();
    return this.getState();
  }

  tick(options = {}) {
    const next = this.pending.catch(() => {}).then(() => this.#advance(options));
    this.pending = next;
    return next;
  }
}
