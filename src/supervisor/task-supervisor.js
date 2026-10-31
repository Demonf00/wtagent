import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AgentSession } from "../session/agent-session.js";
import { DEFAULT_PROVIDER, resolveProvider } from "../browser/provider-registry.js";
import { replaceFileAtomic } from "../shared/atomic-write.js";
import { executeConversationTurn } from "../runtime/conversation-runner.js";
import { TaskControl } from "./task-control.js";
import { SupervisorApprovalProvider } from "./approval-provider.js";
import { runWorkerProcess } from "./worker-client.js";
import {
  recoveryOptions, retryDelay, inspectCheckpoint, incidentSummary,
  safeRuntimeEvent,
} from "./recovery-controller.js";

const STATES = new Set([
  "queued", "running", "recovering", "waiting_retry", "blocked_uncertain",
  "waiting_approval", "pausing", "paused", "cancelling", "cancelled",
  "interrupted", "completed", "failed",
]);
const TERMINAL = new Set(["cancelled", "completed"]);
const TASK_ID = /^task_[a-f0-9-]{36}$/;
const WORKSPACE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_KEY_MAX = 128;

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializable(record) {
  return structuredClone(record);
}

async function atomicJson(file, value) {
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

async function safeRegularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw fail("Supervisor storage contains an unsafe file.", "STORAGE_UNSAFE");
  }
}

function requestFingerprint(workspaceId, instruction, provider) {
  return createHash("sha256")
    .update(JSON.stringify({ workspaceId, instruction, provider }))
    .digest("hex");
}

function now() {
  return new Date().toISOString();
}

function quietRenderer() {
  return {
    handle() {}, stopSpinner() {}, finish() {}, hint() {},
    println() {},
  };
}

