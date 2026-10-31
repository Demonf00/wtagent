import fs from "node:fs/promises";
import path from "node:path";
import { AgentSession } from "../session/agent-session.js";
import { TaskSupervisor } from "../supervisor/task-supervisor.js";
import { isProcessAlive } from "../browser/cdp-state.js";
import { ApprovalStore } from "../policy/approval-store.js";
import { promptForSelect, ShellChatInput } from "./prompt-input.js";

const TERMINAL = new Set(["completed", "cancelled", "paused", "blocked_uncertain", "failed"]);
const IN_PROGRESS = new Set([
"queued", "running", "recovering", "waiting_retry", "waiting_approval",
"pausing", "cancelling",
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lockSession(directory) {
const filename = path.join(directory, "cli-supervisor.lock");
for (let attempt = 0; attempt < 2; attempt++) {
try {
const handle = await fs.open(filename, "wx", 0o600);
try {
await handle.writeFile(`${process.pid}\n`);
} finally {
await handle.close();
}
return () => fs.rm(filename, { force: true });
} catch (error) {
if (error.code !== "EEXIST") throw error;
const pid = Number((await fs.readFile(filename, "utf8").catch(() => "")).trim());
if (Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
await fs.rm(filename, { force: true });
continue;
}
throw Object.assign(
new Error(`Session is already controlled by another CLI: ${filename}`),
{ code: "SESSION_LOCKED" },
);
}
}
throw new Error("Could not acquire CLI session lock.");
}

async function decideApproval(task, supervisor, prompt, output, interactive) {
const approval = task.pendingApproval;
if (!approval) return;
if (!interactive) {
await supervisor.decide(task.taskId, approval.requestId, "deny");
return;
}
const tool = approval.toolCall;
output(`[Supervisor] Approval required: ${tool?.name ?? "tool"}`);
for (const reason of approval.reasons ?? []) output(` - ${reason}`);
output(JSON.stringify(tool?.args ?? {}, null, 2));
let choice;
try {
choice = await prompt({
message: "Allow this tool call?",
choices: [
{ name: "Allow once", value: "approve" },
{ name: "Always allow this tool for this session", value: "always-tool" },
{ name: "Always allow all tools for this session", value: "always-all" },
{ name: "Deny", value: "deny" },
],
});
} catch {
choice = "deny";
}
if (choice === "always-tool" || choice === "always-all") {
const session = await AgentSession.load({
sessionsDir: supervisor.sessionsDir, sessionId: task.sessionId,
});
const store = new ApprovalStore({
filePath: path.join(session.directory, "approvals.json"),
});
await store.ensureLoaded();
 if (choice === "always-tool") store.setAlwaysAllowedTool(tool.name);
else store.setAlwaysAllowAll();
await store.save();
output("[Supervisor] Permission saved for future turns.");
}
await supervisor.decide(task.taskId, approval.requestId,
["approve", "always-tool", "always-all"].includes(choice) ? "approve" : "deny");
}

function emitProgress(events, output) {
for (const event of events) {
if (event.type === "worker.started") {
output(`[Supervisor] Worker started (pid=${event.payload?.pid ?? "unknown"})`);
} else if (event.type === "runtime.initializing" || event.type.startsWith("tool.")
|| event.type === "model.message_complete" || event.type === "run.completed") {
output(`[Worker] ${event.type}`);
}
}
}

/**
* Runs a CLI conversation through the existing TaskSupervisor. Every turn
* has a durable Supervisor task and disposable Worker, while the underlying
* AgentSession, transcript, approvals, browser identity and follow-ups remain
* unchanged. No background daemon or control HTTP service is started.
*/
export async function executeSupervisorSession({
session, options, resume = false, instruction = null, files = [], chatInput = null,
}, {
interactive = !options.once && Boolean(process.stdin.isTTY && process.stdout.isTTY),
readNextMessage,
askApproval = promptForSelect,
output = console.log,
createSupervisor = (config) => new TaskSupervisor(config),
printResumeHint = () => {},
pollMs = 150,
} = {}) {
const releaseLock = await lockSession(session.directory);
// Legacy sessions can live in legacyTasksDir. Never move them on resume.
const sessionsDir = path.dirname(session.directory);
const activeInput = chatInput ?? (interactive ? new ShellChatInput() : null);
let supervisor;
try {
supervisor = createSupervisor({
dataDir: path.join(session.directory, "supervisor"),
sessionsDir,
workspaces: [{ id: "cli", root: session.state.projectRoot }],
options,
});
await supervisor.init();
output(`[Supervisor] Session ${session.sessionId}; isolated Worker execution`);
let nextInstruction = instruction;
let nextFiles = files;
let resuming = resume;
for (;;) {
const existing = supervisor.list()
.filter((item) => item.sessionId === session.sessionId)
.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
let task;
const hasNewInput = Boolean(nextInstruction?.trim() || nextFiles?.length);
if (hasNewInput && existing && !["completed", "cancelled"].includes(existing.status)) {
throw Object.assign(
new Error(`Task ${existing.taskId} is ${existing.status}; resume the unfinished task without a new instruction first.`),
{ code: "RECOVERY_REQUIRES_BARE_RESUME" },
);
}
if (existing && IN_PROGRESS.has(existing.status)) {
task = existing;
output(`[Supervisor] Reattached to task ${task.taskId}`);
} else if (["paused", "interrupted"].includes(existing?.status) && resuming) {
task = await supervisor.resume(existing.taskId);
output(`[Supervisor] Resuming paused task ${task.taskId}`);
} else if (existing?.status === "blocked_uncertain" && resuming) {
output(`[Supervisor] Task ${existing.taskId} blocked_uncertain: ${existing.error}`);
output("[Supervisor] Unsafe state: will not automatically replay outbound messages or tools.");
process.exitCode ||= 1;
break;
} else {
if (nextInstruction && resuming) {
const currentSession = await AgentSession.load({ sessionsDir, sessionId: session.sessionId });
if (currentSession.state.pendingOutbound || currentSession.state.pendingAssistantTurn
|| currentSession.state.pendingAuxiliaryTurn) {
throw Object.assign(new Error("Pending browser handoff requires a bare resume."),
{ code: "RECOVERY_REQUIRES_BARE_RESUME" });
}
await currentSession.appendInstruction(nextInstruction, { files: nextFiles });
}
task = await supervisor.enqueueSessionTurn({
workspaceId: "cli", sessionId: session.sessionId,
instruction: nextInstruction, files: nextFiles,
});
}
output(`[Supervisor] Task ${task.taskId}: ${task.status}`);
let lastStatus = task.status;
let after = 0;
let pendingApproval = null;
let stopped = false;
const onStop = () => {
if (stopped) return;
stopped = true;
output("[Supervisor] Pausing; preserving task state.");
void supervisor.pause(task.taskId).catch((error) =>
output(`[Supervisor] Pause error: ${error.message}`));
process.exitCode = 130;
};
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);
try {
for (;;) {
task = supervisor.get(task.taskId);
const events = await supervisor.getEvents(task.taskId, after);
if (events.length) {
after = events.at(-1).seq;
emitProgress(events, output);
}
if (task.status !== lastStatus) {
output(`[Supervisor] ${task.status}`);
lastStatus = task.status;
}
if (task.status === "waiting_approval" && task.pendingApproval
&& task.pendingApproval.requestId !== pendingApproval) {
pendingApproval = task.pendingApproval.requestId;
await decideApproval(task, supervisor, askApproval, output, interactive && !stopped);
}
if (TERMINAL.has(task.status)) break;
if (supervisor.fatalError) throw supervisor.fatalError;
await sleep(pollMs);
}
} finally {
process.removeListener("SIGINT", onStop);
process.removeListener("SIGTERM", onStop);
}
if (task.status !== "completed") {
output(`[Supervisor] Task ${task.status}: ${task.error ?? task.incident?.reason ?? "stopped"}`);
if (task.status === "blocked_uncertain") {
output("[Supervisor] Unsafe recovery blocked; no automatic browser/tool replay.");
}
if (task.status !== "paused" && task.status !== "cancelled") process.exitCode ||= 1;
break;
}
if (task.result?.message) output(task.result.message);
output(`[Supervisor] Completed turn for session ${session.sessionId}`);
if (!interactive) return task.result;
const freshSession = await AgentSession.load({ sessionsDir, sessionId: session.sessionId });
const next = await readNextMessage({
session: freshSession,
renderer: {
providerLabel: freshSession.state.provider,
hint: output,
println: output,
},
}, activeInput);
if (next == null) break;
if (freshSession.state.pendingOutbound || freshSession.state.pendingAssistantTurn
|| freshSession.state.pendingAuxiliaryTurn) {
output("[Supervisor] Pending handoff must be recovered before another instruction.");
process.exitCode ||= 1;
break;
}
nextInstruction = next.text;
nextFiles = next.files;
resuming = true;
}
return null;
} finally {
activeInput?.close();
try {
await supervisor?.close();
} finally {
await releaseLock();
output(`Session saved at ${session.directory}`);
printResumeHint(session.sessionId);
}
}
}
