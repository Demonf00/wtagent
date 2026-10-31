import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AgentSession } from "../src/session/agent-session.js";
import { TaskSupervisor } from "../src/supervisor/task-supervisor.js";
import { executeSupervisorSession } from "../src/cli/supervisor-session.js";

const execFileAsync = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
const home = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-cli-supervisor-"));
const workspace = path.join(home, "workspace");
const sessionsDir = path.join(home, "sessions");
await fs.mkdir(workspace);
const session = await AgentSession.create({
sessionsDir, projectRoot: workspace, task: "opening instruction",
});
t.after(async () => fs.rm(home, { recursive: true, force: true }));
return { home, workspace, sessionsDir, session };
}

async function waitFor(check, timeout = 4000) {
const until = Date.now() + timeout;
while (Date.now() < until) {
const result = await check();
if (result) return result;
await new Promise((resolve) => setTimeout(resolve, 10));
}
throw new Error("Timed out waiting for Supervisor.");
}

test("CLI-owned Supervisor creates separate turn tasks, relays progress and reuses session for follow-ups", async (t) => {
const { home, session } = await fixture(t);
const calls = [];
const output = [];
const attachment = [{ name: "reference.txt", path: path.join(home, "reference.txt") }];
const fakeSupervisor = {
initialized: true,
sessionsDir: path.dirname(session.directory),
tasks: [],
async init() {},
list() { return this.tasks.map((entry) => entry.record); },
async enqueueSessionTurn(input) {
calls.push(input);
const record = {
taskId: `task_${String(calls.length).padStart(36, "0")}`,
sessionId: input.sessionId, status: "queued",
createdAt: new Date(Date.now() + calls.length).toISOString(),
result: { message: `worker reply ${calls.length}` },
};
this.tasks.push({ record, polls: 0 });
return structuredClone(record);
},
get(taskId) {
const entry = this.tasks.find((item) => item.record.taskId === taskId);
entry.polls++;
if (entry.polls > 1) entry.record.status = "completed";
return structuredClone(entry.record);
},
async getEvents(_taskId, after) {
return after === 0 ? [{ seq: 1, type: "runtime.initializing" }] : [];
},
async close() {},
};
let prompts = 0;
await executeSupervisorSession({
session, options: { home },
chatInput: { close() {} },
}, {
interactive: true,
createSupervisor: () => fakeSupervisor,
output: (line) => output.push(String(line)),
pollMs: 1,
readNextMessage: async () => prompts++ === 0
? { text: "follow up", files: attachment }
: null,
});
assert.equal(calls.length, 2);
assert.equal(calls[0].sessionId, session.sessionId);
assert.equal(calls[1].sessionId, session.sessionId);
assert.equal(calls[1].instruction, "follow up");
assert.deepEqual(calls[1].files, attachment);
assert.match(output.join("\n"), /\[Worker\] runtime\.initializing/);
assert.match(output.join("\n"), /worker reply 2/);
const persisted = await AgentSession.load({
sessionsDir: path.dirname(session.directory), sessionId: session.sessionId,
});
assert.equal(persisted.state.followUps.at(-1).instruction, "follow up");
});

test("Supervisor enqueues existing session without changing identity and serializes turns", async (t) => {
const { home, workspace, sessionsDir, session } = await fixture(t);
const supervisor = new TaskSupervisor({
dataDir: path.join(home, "supervisor"),
sessionsDir, workspaces: [{ id: "cli", root: workspace }],
autoRun: false, execute: async () => ({ message: "test" }),
});
await supervisor.init();
t.after(() => supervisor.close());
const created = await supervisor.enqueueSessionTurn({
workspaceId: "cli", sessionId: session.sessionId,
instruction: "follow up", files: [],
});
assert.equal(created.sessionId, session.sessionId);
assert.equal(created.startRunCount, 0);
await assert.rejects(() => supervisor.enqueueSessionTurn({
workspaceId: "cli", sessionId: session.sessionId,
instruction: "concurrent turn",
}), { code: "CONFLICT" });
assert.equal(supervisor.list().length, 1);
});