export class TaskSupervisor {
  constructor({
    dataDir,
    sessionsDir,
    workspaces,
    options = {},
    execute = executeConversationTurn,
    adapterFactory = null,
    autoRun = true,
  }) {
    if (!dataDir || !sessionsDir) throw fail("Supervisor requires dataDir and sessionsDir.");
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw fail("At least one configured workspace is required.");
    }
    this.dataDir = path.resolve(dataDir);
    this.sessionsDir = path.resolve(sessionsDir);
    this.workspacesConfig = workspaces;
    this.workspaces = new Map();
    this.options = options;
    this.recoverySettings = recoveryOptions(options);
    this.retryTimer = null;
    this.fatalError = null;
    this.execute = execute;
    this.adapterFactory = adapterFactory;
    // Production work executes in a separate OS process. Injected runners
    // preserve the previous in-process test/extension contract.
    this.useWorkerProcess = execute === executeConversationTurn && !adapterFactory;
    this.autoRun = autoRun;
    this.tasks = new Map();
    this.events = new Map();
    this.current = null;
    this.worker = null;
    this.closed = false;
    this.initialized = false;
    this.mutations = Promise.resolve();
  }

  async init() {
    if (this.initialized) return this;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    const seen = new Set();
    for (const entry of this.workspacesConfig) {
      if (!entry || !WORKSPACE_ID.test(entry.id) || typeof entry.root !== "string"
          || seen.has(entry.id) || !path.isAbsolute(entry.root)) {
        throw fail("Configured workspaces need unique IDs and absolute root paths.");
      }
      seen.add(entry.id);
      const stat = await fs.stat(entry.root);
      if (!stat.isDirectory()) throw fail(`Workspace ${entry.id} is not a directory.`);
      this.workspaces.set(entry.id, await fs.realpath(entry.root));
    }
    const names = await fs.readdir(this.dataDir);
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || !name.startsWith("task_")) continue;
      const taskId = name.slice(0, -5);
      if (!TASK_ID.test(taskId)) throw fail("Invalid task filename in supervisor storage.", "STORAGE_UNSAFE");
      const file = path.join(this.dataDir, name);
      await safeRegularFile(file);
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      if (record.taskId !== taskId || !STATES.has(record.status)
          || !this.workspaces.has(record.workspaceId)
          || record.workspaceRoot !== this.workspaces.get(record.workspaceId)
          || !/^[a-zA-Z0-9_-]+$/.test(record.sessionId)) {
        throw fail(`Task ${taskId} has invalid persisted identity.`, "STORAGE_UNSAFE");
      }
      this.tasks.set(taskId, record);
      if (["running", "recovering", "waiting_approval", "pausing",
        "cancelling", "interrupted"].includes(record.status)) {
        if (record.status === "cancelling") {
          await this.#transition(record, "cancelled", { pendingApproval: null });
        } else if (record.status === "pausing") {
          await this.#transition(record, "paused", { pendingApproval: null });
        } else {
          await this.#recoverAfterFailure(record, { code: "WORKER_EXITED" }, "exited");
        }
      }
      if (record.status === "waiting_retry" && !Number.isFinite(Date.parse(record.retryAt))) {
        await this.#transition(record, "blocked_uncertain", {
          error: "INVALID_RETRY_CHECKPOINT", retryAt: null,
        });
      }
    }
    this.initialized = true;
    if (this.autoRun) this.#kick();
    return this;
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(serializable);
  }

  get(taskId) {
    if (!TASK_ID.test(taskId ?? "")) throw fail("Invalid task ID.");
    const record = this.tasks.get(taskId);
    if (!record) throw fail("Unknown task ID.", "NOT_FOUND");
    return serializable(record);
  }

  async getEvents(taskId, after = 0) {
    this.get(taskId);
    if (!Number.isSafeInteger(after) || after < 0) throw fail("Invalid event offset.");
    const file = this.#eventPath(taskId);
    try {
      await safeRegularFile(file);
      const source = await fs.readFile(file, "utf8");
      return source.split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .filter((item) => item.seq > after);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  #taskPath(taskId) {
    return path.join(this.dataDir, `${taskId}.json`);
  }

  #eventPath(taskId) {
    return path.join(this.dataDir, `${taskId}.events.jsonl`);
  }

  #mutate(operation) {
    const next = this.mutations.catch(() => {}).then(operation);
    this.mutations = next;
    return next;
  }

  async #recordEvent(record, type, payload = {}) {
    const event = {
      seq: (record.lastEventSeq ?? 0) + 1,
      taskId: record.taskId, sessionId: record.sessionId, timestamp: now(),
      type, payload,
    };
    // The sequence is persisted first. An interrupted append may leave a
    // sequence gap, which is safer than interpreting a partial entry as valid.
    record.lastEventSeq = event.seq;
    record.updatedAt = event.timestamp;
    await atomicJson(this.#taskPath(record.taskId), record);
    const eventFile = this.#eventPath(record.taskId);
    await fs.appendFile(eventFile, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 });
    return event;
  }

  async #transition(record, status, patch = {}, eventType = `task.${status}`) {
    if (!STATES.has(status)) throw fail("Invalid task state.");
    Object.assign(record, patch, { status });
    await this.#recordEvent(record, eventType, { status });
  }

  async #recoverAfterFailure(record, error, workerHealth = "unknown") {
    let state;
    try {
      const session = await AgentSession.load({
        sessionsDir: this.sessionsDir, sessionId: record.sessionId,
      });
      if (session.state.projectRoot !== record.workspaceRoot) {
        throw fail("Session workspace mismatch.", "STORAGE_UNSAFE");
      }
      state = session.state;
    } catch (loadError) {
      await this.#transition(record, "blocked_uncertain", {
        pendingApproval: null, retryAt: null,
        error: "SESSION_CHECKPOINT_UNAVAILABLE",
        incident: incidentSummary({
          error: loadError, reason: "SESSION_UNAVAILABLE",
          retries: record.retries ?? 0, workerHealth,
        }),
      });
      return;
    }

    let checkpoint = inspectCheckpoint(state);
 if (Number.isSafeInteger(record.startRunCount)
 && Number(state.runCount ?? 0) === record.startRunCount) {
 checkpoint = state.phase === "idle" && !state.pendingOutbound
 && !state.pendingAssistantTurn && !state.pendingAuxiliaryTurn
 ? { action: "retry", reason: "TURN_NOT_STARTED" }
 : checkpoint.action === "reconcile" ? checkpoint
 : { action: "block", reason: "NO_SAFE_RECOVERY_CHECKPOINT" };
 }
    const incident = incidentSummary({
      error, state, reason: checkpoint.reason,
      retries: record.retries ?? 0, workerHealth,
    });
    const base = { pendingApproval: null, retryAt: null, incident };
    if (checkpoint.action === "complete") {
      await this.#transition(record, "completed", {
        ...base, error: null,
        result: { sessionId: record.sessionId, message: state.lastMessage },
      });
      return;
    }
    if (checkpoint.action === "block") {
      await this.#transition(record, "blocked_uncertain", {
        ...base, error: checkpoint.reason,
      });
      return;
    }
    if (["STORAGE_UNSAFE", "BAD_REQUEST"].includes(error?.code)) {
      await this.#transition(record, "failed", {
        ...base, error: "NONRECOVERABLE_WORKER_ERROR",
      });
      return;
    }
    const retries = record.retries ?? 0;
    if (retries >= this.recoverySettings.maxRetries) {
      await this.#transition(record, "failed", {
        ...base, error: "RECOVERY_RETRY_LIMIT_REACHED",
      });
      return;
    }

    await this.#transition(record, "recovering", {
      ...base, error: null,
    });
    const nextRetries = retries + 1;
    const retryAt = new Date(Date.now()
      + retryDelay(nextRetries, this.recoverySettings)).toISOString();
    await this.#transition(record, "waiting_retry", {
      ...base, retries: nextRetries, retryAt, error: null,
    }, "task.retry_scheduled");
  }

  // CLI turns share a canonical AgentSession while retaining separate durable
