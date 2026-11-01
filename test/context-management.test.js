import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { TaskCoordinator } from "../src/autonomy/task-coordinator.js";
import {
  buildCanonicalContextManifest,
  MAX_CANONICAL_MANIFEST_BYTES,
} from "../src/context/canonical-manifest.js";
import { AgentSession } from "../src/session/agent-session.js";
import {
  contextSafety, contextPressure, buildContextHandoff,
  inspectSessionContext, prepareContextRotation,
} from "../src/context/context-manager.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-context-"));
  const projectRoot = path.join(root, "project");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(projectRoot);
  const session = await AgentSession.create({
    sessionsDir, projectRoot, task: "Build a small web app",
    provider: "chatgpt", generationType: "agent",
  });
  await session.update({
    phase: "idle", turn: 38, runCount: 2,
    lastMessage: "The app was created. Unit checks passed.",
    conversationUrl: "https://chatgpt.com/c/original-conversation",
    conversationTargetId: "target-original",
    followUps: [{ instruction: "Add unit tests" }],
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, projectRoot, sessionsDir, session };
}

test("heuristic context pressure is not misrepresented as provider token usage", () => {
  const state = { phase: "idle", lastMessage: "done", turn: 35 };
  const result = contextPressure(state, 200000);
  assert.equal(result.warning, true);
  assert.equal(result.rotationAllowed, true);
  assert.equal(result.estimatedTranscriptTokens, 50000);
  assert.equal(result.estimateOnly, true);
});

test("all pending outbound and tool checkpoints block rotation", () => {
  const base = { phase: "idle", lastMessage: "finished" };
  for (const field of [
    "pendingOutbound", "pendingAssistantTurn", "pendingAuxiliaryTurn",
    "pendingToolResult",
  ]) {
    assert.equal(contextSafety({ ...base, [field]: { id: "unfinished" } }).clean,
      false, field);
  }
  assert.equal(contextSafety({
    ...base, sideEffectTools: { operation: { status: "unknown" } },
  }).clean, false);
  assert.equal(contextSafety({ ...base, phase: "waiting_model" }).clean, false);
  assert.equal(contextSafety({ ...base, lastMessage: null }).clean, false);
});

test("finished clean context creates a new session without replaying browser identity", async (t) => {
  const { session, sessionsDir, projectRoot } = await fixture(t);
  const formerState = structuredClone(session.state);
  const { next, savedFile, pressure } = await prepareContextRotation({
    session, sessionsDir,
  });
  assert.equal(pressure.rotationAllowed, true);
  assert.notEqual(next.sessionId, session.sessionId);
  assert.equal(next.state.projectRoot, projectRoot);
  assert.equal(next.state.conversationUrl, null);
  assert.equal(next.state.conversationTargetId, null);
  assert.equal(next.state.pendingOutbound, null);
  assert.equal(next.state.pendingAssistantTurn, null);
  assert.equal(next.state.pendingToolResult, null);
  assert.deepEqual(next.state.sideEffectTools, {});
  assert.equal(next.state.previousContextSessionId, session.sessionId);
  assert.match(next.state.task, /Build a small web app/);
  assert.match(next.state.task, /Add unit tests/);
  assert.match(next.state.task, /Do not blindly replay/);
  assert.deepEqual(session.state, formerState);
  const saved = JSON.parse(await fs.readFile(savedFile, "utf8"));
  assert.equal(saved.previousSessionId, session.sessionId);
});

test("actual Session with unfinished browser handoff refuses to create next Session", async (t) => {
  const { session, sessionsDir } = await fixture(t);
  await session.update({ pendingOutbound: { outboundId: "pending" } });
  await assert.rejects(prepareContextRotation({ session, sessionsDir }),
    (error) => error.code === "CONTEXT_ROTATION_UNSAFE"
      && /PENDING_OUTBOUND/.test(error.message));
  const sessionDirs = await fs.readdir(sessionsDir);
  assert.equal(sessionDirs.length, 1);
});

