import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCheckpoint, retryDelay, recoveryOptions,
  incidentSummary, safeRuntimeEvent,
} from "../src/supervisor/recovery-controller.js";
import { SupervisorApprovalProvider } from "../src/supervisor/approval-provider.js";

test("checkpoint classifier completes only committed idle sessions", () => {
  assert.equal(inspectCheckpoint({
    phase: "idle", runCount: 1, lastMessage: "done",
  }).action, "complete");
  assert.equal(inspectCheckpoint({
    phase: "running", runCount: 1, lastMessage: "older reply",
  }).action, "block");
});

test("checkpoint classifier never blindly replays an ambiguous send", () => {
  assert.deepEqual(inspectCheckpoint({
    phase: "running", runCount: 2,
  }), { action: "block", reason: "NO_SAFE_RECOVERY_CHECKPOINT" });
  assert.deepEqual(inspectCheckpoint({
    phase: "running", runCount: 1,
    pendingOutbound: { outboundId: "o-1" },
  }), { action: "block", reason: "CONVERSATION_TARGET_UNBOUND" });
  assert.deepEqual(inspectCheckpoint({
    phase: "running", runCount: 1,
    conversationTargetId: "conversation-a",
    pendingOutbound: { outboundId: "o-1", conversationTargetId: "conversation-b" },
  }), { action: "block", reason: "CONVERSATION_TARGET_MISMATCH" });
  assert.deepEqual(inspectCheckpoint({
    phase: "running", runCount: 1,
    conversationTargetId: "conversation-a",
    pendingOutbound: { outboundId: "o-1", conversationTargetId: "conversation-a" },
  }), { action: "reconcile", reason: "PENDING_OUTBOUND" });
  assert.deepEqual(inspectCheckpoint({
    phase: "running", runCount: 1, pendingAuxiliaryTurn: { id: "a" },
  }), { action: "block", reason: "AUXILIARY_HANDOFF_UNCERTAIN" });
});

test("retry delays are capped and options reject invalid values", () => {
  const settings = recoveryOptions({ recovery: {
    maxRetries: 2, retryBaseMs: 10, retryMaxMs: 25,
    progressTimeoutMs: -1,
  } });
  assert.equal(settings.maxRetries, 2);
  assert.equal(settings.progressTimeoutMs, 180000);
  assert.equal(retryDelay(1, settings), 10);
  assert.equal(retryDelay(2, settings), 20);
  assert.equal(retryDelay(20, settings), 25);
});

test("structured diagnostics and runtime events never contain private content", () => {
  const privateText = "SUPER_PRIVATE_PASSWORD";
  const diagnostic = incidentSummary({
    error: { code: "TURN_TIMEOUT", message: privateText },
    state: {
      conversationTargetId: privateText,
      pendingOutbound: { outboundId: privateText, prompt: privateText },
    },
    reason: "PENDING_OUTBOUND", retries: 1,
  });
  assert.equal(diagnostic.code, "TURN_TIMEOUT");
  assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
  const event = safeRuntimeEvent({
    type: "tool.proposed",
    payload: { args: { token: privateText }, content: privateText, code: "READY" },
  });
  assert.deepEqual(event, { type: "tool.proposed", payload: { code: "READY" } });
});

test("approval can be decided as soon as waiting_approval is published", async () => {
  let provider;
  let stopListener;
  let onRequiredReached = false;
  const control = {
    checkpoint() {},
    onStop(listener) {
      stopListener = listener;
      return () => { stopListener = null; };
    },
  };
  provider = new SupervisorApprovalProvider({
    control,
    onRequired: async ({ requestId }) => {
      onRequiredReached = true;
      assert.equal(provider.decide(requestId, "approve"), true);
    },
  });
  const result = await provider.request({
    toolCall: { id: "tool-1", name: "fs.read", args: { path: "x" } },
    reasons: [],
  });
  assert.equal(onRequiredReached, true);
  assert.equal(result, true);
  assert.equal(provider.pending, null);
  assert.equal(stopListener, null);
});

test("approval stop unregisters listener and aborts approval", async () => {
  let signalStop;
  let didUnsubscribe = false;
  const control = {
    checkpoint() {},
    onStop(fn) {
      signalStop = fn;
      return () => { didUnsubscribe = true; };
    },
  };
  const provider = new SupervisorApprovalProvider({
    control, onRequired: async () => {},
  });
  const pending = provider.request({
    toolCall: { id: "tool-1", name: "fs.read", args: {} }, reasons: [],
  });
  await Promise.resolve();
  const error = Object.assign(new Error("paused"), { code: "TASK_PAUSED" });
  signalStop(error);
  await assert.rejects(pending, { code: "TASK_PAUSED" });
  assert.equal(didUnsubscribe, true);
  assert.equal(provider.pending, null);
});