// Supervisor records for worker ownership and safe recovery.
async enqueueSessionTurn({ workspaceId, sessionId, instruction = null, files = [] }) {
if (!this.initialized || this.closed) throw fail("Supervisor is not active.");
if (!WORKSPACE_ID.test(workspaceId ?? "") || !this.workspaces.has(workspaceId)) {
throw fail("Unknown configured workspace.");
}
if (!/^[a-zA-Z0-9_-]+$/.test(sessionId ?? "")) throw fail("Invalid session ID.");
if (instruction != null && (typeof instruction !== "string"
|| Buffer.byteLength(instruction, "utf8") > 65536)) {
throw fail("Invalid turn instruction.");
}
if (!Array.isArray(files) || files.some((file) =>
!file || typeof file.name !== "string" || typeof file.path !== "string")) {
throw fail("Invalid turn attachments.");
}
return this.#mutate(async () => {
const workspaceRoot = this.workspaces.get(workspaceId);
const session = await AgentSession.load({ sessionsDir: this.sessionsDir, sessionId });
if (await fs.realpath(session.state.projectRoot) !== workspaceRoot) {
throw fail("Session workspace mismatch.", "STORAGE_UNSAFE");
}
if ([...this.tasks.values()].some((item) => item.sessionId === sessionId
&& !["completed", "cancelled", "failed", "blocked_uncertain", "paused"].includes(item.status))) {
throw fail("Session already has an active Supervisor task.", "CONFLICT");
}
if ((session.state.pendingOutbound || session.state.pendingAssistantTurn
|| session.state.pendingAuxiliaryTurn) && (instruction?.trim() || files.length)) {
throw fail("Pending browser handoff requires a bare resume.", "CONFLICT");
}
const time = now();
const record = {
taskId: `task_${randomUUID()}`, sessionId, workspaceId, workspaceRoot,
instruction: instruction ?? "", files: structuredClone(files),
provider: session.state.provider ?? DEFAULT_PROVIDER, status: "queued",
 startRunCount: Number(session.state.runCount ?? 0),
createdAt: time, updatedAt: time, idempotencyKey: null,
requestFingerprint: null, pendingApproval: null, result: null,
error: null, lastEventSeq: 0, attempts: 0, retries: 0,
retryAt: null, incident: null,
};
await this.#recordEvent(record, "task.created", { status: record.status });
this.tasks.set(record.taskId, record);
this.#kick();
return serializable(record);
});
}