test("Supervisor retries never resend a turn after it entered runtime", async (t) => {
const { home, workspace, sessionsDir, session } = await fixture(t);
await session.update({ runCount: 1, phase: "idle", lastMessage: "previous turn" });
let calls = 0;
const seen = [];
const supervisor = new TaskSupervisor({
dataDir: path.join(home, "supervisor"),
sessionsDir, workspaces: [{ id: "cli", root: workspace }],
options: { recovery: { retryBaseMs: 10, retryMaxMs: 15 } },
execute: async ({ session: running, instruction, files }) => {
calls++;
seen.push({ instruction, files });
if (calls === 1) {
await running.update({
runCount: 2,
phase: "interrupted",
conversationTargetId: "target-known",
pendingAssistantTurn: {
version: 1, handoffId: "outbound:123", sourceOutboundId: "123",
outboundKind: "follow_up", status: "waiting",
conversationTargetId: "target-known",
},
});
throw Object.assign(new Error("worker died"), { code: "WORKER_EXITED" });
}
await running.update({ phase: "idle", pendingAssistantTurn: null, lastMessage: "reconciled" });
return { message: "reconciled" };
},
});
await supervisor.init();
t.after(() => supervisor.close());
const record = await supervisor.enqueueSessionTurn({
workspaceId: "cli", sessionId: session.sessionId,
instruction: "new follow up", files: [{ name: "x", path: path.join(home, "x") }],
});
const result = await waitFor(() => {
const item = supervisor.get(record.taskId);
return ["completed", "blocked_uncertain", "failed"].includes(item.status) && item;
});
assert.equal(result.status, "completed");
assert.equal(result.attempts, 2);
assert.equal(calls, 2);
assert.equal(seen[0].instruction, "new follow up");
assert.equal(seen[1].instruction, null);
assert.deepEqual(seen[1].files, []);
});

test("Ambiguous follow-up without checkpoint blocks after one attempt", async (t) => {
const { home, workspace, sessionsDir, session } = await fixture(t);
await session.update({ runCount: 1, phase: "idle", lastMessage: "old completion" });
let calls = 0;
const supervisor = new TaskSupervisor({
dataDir: path.join(home, "supervisor"), sessionsDir,
workspaces: [{ id: "cli", root: workspace }],
execute: async ({ session: running }) => {
calls++;
await running.update({ runCount: 2, phase: "interrupted" });
throw Object.assign(new Error("uncertain"), { code: "WORKER_EXITED" });
},
});
await supervisor.init();
t.after(() => supervisor.close());
const created = await supervisor.enqueueSessionTurn({
workspaceId: "cli", sessionId: session.sessionId, instruction: "dangerous follow up",
});
const blocked = await waitFor(() => {
const value = supervisor.get(created.taskId);
return value.status === "blocked_uncertain" && value;
});
assert.equal(calls, 1);
assert.equal(blocked.error, "NO_SAFE_RECOVERY_CHECKPOINT");
await assert.rejects(() => supervisor.resume(created.taskId), { code: "CONFLICT" });
});

test("Actual CLI default spawns Worker subprocess and records task, without a usable browser", {
skip: process.platform !== "win32" ? "Native WTAgent CLI requires Windows." : false,
timeout: 30000,
}, async (t) => {
const { home, workspace, sessionsDir } = await fixture(t);
const entry = path.join(repo, "src", "cli", "main.js");
const nonexistentChrome = path.join(home, "nonexistent", "chrome.exe");
let stdout = "";
let stderr = "";
try {
const result = await execFileAsync(process.execPath, [
entry, "--home", home, "--chrome-path", nonexistentChrome,
"--once", "-C", workspace, "test supervisor worker path",
], { timeout: 20000 });
stdout = result.stdout;
stderr = result.stderr;
} catch (error) {
stdout = error.stdout ?? "";
stderr = error.stderr ?? "";
}
const sessions = await AgentSession.list({ sessionsDir });
const match = stdout.match(/\[Supervisor\] Session (session_[A-Za-z0-9_]+); isolated Worker execution/);
 assert.ok(match, `Expected CLI Supervisor session; stdout=${stdout}; stderr=${stderr}`);
 const id = match[1];
 assert.ok(sessions.some((item) => item.sessionId === id), "CLI-created session must persist");
const records = (await fs.readdir(path.join(sessionsDir, id, "supervisor")))
.filter((name) => /^task_.*\.json$/.test(name));
assert.equal(records.length, 1, "Default CLI must create a Supervisor task record");
const task = JSON.parse(await fs.readFile(
path.join(sessionsDir, id, "supervisor", records[0]), "utf8",
));
assert.equal(task.sessionId, id);
assert.ok(Number.isSafeInteger(task.workerPid) && task.workerPid > 0,
"Supervisor must fork a real Worker and record its PID");
assert.match(stdout, /\[Supervisor\].*Worker/i);
assert.notEqual(task.status, "completed", "A nonexistent browser cannot pass a genuine run");
});

test("Explicit --legacy flag remains available on the CLI", async () => {
const entry = path.join(repo, "src", "cli", "main.js");
const { stdout } = await execFileAsync(process.execPath, [entry, "--help"]);
assert.match(stdout, /--legacy/);
});