test("active Supervisor task blocks a clean-looking Session rotation", async (t) => {
  const { session, sessionsDir } = await fixture(t);
  const supervisorDir = path.join(session.directory, "supervisor");
  await fs.mkdir(supervisorDir);
  const task = "task_01234567-89ab-cdef-0123-456789abcdef";
  await fs.writeFile(path.join(supervisorDir, task + ".json"),
    JSON.stringify({ status: "running" }));
  assert.deepEqual((await inspectSessionContext(session)).blockers,
    ["ACTIVE_SUPERVISOR_TASK"]);
  await assert.rejects(prepareContextRotation({ session, sessionsDir }),
    /ACTIVE_SUPERVISOR_TASK/);
});

test("bounded summaries never claim historical transcript is authoritative", async (t) => {
  const { session } = await fixture(t);
  await session.update({
    task: "X".repeat(5000),
    lastMessage: "Y".repeat(5000),
    followUps: Array.from({ length: 20 }, (_, i) => ({
      instruction: "Follow-up " + i + " " + "z".repeat(2000),
    })),
  });
  const pressure = contextPressure(session.state, 200000);
  const { summary, prompt } = buildContextHandoff(session.state, pressure);
  assert.equal(summary.originalGoal.length, 1800);
  assert.equal(summary.lastConfirmedAssistantMessage.length, 1600);
  assert.equal(summary.recentUserInstructions.length, 4);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 9000);
  assert.match(prompt, /not a verbatim history or proof/);
});


test("successive clean rotations preserve the original goal instead of nesting prior handoff prompts", async (t) => {
  const { session, sessionsDir } = await fixture(t);
  const first = await prepareContextRotation({ session, sessionsDir });
  await first.next.update({
    phase: "idle", turn: 37, runCount: 1,
    lastMessage: "Inspected repository; no unsafe replays.",
  });
  const second = await prepareContextRotation({
    session: first.next, sessionsDir,
  });
  assert.equal(second.next.state.rootContextGoal, "Build a small web app");
  assert.equal(second.next.state.contextGeneration, 2);
  assert.equal(second.next.state.task.includes("<previous_context_json>"), true);
  const parsed = JSON.parse(
    second.next.state.task.split("<previous_context_json>")[1].split("</previous_context_json>")[0],
  );
  assert.equal(parsed.originalGoal, "Build a small web app");
  assert.equal(parsed.oldTurnCount, 37);
});


async function canonicalFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-cm01-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  function git(...args) {
    return execFileSync("git", args, {
      cwd: workspaceRoot, encoding: "utf8", windowsHide: true, timeout: 15000,
    }).trim();
  }
  git("init", "-q");
  git("config", "user.name", "Canonical Test");
  git("config", "user.email", "canonical@example.invalid");
  git("commit", "-q", "--allow-empty", "-m", "test initial state");
  const sha = git("rev-parse", "HEAD");
  const stateFile = path.join(root, "checkpoints", "coordinator.json");
  const records = new Map();
  const calls = [];
  let initialWorkerStatus = "completed";
  const supervisor = {
    calls,
    async create({ workspaceId, instruction, idempotencyKey }) {
      const found = [...records.values()].find(r => r.idempotencyKey === idempotencyKey);
      if (found) return { taskId: found.taskId };
      const taskId = "task_" + randomUUID();
      const record = {
        taskId, workspaceId, workspaceRoot, idempotencyKey, instruction,
        status: initialWorkerStatus,
      };
      records.set(taskId, record);
      calls.push(instruction);
      const label = /^build (one|two|three) SECRET_PAYLOAD_NOT_FOR_MANIFEST$/.exec(instruction)?.[1];
      if (label) await fs.writeFile(path.join(workspaceRoot, label + ".txt"),
        "verified artifact " + label);
      return { taskId };
    },
    get(taskId) {
      const record = records.get(taskId);
      if (!record) throw Error("Unknown supervisor task");
      return { ...record };
    },
    setCreationStatus(status) { initialWorkerStatus = status; },
    mutateRecord(taskId, patch) {
      const record = records.get(taskId);
      if (!record) throw Error("Unknown supervisor task");
      Object.assign(record, patch);
    },
    setStatus(taskId, status) {
      const record = records.get(taskId);
      if (!record) throw Error("Unknown supervisor task");
      record.status = status;
    },
  };
  const sensitiveGoal =
    "build private token sk-EXAMPLE_DO_NOT_LEAK and internal instructions";
  const plan = {
    goal: sensitiveGoal,
    tasks: ["one", "two", "three"].map((id, i, ids) => ({
      id, instruction: "build " + id + " SECRET_PAYLOAD_NOT_FOR_MANIFEST",
      dependsOn: i === 0 ? [] : [ids[i - 1]],
      acceptance: [{ kind: "file", path: id + ".txt" }],
    })),
  };
  const coordinator = await TaskCoordinator.create({
    stateFile, workspaceRoot, workspaceId: "main", supervisor, plan,
  });
  return { root, workspaceRoot, stateFile, supervisor, coordinator, plan, sha, git };
}

