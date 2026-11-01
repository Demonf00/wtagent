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
import { inspectPlannedWorkResumption, resumePlannedWorkStep } from "../src/context/planned-work-resumption.js";
import { advanceAutomaticContextRotation } from "../src/context/automatic-rotation.js";
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


test("CM-02 automatic rotation creates a new identity only at a clean checkpoint",async t=>{
  const {session,sessionsDir}=await fixture(t);
  const before=structuredClone(session.state);
  const result=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(result.status,"ROTATED");
  assert.equal(result.reused,false);
  assert.notEqual(result.next.sessionId,session.sessionId);
  assert.equal(result.next.state.previousContextSessionId,session.sessionId);
  assert.equal(result.next.state.conversationUrl,null);
  assert.equal(result.next.state.conversationTargetId,null);
  assert.equal(result.next.state.pendingOutbound,null);
  assert.equal(result.next.state.pendingToolResult,null);
  assert.deepEqual(result.next.state.sideEffectTools,{});
  const original=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(original.state.conversationUrl,before.conversationUrl);
  assert.equal(original.state.conversationTargetId,before.conversationTargetId);
  assert.deepEqual(original.state.followUps,before.followUps);
  assert.equal(original.state.automaticContextRotation.status,"ROTATED");
  assert.equal(original.state.automaticContextRotation.nextSessionId,result.next.sessionId);
  const again=await advanceAutomaticContextRotation({session:original,sessionsDir});
  assert.equal(again.status,"ROTATED");
  assert.equal(again.reused,true);
  assert.equal(again.next.sessionId,result.next.sessionId);
  assert.equal((await fs.readdir(sessionsDir)).length,2);
});

test("CM-02 preserves pending outbound and tool results, then rotates after recovery",async t=>{
  const {session,sessionsDir}=await fixture(t);
  const pendingOutbound={outboundId:"inflight-original"};
  const pendingToolResult={toolCallId:"tool-original",body:"untrusted-private-result"};
  await session.update({pendingOutbound,pendingToolResult});
  const blocked=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(blocked.status,"DEFERRED");
  assert.ok(blocked.blockers.includes("PENDING_OUTBOUND"));
  assert.ok(blocked.blockers.includes("PENDING_TOOL_RESULT"));
  assert.equal((await fs.readdir(sessionsDir)).length,1);
  const restored=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(restored.state.automaticContextRotation.status,"PENDING");
  assert.deepEqual(restored.state.pendingOutbound,pendingOutbound);
  assert.deepEqual(restored.state.pendingToolResult,pendingToolResult);
  await restored.update({pendingOutbound:null,pendingToolResult:null});
  const next=await advanceAutomaticContextRotation({
    session:await AgentSession.load({sessionsDir,sessionId:session.sessionId}),sessionsDir,
  });
  assert.equal(next.status,"ROTATED");
  assert.equal(next.next.state.pendingOutbound,null);
  assert.equal(next.next.state.pendingToolResult,null);
  assert.doesNotMatch(next.next.state.task,/untrusted-private-result/);
});

test("CM-02 refuses to rotate while side effects are uncertain",async t=>{
  const {session,sessionsDir}=await fixture(t);
  const record={status:"unknown",operationId:"do-not-replay"};
  await session.update({sideEffectTools:{"terminal.exec":record}});
  const blocked=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(blocked.status,"DEFERRED");
  assert.ok(blocked.blockers.includes("UNCERTAIN_SIDE_EFFECT"));
  assert.equal((await fs.readdir(sessionsDir)).length,1);
  const saved=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.deepEqual(saved.state.sideEffectTools["terminal.exec"],record);
  assert.equal(saved.state.automaticContextRotation.status,"PENDING");
});

test("CM-02 blocks active Supervisor tasks instead of silently rotating",async t=>{
  const {session,sessionsDir}=await fixture(t);
  const supervisorDir=path.join(session.directory,"supervisor");
  await fs.mkdir(supervisorDir);
  const filename="task_01234567-89ab-cdef-0123-456789abcdef.json";
  await fs.writeFile(path.join(supervisorDir,filename),
    JSON.stringify({status:"running"}));
  const blocked=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(blocked.status,"DEFERRED");
  assert.ok(blocked.blockers.includes("ACTIVE_SUPERVISOR_TASK"));
  assert.equal((await fs.readdir(sessionsDir)).length,1);
  const checkpoint=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(checkpoint.state.automaticContextRotation.status,"PENDING");
  await fs.writeFile(path.join(supervisorDir,filename),
    JSON.stringify({status:"completed"}));
  const resumed=await advanceAutomaticContextRotation({session:checkpoint,sessionsDir});
  assert.equal(resumed.status,"ROTATED");
  assert.equal((await fs.readdir(sessionsDir)).length,2);
});

