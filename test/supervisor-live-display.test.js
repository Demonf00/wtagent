import test from "node:test";
import assert from "node:assert/strict";
import { safeLiveEvent, formatLiveEvent } from "../src/supervisor/live-display.js";
import { safeRuntimeEvent } from "../src/supervisor/recovery-controller.js";

test("Supervisor CLI can display validated model progress without writing it to durable events", () => {
  const progress = { type: "model.progress", payload: {
    message: "Inspecting repository and running focused tests.",
    secret: "do-not-log",
  } };
  assert.deepEqual(safeLiveEvent(progress), {
    type: "model.progress",
    payload: { message: "Inspecting repository and running focused tests." },
  });
  assert.match(formatLiveEvent(progress), /^\[Agent\] Inspecting repository/);
  const durable = safeRuntimeEvent(progress);
  assert.deepEqual(durable, { type: "model.progress", payload: {} });
  assert.doesNotMatch(JSON.stringify(durable), /Inspecting repository|do-not-log/);
});

test("ephemeral progress drops terminal control sequences and bounds long text", () => {
  const raw = "\x1b[31m" + "testing".repeat(200) + "\x1b[0m";
  const live = safeLiveEvent({ type: "model.progress", payload: { message: raw } });
  assert.equal(live.payload.message.length, 550);
  assert.doesNotMatch(live.payload.message, /\x1b/);
  assert.equal(safeLiveEvent({ type: "model.streaming", payload: { delta: "secret" } }), null);
  assert.equal(safeLiveEvent({ type: "tool.output", payload: { chunk: "secret" } }), null);
});

test("tool calls and results display tool names but never command arguments or output", () => {
  const offered = {
    type: "tool.proposed", payload: {
      name: "terminal.exec", args: { program: "node", argv: ["-e", "SECRET"] },
    },
  };
  const result = {
    type: "tool.completed", payload: {
      result: { name: "terminal.exec", ok: true, message: "PASSWORD=SECRET" },
    },
  };
  assert.equal(formatLiveEvent(offered), "[Agent] → terminal.exec");
  assert.equal(formatLiveEvent(result), "[Agent] ✓ terminal.exec");
  assert.doesNotMatch(JSON.stringify(safeLiveEvent(result)), /SECRET|PASSWORD/);
  assert.equal(formatLiveEvent({
    type: "tool.result_sent", payload: { name: "terminal.exec" },
  }), "[Agent] ↥ terminal.exec result returned to model");
  assert.equal(safeLiveEvent({ type: "tool.started", payload: { name: "bad\nname" } }), null);
});

test("no durable high-volume streaming or unknown event types enter display", () => {
  assert.equal(safeLiveEvent({ type: "browser.password", payload: { password: "abc" } }), null);
  assert.equal(safeLiveEvent({ type: "model.progress", payload: { message: "" } }), null);
  assert.equal(formatLiveEvent({ type: "tool.completion_unknown",
    payload: { result: { name: "fs.write", ok: false } } }),
    "[Agent] ? fs.write (completion uncertain)");
});