test("CM-01 canonical manifest uses validated checkpoint and actual Git HEAD", async t => {
  const f = await canonicalFixture(t);
  const args = {
    stateFile: f.stateFile, workspaceRoot: f.workspaceRoot,
    workspaceId: "main", supervisor: f.supervisor,
  };
  const state = f.coordinator.getState();
  const result = await buildCanonicalContextManifest(args);
  assert.equal(result.schema, 1);
  assert.equal(result.authority, "validated-task-coordinator-checkpoint");
  assert.equal(result.planId, state.planId);
  assert.equal(result.planRevision, 0);
  assert.equal(result.goalId.length, 64);
  assert.equal(result.source.currentHeadSha, f.sha);
  assert.equal(result.source.clean, true);
  assert.equal(result.nextAction.action, "START_TASK");
  assert.equal(result.nextAction.taskId, "one");
  assert.deepEqual(result.tasks.map(task => task.status), ["TODO", "TODO", "TODO"]);
  const output = JSON.stringify(result);
  assert.ok(Buffer.byteLength(output, "utf8") <= MAX_CANONICAL_MANIFEST_BYTES);
  assert.doesNotMatch(output, /sk-EXAMPLE|SECRET_PAYLOAD|internal instructions|example.invalid/);

  // Never reuse a previous in-memory "summary" or status when the checkpoint
  // has since advanced. Each manifest call reconstructs the authority.
  await f.coordinator.tick();
  const next = await buildCanonicalContextManifest(args);
  assert.equal(next.tasks[0].status, "VERIFIED");
  assert.match(next.tasks[0].receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(next.nextAction.action, "START_TASK");
  assert.equal(next.nextAction.taskId, "two");
  assert.equal(f.supervisor.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(next), /verified artifact|SECRET_PAYLOAD/);

  await fs.writeFile(path.join(f.workspaceRoot, "untracked.txt"), "local work");
  const dirty = await buildCanonicalContextManifest(args);
  assert.equal(dirty.source.clean, false);
  assert.ok(dirty.hazards.includes("WORKTREE_DIRTY"));
});

test("CM-01 canonical manifest reports existing Worker and survives Coordinator restart", async t => {
  const f = await canonicalFixture(t);
  const args = {
    stateFile: f.stateFile, workspaceRoot: f.workspaceRoot,
    workspaceId: "main", supervisor: f.supervisor,
  };
  await f.coordinator.tick();
  const state = await f.coordinator.tick();
  const runningTask = state.tasks.find(task => task.id === "two");
  assert.equal(runningTask.status, "VERIFIED");
  const result = await buildCanonicalContextManifest(args);
  assert.equal(result.tasks[0].status, "VERIFIED");
  assert.equal(result.tasks[1].status, "VERIFIED");
  assert.equal(result.nextAction.action, "START_TASK");
  assert.equal(result.nextAction.taskId, "three");
  const reloaded = await TaskCoordinator.load(args);
  assert.equal(reloaded.getState().planId, result.planId);
  assert.equal(f.supervisor.calls.length, 2);
});

test("CM-01 rejects missing checkpoint and unavailable Git identity rather than guessing", async t => {
  const f = await canonicalFixture(t);
  const args = {
    stateFile: f.stateFile, workspaceRoot: f.workspaceRoot,
    workspaceId: "main", supervisor: f.supervisor,
  };
  await assert.rejects(buildCanonicalContextManifest({
    ...args, stateFile: path.join(f.root, "absent.json"),
  }), { code: "CANONICAL_STATE_UNAVAILABLE" });
  await fs.rm(path.join(f.workspaceRoot, ".git"), { recursive: true, force: true });
  await assert.rejects(buildCanonicalContextManifest(args),
    { code: "CANONICAL_SOURCE_UNAVAILABLE" });
});

test("CM-01 rejects corrupt checkpoint and missing verification receipt", async t => {
  const f = await canonicalFixture(t);
  const args = {
    stateFile: f.stateFile, workspaceRoot: f.workspaceRoot,
    workspaceId: "main", supervisor: f.supervisor,
  };
  await f.coordinator.tick();
  const state = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(state.tasks[0].status, "VERIFIED");
  state.tasks[0].verificationReceipt = null;
  await fs.writeFile(f.stateFile, JSON.stringify(state));
  await assert.rejects(buildCanonicalContextManifest(args),
    { code: "CANONICAL_STATE_UNSAFE" });
});

test("CM-01 canonical manifest never fabricates failed task recovery", async t => {
  const f = await canonicalFixture(t);
  const args = {
    stateFile: f.stateFile, workspaceRoot: f.workspaceRoot,
    workspaceId: "main", supervisor: f.supervisor,
  };
  await f.coordinator.tick();
  const existing = await buildCanonicalContextManifest(args);
  assert.equal(existing.tasks[0].status, "VERIFIED");
  assert.equal(existing.tasks[1].status, "TODO");
  assert.equal(existing.tasks[2].status, "TODO");
  const stat = await fs.stat(f.stateFile);
  assert.ok(stat.isFile());
  assert.equal(f.supervisor.calls.length, 1);
});


test("CM-01 canonical manifest represents in-flight and paused Worker state", async t => {
  const f=await canonicalFixture(t);
  const args={
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:f.supervisor,
  };
  f.supervisor.setCreationStatus("running");
  const started=await f.coordinator.tick();
  assert.equal(started.tasks[0].status,"RUNNING");
  const workerId=started.tasks[0].supervisorTaskId;
  assert.ok(workerId);
  const manifest=await buildCanonicalContextManifest(args);
  assert.equal(manifest.nextAction.action,"MONITOR_WORKER");
  assert.equal(manifest.nextAction.taskId,"one");
  assert.equal(manifest.tasks[0].status,"RUNNING");
  assert.equal(manifest.tasks[0].submissionPending,false);
  assert.equal(f.supervisor.calls.length,1);

  f.supervisor.setStatus(workerId,"paused");
  const paused=await buildCanonicalContextManifest(args);
  assert.equal(paused.nextAction.action,"RESUME_WORKER");
  assert.equal(paused.nextAction.taskId,"one");
  assert.equal(f.supervisor.calls.length,1);
  assert.doesNotMatch(JSON.stringify(paused),/SECRET_PAYLOAD_NOT_FOR_MANIFEST/);

  f.supervisor.mutateRecord(workerId,{instruction:"forged mutation"});
  await assert.rejects(buildCanonicalContextManifest(args),
    {code:"CANONICAL_STATE_UNSAFE"});
  assert.equal(f.supervisor.calls.length,1);
});

test("CM-01 Git source follows actual HEAD changes without changing verified task evidence",async t=>{
  const f=await canonicalFixture(t);
  const args={
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:f.supervisor,
  };
  await f.coordinator.tick();
  const first=await buildCanonicalContextManifest(args);
  assert.equal(first.source.currentHeadSha,f.sha);
  assert.equal(first.source.clean,false);
  assert.ok(first.hazards.includes("WORKTREE_DIRTY"));
  assert.match(first.tasks[0].receiptSha256,/^[a-f0-9]{64}$/);
  f.git("add","one.txt");
  f.git("commit","-q","-m","next local version");
  const second=await buildCanonicalContextManifest(args);
  assert.notEqual(second.source.currentHeadSha,first.source.currentHeadSha);
  assert.equal(second.source.clean,true);
  assert.equal(second.goalId,first.goalId);
  assert.equal(second.planId,first.planId);
  assert.equal(second.tasks[0].receiptSha256,first.tasks[0].receiptSha256);
  assert.equal(second.nextAction.action,"START_TASK");
  assert.equal(second.nextAction.taskId,"two");
});