test("CM-02 creation outcome unknown fails closed without duplicate Session",async t=>{
  const {session,sessionsDir}=await fixture(t);
  await session.update({automaticContextRotation:{
    schema:1,status:"CREATING",nextSessionId:null,
  }});
  const uncertain=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(uncertain.status,"UNCERTAIN");
  const after=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(after.state.automaticContextRotation.status,"CREATING");
  assert.equal((await fs.readdir(sessionsDir)).length,1);
  const repeated=await advanceAutomaticContextRotation({session:after,sessionsDir});
  assert.equal(repeated.status,"UNCERTAIN");
  assert.equal((await fs.readdir(sessionsDir)).length,1);
});

test("CM-02 invalid or forged durable rotation records cannot open unrelated Session",async t=>{
  const {session,sessionsDir}=await fixture(t);
  await session.update({automaticContextRotation:{
    schema:1,status:"ROTATED",nextSessionId:"../../another-session",
  }});
  await assert.rejects(advanceAutomaticContextRotation({session,sessionsDir}),
    {code:"CONTEXT_ROTATION_STATE_UNSAFE"});
  const saved=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(saved.state.conversationTargetId,session.state.conversationTargetId);
  assert.equal((await fs.readdir(sessionsDir)).length,1);
});

test("CM-02 below-pressure session neither records request nor creates replacement",async t=>{
  const {session,sessionsDir}=await fixture(t);
  await session.update({turn:1});
  const decision=await advanceAutomaticContextRotation({session,sessionsDir});
  assert.equal(decision.status,"NOT_NEEDED");
  assert.equal((await fs.readdir(sessionsDir)).length,1);
  const saved=await AgentSession.load({sessionsDir,sessionId:session.sessionId});
  assert.equal(saved.state.automaticContextRotation,undefined);
});


async function cm03Fixture(t) {
  const base=await canonicalFixture(t);
  const sessionsDir=path.join(base.root,"sessions");
  const parent=await AgentSession.create({
    sessionsDir,projectRoot:base.workspaceRoot,task:"Original development plan",
  });
  const child=await AgentSession.create({
    sessionsDir,projectRoot:base.workspaceRoot,task:"Bounded context handoff",
  });
  await parent.update({
    automaticContextRotation:{
      schema:1,status:"ROTATED",nextSessionId:child.sessionId,
    },
  });
  await child.update({
    previousContextSessionId:parent.sessionId,
    rootContextGoal:"Original development plan",contextGeneration:1,
  });
  return {...base,sessionsDir,parent,child,args:{
    session:child,sessionsDir,stateFile:base.stateFile,
    workspaceRoot:base.workspaceRoot,workspaceId:"main",
    supervisor:base.supervisor,
  }};
}

