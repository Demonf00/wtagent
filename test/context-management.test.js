import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