async create({ workspaceId, instruction, provider = DEFAULT_PROVIDER, idempotencyKey = null }) {
    if (!this.initialized || this.closed) throw fail("Supervisor is not active.");
    if (!WORKSPACE_ID.test(workspaceId ?? "") || !this.workspaces.has(workspaceId)) {
      throw fail("Unknown configured workspace.");
    }
    if (typeof instruction !== "string" || !instruction.trim()
        || Buffer.byteLength(instruction, "utf8") > 65536) {
      throw fail("Instruction must be non-empty and no larger than 64 KiB.");
    }
    if (idempotencyKey != null && (typeof idempotencyKey !== "string"
        || !idempotencyKey.trim() || idempotencyKey.length > ID_KEY_MAX)) {
      throw fail("Invalid idempotency key.");
    }
    const providerId = resolveProvider(provider).id;
    const fingerprint = requestFingerprint(workspaceId, instruction, providerId);
    return this.#mutate(async () => {
      if (idempotencyKey != null) {
        const match = [...this.tasks.values()].find((item) => item.idempotencyKey === idempotencyKey);
        if (match) {
          if (match.requestFingerprint !== fingerprint) {
            throw fail("Idempotency key already used for a different request.", "CONFLICT");
          }
          return serializable(match);
        }
      }
      const workspaceRoot = this.workspaces.get(workspaceId);
      const session = await AgentSession.create({
        sessionsDir: this.sessionsDir, task: instruction,
        projectRoot: workspaceRoot, provider: providerId, generationType: "agent",
      });
      const time = now();
      const record = {
        taskId: `task_${randomUUID()}`,
        sessionId: session.sessionId,
        workspaceId,
        workspaceRoot,
        instruction,
        provider: providerId,
        status: "queued",
        startRunCount: 0,
        createdAt: time,
        updatedAt: time,
        idempotencyKey,
        requestFingerprint: fingerprint,
        pendingApproval: null,
        result: null,
        error: null,
        lastEventSeq: 0,
        attempts: 0,
        retries: 0,
        retryAt: null,
        incident: null,
      };
      await this.#recordEvent(record, "task.created", { status: record.status });
      this.tasks.set(record.taskId, record);
      this.#kick();
      return serializable(record);
    });
  }

  #kick() {
    if (!this.autoRun || !this.initialized || this.closed || this.worker) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const time = Date.now();
    const ready = [...this.tasks.values()].some((item) =>
      item.status === "queued"
      || (item.status === "waiting_retry" && Date.parse(item.retryAt) <= time));
    if (!ready) {
      const deadlines = [...this.tasks.values()]
        .filter((item) => item.status === "waiting_retry")
        .map((item) => Date.parse(item.retryAt))
        .filter(Number.isFinite);
      if (deadlines.length) {
        const delay = Math.max(1, Math.min(2_147_483_647, Math.min(...deadlines) - time));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.#kick();
        }, delay);
        this.retryTimer.unref?.();
      }
      return;
    }
    this.worker = this.#drain()
      .catch((error) => {
        // Persistence errors must not cause an unbounded drain/restart loop.
        this.fatalError = error;
        this.autoRun = false;
      })
      .finally(() => {
        this.worker = null;
        if (!this.closed && this.autoRun) this.#kick();
      });
  }

  async #drain() {
    while (!this.closed) {
      const time = Date.now();
      const next = [...this.tasks.values()]
        .filter((item) => item.status === "queued"
          || (item.status === "waiting_retry" && Date.parse(item.retryAt) <= time))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return;
      if (next.status === "waiting_retry") {
        await this.#mutate(async () => {
          if (next.status !== "waiting_retry"
              || Date.parse(next.retryAt) > Date.now()) return;
          await this.#transition(next, "queued", { retryAt: null }, "task.retry_ready");
        });
        continue;
      }
      await this.#runOne(next);
    }
  }

  async #runOne(record) {
    const control = new TaskControl();
    const approvalProvider = new SupervisorApprovalProvider({
      control,
      onRequired: async (pendingApproval) => {
        await this.#mutate(() => this.#transition(record, "waiting_approval",
          { pendingApproval }, "approval.required"));
      },
    });
    this.current = {
      taskId: record.taskId, control, approvalProvider,
      lastProgressAt: Date.now(), workerPid: null,
    };
    try {
      // A queued task can be paused/cancelled after #drain selects it but
      // before this mutation is processed. Start only from a runnable state.
      const started = await this.#mutate(async () => {
        if (this.closed || record.status !== "queued") return false;
        await this.#transition(record, "running", {
          attempts: record.attempts + 1, pendingApproval: null, error: null,
        });
        return true;
      });
      if (!started) return;
      const session = await AgentSession.load({
        sessionsDir: this.sessionsDir, sessionId: record.sessionId,
      });
      if (session.state.projectRoot !== record.workspaceRoot) {
        throw fail("Session workspace no longer matches the configured workspace.", "STORAGE_UNSAFE");
      }
      if (!record.instruction && !(record.files?.length)
 && session.state.phase === "idle" && session.state.lastMessage
          && session.state.runCount > 0 && !session.state.pendingOutbound
          && !session.state.pendingAssistantTurn && !session.state.pendingAuxiliaryTurn) {
        await this.#mutate(() => this.#transition(record, "completed", {
          result: { sessionId: record.sessionId, message: session.state.lastMessage },
        }));
        return;
      }
      const onEvent = async (event) => {
        if (this.current?.taskId === record.taskId) {
          this.current.lastProgressAt = Date.now();
        }
        // Do not persist arbitrary model/browser text, tool arguments or
        // screenshots into Supervisor diagnostics.
        if (event?.type === "model.streaming") return;
        const sanitized = safeRuntimeEvent(event);
        await this.#mutate(async () => {
          await this.#recordEvent(record, sanitized.type, sanitized.payload);
        });
      };
      const result = this.useWorkerProcess
        ? await runWorkerProcess({
          sessionsDir: this.sessionsDir,
          sessionId: record.sessionId,
          workspaceRoot: record.workspaceRoot,
          instruction: Number.isSafeInteger(record.startRunCount)
           && Number(session.state.runCount ?? 0) > record.startRunCount
           ? null : record.instruction || null,
          files: Number.isSafeInteger(record.startRunCount)
           && Number(session.state.runCount ?? 0) > record.startRunCount
           ? [] : record.files ?? [],
          options: this.options,
          settings: this.recoverySettings,
          control, approvalProvider, onEvent,
          isWaitingApproval: () => record.status === "waiting_approval",
          onStart: (pid) => {
            if (this.current?.taskId === record.taskId) {
              this.current.workerPid = pid;
// Retained in the next durable task transition; proves a real
// worker subprocess was started without storing model content.
record.workerPid = pid;
            }
          },
        })
        : await this.execute({
          session,
          options: this.options,
          resume: session.state.runCount > 0,
          instruction: Number.isSafeInteger(record.startRunCount)
           && Number(session.state.runCount ?? 0) > record.startRunCount
           ? null : record.instruction || null,
          files: Number.isSafeInteger(record.startRunCount)
           && Number(session.state.runCount ?? 0) > record.startRunCount
           ? [] : record.files ?? [],
          approvalProvider,
          control,
          renderer: quietRenderer(),
          adapter: this.adapterFactory ? await this.adapterFactory(record) : undefined,
          onEvent,
        });
      control.checkpoint();
      if (result?.recoveryRequired || result?.cancelled || !result?.message) {
        await this.#mutate(() => this.#recoverAfterFailure(
          record, result?.error ?? { code: "INCOMPLETE_EXECUTION" },
        ));
      } else {
        await this.#mutate(() => this.#transition(record, "completed", {
          result: { sessionId: record.sessionId, message: result.message },
        }));
      }
    } catch (error) {
      const status = error?.code === "TASK_CANCELLED" ? "cancelled"
        : error?.code === "TASK_PAUSED" ? "paused" : null;
      if (status) {
        await this.#mutate(() => this.#transition(record, status, {
          pendingApproval: null, error: null,
        }));
      } else {
        await this.#mutate(() => this.#recoverAfterFailure(record, error));
      }
    } finally {
      this.current = null;
    }
  }

  async pause(taskId) {
    const record = this.tasks.get(this.get(taskId).taskId);
    return this.#mutate(async () => {
      if (record.status === "paused" || record.status === "pausing") return serializable(record);
      if (["queued", "waiting_retry", "interrupted", "failed"].includes(record.status)) {
        await this.#transition(record, "paused", {
          pendingApproval: null, retryAt: null,
        });
      } else if (record.status === "running" || record.status === "waiting_approval") {
        await this.#transition(record, "pausing", { pendingApproval: null });
        this.current?.taskId === taskId && this.current.control.request("pause");
      } else throw fail("Task cannot be paused in its current state.", "CONFLICT");
      return serializable(record);
    });
  }

  async resume(taskId) {
    const record = this.tasks.get(this.get(taskId).taskId);
    return this.#mutate(async () => {
      if (record.status === "queued") return serializable(record);
      if (!["paused", "interrupted", "failed"].includes(record.status)) {
        throw fail("Task cannot be resumed in its current state.", "CONFLICT");
      }
      await this.#transition(record, "queued", {
        pendingApproval: null, error: null,
      });
      this.#kick();
      return serializable(record);
    });
  }

  async cancel(taskId) {
    const record = this.tasks.get(this.get(taskId).taskId);
    return this.#mutate(async () => {
      if (record.status === "cancelled" || record.status === "cancelling") return serializable(record);
      if (record.status === "completed") throw fail("Completed task cannot be cancelled.", "CONFLICT");
      if (["queued", "waiting_retry", "blocked_uncertain",
        "paused", "interrupted", "failed"].includes(record.status)) {
        await this.#transition(record, "cancelled", {
          pendingApproval: null, retryAt: null,
        });
      } else {
        await this.#transition(record, "cancelling", { pendingApproval: null });
        this.current?.taskId === taskId && this.current.control.request("cancel");
      }
      return serializable(record);
    });
  }

  async decide(taskId, requestId, decision) {
    const record = this.tasks.get(this.get(taskId).taskId);
    if (decision !== "approve" && decision !== "deny") throw fail("Decision must be approve or deny.");
    return this.#mutate(async () => {
      if (record.status !== "waiting_approval" || record.pendingApproval?.requestId !== requestId
          || this.current?.taskId !== taskId
          || this.current.approvalProvider.pending?.requestId !== requestId) {
        throw fail("Approval is not currently pending.", "CONFLICT");
      }
      await this.#transition(record, "running", { pendingApproval: null }, "approval.decided");
      this.current.approvalProvider.decide(requestId, decision);
      return serializable(record);
    });
  }

  async close() {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.current) this.current.control.request("pause");
    if (this.worker) await this.worker;
  }
}
