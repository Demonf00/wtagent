import test from "node:test";
import assert from "node:assert/strict";
import { executeConversationTurn } from "../src/runtime/conversation-runner.js";

function harness({ state = {}, result = { message: "finished" }, error = null, afterRun = null } = {}) {
  const session = {
    state: {
      pendingOutbound: null,
      pendingAssistantTurn: null,
      pendingAuxiliaryTurn: null,
      ...state,
    },
  };
  const closeCalls = [];
  const runner = {
    async runTurn() {
      afterRun?.(session.state);
      if (error) throw error;
      return result;
    },
    async close(options) {
      closeCalls.push(options);
    },
  };
  const run = () => executeConversationTurn({
    session, createRunner: () => runner,
  });
  return { run, session, closeCalls };
}

test("failed worker with pending assistant turn preserves the exact Chrome target", async () => {
  const h = harness({
    error: Object.assign(new Error("temporary worker timeout"), { code: "TURN_TIMEOUT" }),
    afterRun(state) {
      state.pendingAssistantTurn = {
        sourceOutboundId: "outbound-test",
        conversationTargetId: "saved-target",
      };
    },
  });
  await assert.rejects(h.run(), { code: "TURN_TIMEOUT" });
  assert.deepEqual(h.closeCalls, [{ keepBrowser: true }]);
});

test("pending outbound and auxiliary handoffs keep browser available across worker exit", async () => {
  for (const pending of ["pendingOutbound", "pendingAuxiliaryTurn"]) {
    const h = harness({
      state: { [pending]: { conversationTargetId: "saved-target" } },
      result: { recoveryRequired: true, message: null },
    });
    assert.equal((await h.run()).recoveryRequired, true);
    assert.deepEqual(h.closeCalls, [{ keepBrowser: true }], pending);
  }
});

test("completed worker with no pending handoff closes Chrome normally", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { message: "finished" });
  assert.deepEqual(h.closeCalls, [{ keepBrowser: false }]);
});

test("failure before any outbound checkpoint still closes Chrome", async () => {
  const h = harness({ error: new Error("setup failed") });
  await assert.rejects(h.run(), /setup failed/);
  assert.deepEqual(h.closeCalls, [{ keepBrowser: false }]);
});
