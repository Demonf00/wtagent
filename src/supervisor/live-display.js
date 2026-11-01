// Transient local terminal display events. These are NEVER written to the
// Supervisor's durable .events.jsonl files. Keep model text and tool arguments
// out of persistent Supervisor diagnostics; bound what can enter IPC/TTY.
const TOOL = /^[a-z][a-z0-9_.-]{0,95}$/;
const DISPLAY_TYPES = new Set([
  "model.progress", "model.message_sent", "tool.proposed", "tool.started",
  "tool.completed", "tool.completion_unknown", "tool.invalid",
  "tool.reused", "tool.reused_unknown", "tool.result_sent",
  "protocol.invalid",
]);

function visibleText(value, limit) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function safeLiveEvent(event) {
  if (!DISPLAY_TYPES.has(event?.type)) return null;
  const src = event.payload ?? {};
  const payload = {};
  if (event.type === "model.progress") {
    payload.message = visibleText(src.message, 550);
    if (!payload.message) return null;
  } else if (event.type === "protocol.invalid") {
    if (Number.isSafeInteger(src.count) && src.count >= 0 && src.count <= 20) {
      payload.count = src.count;
    }
  } else if (event.type.startsWith("tool.")) {
    const name = src.result?.name ?? src.name;
    if (!TOOL.test(name ?? "")) return null;
    payload.name = name;
    if (["tool.completed", "tool.completion_unknown"].includes(event.type)) {
      payload.ok = src.result?.ok === true && event.type === "tool.completed";
    }
  }
  return { type: event.type, payload };
}

export function formatLiveEvent(event) {
  const safe = safeLiveEvent(event);
  if (!safe) return null;
  const { type, payload } = safe;
  if (type === "model.progress") return "[Agent] " + payload.message;
  if (type === "model.message_sent") return "[Agent] Waiting for model response...";
  if (type === "protocol.invalid") {
    return "[Agent] Protocol format retry" + (payload.count ? " (" + payload.count + ")" : "");
  }
  if (type === "tool.proposed") return "[Agent] → " + payload.name;
  if (type === "tool.started") return "[Agent] Running " + payload.name;
  if (type === "tool.completed") return "[Agent] " + (payload.ok ? "✓ " : "✗ ") + payload.name;
  if (type === "tool.completion_unknown") return "[Agent] ? " + payload.name + " (completion uncertain)";
  if (type === "tool.invalid") return "[Agent] ✗ " + payload.name + " (invalid request)";
  if (type === "tool.reused") return "[Agent] ↺ " + payload.name + " (result reused)";
  if (type === "tool.reused_unknown") return "[Agent] ? " + payload.name + " (prior outcome unknown)";
  if (type === "tool.result_sent") return "[Agent] ↥ " + payload.name + " result returned to model";
  return null;
}