test("CM-03 three-step planned work survives conversation rotation without verified task replay",async t=>{
  const f=await cm03Fixture(t);
  const expected=["one","two","three"];
  let manifest=await buildCanonicalContextManifest(f.args);
  for(let i=0;i<expected.length;i++){
    const decision=await inspectPlannedWorkResumption({
      ...f.args,previousManifest:manifest,
    });
    assert.equal(decision.status,"READY");
    assert.equal(decision.action,"START_TASK");
    assert.equal(decision.taskId,expected[i]);
    const done=await resumePlannedWorkStep({
      ...f.args,previousManifest:manifest,
    });
    assert.equal(done.status,"ADVANCED");
    assert.equal(done.taskId,expected[i]);
    assert.equal(done.manifest.tasks[i].status,"VERIFIED");
    assert.match(done.manifest.tasks[i].receiptSha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(f.supervisor.calls,expected.slice(0,i+1).map(id=>
      "build "+id+" SECRET_PAYLOAD_NOT_FOR_MANIFEST"));
    // The next distinct task begins only after verified changes are
    // independently checked and committed in the workspace.
    f.git("add",expected[i]+".txt");
    f.git("commit","-q","-m","verify "+expected[i]);
    manifest=await buildCanonicalContextManifest(f.args);
    const cold=await TaskCoordinator.load({
      stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
      workspaceId:"main",supervisor:f.supervisor,
    });
    assert.equal(cold.getState().tasks[i].status,"VERIFIED");
  }
  const last=await inspectPlannedWorkResumption({
    ...f.args,previousManifest:manifest,
  });
  assert.equal(last.status,"COMPLETE");
  assert.equal(last.action,"REPORT_VERIFIED");
  const final=await resumePlannedWorkStep({
    ...f.args,previousManifest:manifest,
  });
  assert.equal(final.status,"COMPLETE");
  assert.equal(f.supervisor.calls.length,3);
  const old=await AgentSession.load({
    sessionsDir:f.sessionsDir,sessionId:f.parent.sessionId,
  });
  assert.equal(old.state.automaticContextRotation.nextSessionId,f.child.sessionId);
});

test("CM-03 running Worker resumes monitoring without another submission",async t=>{
  const f=await cm03Fixture(t);
  f.supervisor.setCreationStatus("running");
  const started=await resumePlannedWorkStep(f.args);
  assert.equal(started.status,"ADVANCED");
  assert.equal(started.action,"START_TASK");
  assert.equal(f.supervisor.calls.length,1);
  const monitoring=await inspectPlannedWorkResumption({
    ...f.args,previousManifest:started.manifest,
  });
  assert.equal(monitoring.status,"READY");
  assert.equal(monitoring.action,"MONITOR_WORKER");
  const resumed=await resumePlannedWorkStep({
    ...f.args,previousManifest:started.manifest,
  });
  assert.equal(resumed.action,"MONITOR_WORKER");
  assert.equal(f.supervisor.calls.length,1);
  const persisted=await TaskCoordinator.load({
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:f.supervisor,
  });
  const task=persisted.getState().tasks[0];
  assert.equal(task.status,"RUNNING");
  assert.ok(task.supervisorTaskId);
});

test("CM-03 prior verified receipts are immutable across conversations",async t=>{
  const f=await cm03Fixture(t);
  const before=await buildCanonicalContextManifest(f.args);
  await resumePlannedWorkStep({...f.args,previousManifest:before});
  f.git("add","one.txt");
  f.git("commit","-q","-m","verify one");
  const current=await buildCanonicalContextManifest(f.args);
  assert.equal(current.tasks[0].status,"VERIFIED");
  const forged=structuredClone(current);
  forged.tasks[0].receiptSha256="a".repeat(64);
  await assert.rejects(inspectPlannedWorkResumption({
    ...f.args,previousManifest:forged,
  }),{code:"CONTEXT_PLAN_RESUME_UNSAFE"});
  assert.equal(f.supervisor.calls.length,1);
  const future=await inspectPlannedWorkResumption({
    ...f.args,previousManifest:current,
  });
  assert.equal(future.taskId,"two");
});

test("CM-03 rejects unrelated replacement Session and unsafe workspace",async t=>{
  const f=await cm03Fixture(t);
  const other=await AgentSession.create({
    sessionsDir:f.sessionsDir,projectRoot:f.workspaceRoot,task:"Unrelated task",
  });
  await other.update({previousContextSessionId:f.parent.sessionId});
  await assert.rejects(inspectPlannedWorkResumption({
    ...f.args,session:other,
  }),{code:"CONTEXT_PLAN_RESUME_UNSAFE"});
  const workspace=path.join(f.root,"unrelated");
  await fs.mkdir(workspace);
  await assert.rejects(inspectPlannedWorkResumption({
    ...f.args,workspaceRoot:workspace,
  }),{code:"CONTEXT_PLAN_RESUME_UNSAFE"});
  assert.equal(f.supervisor.calls.length,0);
});


test("CM-03 never starts unsubmitted work in a dirty workspace",async t=>{
  const f=await cm03Fixture(t);
  await fs.writeFile(path.join(f.workspaceRoot,"untracked-modification.txt"),"untrusted content");
  const result=await inspectPlannedWorkResumption(f.args);
  assert.equal(result.action,"START_TASK");
  assert.equal(result.status,"BLOCKED");
  assert.ok(result.reasons.includes("WORKTREE_DIRTY"));
  const resumed=await resumePlannedWorkStep(f.args);
  assert.equal(resumed.status,"BLOCKED");
  assert.equal(f.supervisor.calls.length,0);
});


test("CM-03 blocked_uncertain Worker cannot be resumed automatically",async t=>{
  const f=await cm03Fixture(t);
  f.supervisor.setCreationStatus("running");
  const initial=await resumePlannedWorkStep(f.args);
  assert.equal(initial.action,"START_TASK");
  assert.equal(f.supervisor.calls.length,1);
  const state=(await TaskCoordinator.load({
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:f.supervisor,
  })).getState();
  const workerId=state.tasks[0].supervisorTaskId;
  f.supervisor.setStatus(workerId,"blocked_uncertain");
  const decision=await inspectPlannedWorkResumption(f.args);
  assert.equal(decision.status,"BLOCKED");
  assert.ok(decision.reasons.includes("WORKER_COMPLETION_UNCERTAIN"));
  const repeat=await resumePlannedWorkStep(f.args);
  assert.equal(repeat.status,"BLOCKED");
  assert.equal(f.supervisor.calls.length,1);
  const current=await TaskCoordinator.load({
    stateFile:f.stateFile,workspaceRoot:f.workspaceRoot,
    workspaceId:"main",supervisor:f.supervisor,
  });
  assert.equal(current.getState().tasks[0].supervisorTaskId,workerId);
});
